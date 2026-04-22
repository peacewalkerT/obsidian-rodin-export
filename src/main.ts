import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';

const RODIN_BASE = 'https://rodin.fyi';
const RODIN_IMPORT_API = `${RODIN_BASE}/api/import`;
const MAX_CHARS = 200_000;
const MIN_CHARS = 100;

type VaultScan = {
  filesToSend: TFile[];
  charsToSend: number;
  totalFiles: number;
  totalChars: number;
  truncated: boolean;
};

interface RodinSettings {
  profileId?: string;
  token?: string;
  profileName?: string;
}

const DEFAULT_SETTINGS: RodinSettings = {};

// Connection codes are base64url(`${id}:${token}`). Both halves of the pair
// are already user-visible in the manage URL (rodin.fyi/p/[id]/manage?token=…)
// — the code format just makes a single string the user can copy-paste into
// the plugin without having to fish two values out of a URL.
function encodeConnectionCode(id: string, token: string): string {
  const raw = `${id}:${token}`;
  const b64 = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConnectionCode(code: string): { id: string; token: string } | null {
  const cleaned = code.trim().replace(/\s+/g, '');
  if (!cleaned) return null;
  const b64 = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const raw = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx <= 0 || idx === raw.length - 1) return null;
    const id = raw.slice(0, idx);
    const token = raw.slice(idx + 1);
    if (!/^[A-Za-z0-9_-]{6,24}$/.test(id) || token.length < 16) return null;
    return { id, token };
  } catch {
    return null;
  }
}

export default class RodinExportPlugin extends Plugin {
  settings: RodinSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();

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

    this.addSettingTab(new RodinSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isConnected(): boolean {
    return Boolean(this.settings.profileId && this.settings.token);
  }

  async disconnect() {
    this.settings = { ...DEFAULT_SETTINGS };
    await this.saveSettings();
  }

  // Exchanges a connection code for a verified profile. We call the manage
  // endpoint because it's the authoritative token check — if it returns 200
  // we know the token is valid right now, and we get the profile name for
  // free to show in the settings UI and confirmation modal.
  async verifyAndConnect(code: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const decoded = decodeConnectionCode(code);
    if (!decoded) {
      return { ok: false, error: 'That doesn\'t look like a valid connection code.' };
    }

    try {
      const response = await requestUrl({
        url: `${RODIN_BASE}/api/profile/${decoded.id}/manage?token=${encodeURIComponent(decoded.token)}`,
        method: 'GET',
        throw: false,
      });

      if (response.status === 401) {
        return { ok: false, error: 'Connection code is invalid or has expired.' };
      }
      if (response.status !== 200) {
        return { ok: false, error: `Rodin returned ${response.status}.` };
      }

      const profile = response.json as { id: string; name?: string };
      this.settings = {
        profileId: decoded.id,
        token: decoded.token,
        profileName: profile.name ?? 'your profile',
      };
      await this.saveSettings();
      return { ok: true, name: this.settings.profileName ?? 'your profile' };
    } catch (err) {
      console.error('Rodin connection error:', err);
      return { ok: false, error: 'Could not reach Rodin. Check your internet connection.' };
    }
  }

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

    const mode = this.isConnected() ? 'evolve' : 'create';
    new ConfirmExportModal(this.app, scan, mode, this.settings.profileName, () => this.performExport(scan)).open();
  }

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

      if (this.isConnected()) {
        await this.sendEvolve(text, sentFiles, notice);
      } else {
        await this.sendImport(text, sentFiles, notice);
      }
    } catch (err) {
      notice.hide();
      console.error('Rodin export error:', err);
      new Notice('Failed to export to Rodin. Check your internet connection.');
    }
  }

  async sendImport(text: string, sentFiles: number, notice: Notice) {
    notice.setMessage(`Sending ${sentFiles} files to Rodin…`);

    const response = await requestUrl({
      url: RODIN_IMPORT_API,
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
  }

  async sendEvolve(text: string, sentFiles: number, notice: Notice) {
    const { profileId, token, profileName } = this.settings;
    if (!profileId || !token) {
      notice.hide();
      new Notice('Not connected. Paste a connection code in plugin settings.');
      return;
    }

    notice.setMessage(`Evolving ${profileName ?? 'your'} fingerprint…`);

    const response = await requestUrl({
      url: `${RODIN_BASE}/api/profile/${profileId}/evolve`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ text, token }),
      throw: false,
    });

    notice.hide();

    if (response.status === 401) {
      new Notice('Connection expired. Reconnect in plugin settings.');
      return;
    }

    if (response.status === 429) {
      new Notice('Rodin rate limit reached. Try again in 15 minutes.');
      return;
    }

    if (response.status !== 200) {
      const error = (response.json as { error?: string } | undefined)?.error ?? `Rodin returned ${response.status}`;
      new Notice(`Evolution failed: ${error}`);
      return;
    }

    window.open(`${RODIN_BASE}/p/${profileId}`);
    new Notice(`Evolved fingerprint from ${sentFiles} files. Opening in your browser…`);
  }
}

