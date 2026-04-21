import { App, Modal, Notice, Plugin, TFile, requestUrl } from 'obsidian';

const RODIN_API = 'https://rodin.fyi/api/import';
const MAX_CHARS = 200_000;
const MIN_CHARS = 100;

type VaultScan = {
  filesToSend: TFile[];
  charsToSend: number;
  totalFiles: number;
  totalChars: number;
  truncated: boolean;
};

export default class RodinExportPlugin extends Plugin {
  async onload() {
    this.addRibbonIcon('fingerprint', 'Export to Rodin', () => {
      this.startExport();
    });

    this.addCommand({
      id: 'export-to-rodin',
      name: 'Export vault to Rodin',
      callback: () => {
        this.startExport();
      },
    });
  }

  // Two-phase export. Phase one scans the vault for files and estimates
  // byte counts from TFile.stat.size without reading contents — fast even
  // on large vaults. Phase two (on user confirm) does the actual reads,
  // respects the 200k cap, and POSTs to Rodin.
  async startExport() {
    const scan = await this.scanVault();

    if (scan.totalFiles === 0) {
      new Notice('No markdown files found in vault.');
      return;
    }

    if (scan.charsToSend < MIN_CHARS) {
      new Notice(`Not enough text in vault — need at least ${MIN_CHARS} characters, found ~${scan.charsToSend}.`);
      return;
    }

    new ConfirmExportModal(this.app, scan, () => this.performExport(scan)).open();
  }

  // file.stat.size is bytes on disk; for UTF-8 markdown it's a close-enough
  // proxy for character count. We overestimate slightly, which is the safe
  // direction — it means we stop reading before actually hitting 200k rather
  // than after.
  async scanVault(): Promise<VaultScan> {
    const files = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    let charsToSend = 0;
    let totalChars = 0;
    const filesToSend: TFile[] = [];
    let capReached = false;

    for (const file of files) {
      totalChars += file.stat.size;
      if (capReached) continue;
      if (charsToSend + file.stat.size > MAX_CHARS) {
        capReached = true;
        continue;
      }
      charsToSend += file.stat.size;
      filesToSend.push(file);
    }

    return {
      filesToSend,
      charsToSend,
      totalFiles: files.length,
      totalChars,
      truncated: capReached,
    };
  }

  async performExport(scan: VaultScan) {
    const notice = new Notice(`Reading ${scan.filesToSend.length} files…`, 0);
    let text = '';
    let sentFiles = 0;

    try {
      for (const file of scan.filesToSend) {
        if (text.length >= MAX_CHARS) break;
        const content = await this.app.vault.cachedRead(file);
        if (!content.trim()) continue;
        text += `\n\n--- ${file.path} ---\n\n${content}`;
        sentFiles++;
      }

      text = text.trim();

      if (text.length < MIN_CHARS) {
        notice.hide();
        new Notice(`Not enough text content in vault (need at least ${MIN_CHARS} characters).`);
        return;
      }

      notice.setMessage(`Sending ${sentFiles} files to Rodin…`);

      const response = await requestUrl({
        url: RODIN_API,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ text, source: 'obsidian-plugin' }),
        throw: false,
      });

      notice.hide();

      if (response.status === 429) {
        new Notice('Rodin rate limit reached. Please try again in an hour.');
        return;
      }

      if (response.status !== 200) {
        const error = (response.json as { error?: string } | undefined)?.error ?? `Rodin returned ${response.status}`;
        new Notice(`Rodin export failed: ${error}`);
        return;
      }

      const { url } = response.json as { url: string };
      window.open(url);
      new Notice(`Sent ${sentFiles} files to Rodin. Opening in your browser…`);
    } catch (err) {
      notice.hide();
      console.error('Rodin export error:', err);
      new Notice('Failed to export to Rodin. Check your internet connection.');
    }
  }
}

class ConfirmExportModal extends Modal {
  constructor(
    app: App,
    private scan: VaultScan,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, scan } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Export to Rodin' });

    const sendK = Math.round(scan.charsToSend / 1000);
    contentEl.createEl('p', {
      text: `About to send ${scan.filesToSend.length} files (~${sendK}k characters) to rodin.fyi.`,
    });

    if (scan.truncated) {
      const totalK = Math.round(scan.totalChars / 1000);
      const skipped = scan.totalFiles - scan.filesToSend.length;
      const warn = contentEl.createEl('p');
      warn.style.color = 'var(--text-warning)';
      warn.setText(
        `Your vault has ${scan.totalFiles} files (~${totalK}k characters). ` +
        `The most recently edited ${scan.filesToSend.length} will be sent; ${skipped} older files won't.`,
      );
    }

    const privacy = contentEl.createEl('p');
    privacy.style.color = 'var(--text-muted)';
    privacy.style.fontSize = '0.9em';
    privacy.setText(
      'Rodin reads your writing to extract an intellectual fingerprint — themes, mental models, core question, blind spots. ' +
      'Your text is used once, then removed; only the derived fingerprint persists.',
    );

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.style.display = 'flex';
    buttons.style.gap = '0.5em';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.marginTop = '1em';

    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const confirm = buttons.createEl('button', { text: 'Send to Rodin', cls: 'mod-cta' });
    confirm.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