class ConfirmExportModal extends Modal {
  constructor(
    app: App,
    private scan: VaultScan,
    private mode: 'create' | 'evolve',
    private profileName: string | undefined,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, scan, mode } = this;
    contentEl.empty();

    const heading = mode === 'evolve'
      ? `Evolve ${this.profileName ?? 'your'} fingerprint`
      : 'Export to Rodin';
    contentEl.createEl('h2', { text: heading });

    const sendK = Math.round(scan.charsToSend / 1000);
    const intro = mode === 'evolve'
      ? `About to send ${scan.filesToSend.length} files (~${sendK}k characters) to merge into your existing fingerprint.`
      : `About to send ${scan.filesToSend.length} files (~${sendK}k characters) to rodin.fyi.`;
    contentEl.createEl('p', { text: intro });

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
      mode === 'evolve'
        ? 'New themes, questions, and models will be merged with your existing fingerprint. ' +
          'The submitted text is used once, then removed; only the derived fingerprint persists.'
        : 'Rodin reads your writing to extract an intellectual fingerprint — themes, mental models, core question, blind spots. ' +
          'Your text is used once, then removed; only the derived fingerprint persists.',
    );

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.style.display = 'flex';
    buttons.style.gap = '0.5em';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.marginTop = '1em';

    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const confirmLabel = mode === 'evolve' ? 'Evolve fingerprint' : 'Send to Rodin';
    const confirm = buttons.createEl('button', { text: confirmLabel, cls: 'mod-cta' });
    confirm.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class RodinSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: RodinExportPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Rodin Export' });

    if (this.plugin.isConnected()) {
      this.renderConnected(containerEl);
    } else {
      this.renderDisconnected(containerEl);
    }
  }

  private renderConnected(containerEl: HTMLElement) {
    const { profileId, profileName } = this.plugin.settings;

    const status = containerEl.createEl('p');
    status.setText(`Connected to ${profileName ?? profileId}. Exports will evolve this fingerprint instead of creating a new one.`);

    const link = containerEl.createEl('p');
    const a = link.createEl('a', {
      text: `View profile at rodin.fyi/p/${profileId}`,
      href: `${RODIN_BASE}/p/${profileId}`,
    });
    a.setAttr('target', '_blank');
    a.setAttr('rel', 'noopener');

    new Setting(containerEl)
      .setName('Disconnect')
      .setDesc('Stop evolving this profile. Future exports will create new fingerprints.')
      .addButton((btn) => {
        btn.setButtonText('Disconnect').setWarning().onClick(async () => {
          await this.plugin.disconnect();
          new Notice('Disconnected from Rodin profile.');
          this.display();
        });
      });
  }

  private renderDisconnected(containerEl: HTMLElement) {
    const intro = containerEl.createEl('p');
    intro.setText(
      'Connect the plugin to an existing Rodin profile to evolve it with new writing — merging fresh themes, ' +
      'questions, and models into your existing fingerprint instead of creating a new one each time.',
    );

    const how = containerEl.createEl('p');
    how.style.color = 'var(--text-muted)';
    how.style.fontSize = '0.9em';
    how.setText('Get your connection code at rodin.fyi/p/[your-id]/manage.');

    let codeInput = '';
    new Setting(containerEl)
      .setName('Connection code')
      .setDesc('Paste the code from your profile\'s manage page.')
      .addText((text) => {
        text.setPlaceholder('e.g. YWJjMTIzOnh4eHg…');
        text.onChange((value) => { codeInput = value; });
      })
      .addButton((btn) => {
        btn.setButtonText('Connect').setCta().onClick(async () => {
          if (!codeInput.trim()) {
            new Notice('Paste a connection code first.');
            return;
          }
          btn.setDisabled(true);
          const result = await this.plugin.verifyAndConnect(codeInput);
          btn.setDisabled(false);
          if (result.ok) {
            new Notice(`Connected to ${result.name}.`);
            this.display();
          } else {
            new Notice(result.error);
          }
        });
      });
  }
}
