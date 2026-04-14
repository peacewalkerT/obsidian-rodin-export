import { Plugin, Notice, TFile, requestUrl } from 'obsidian';

const RODIN_API = 'https://rodin.fyi/api/import';
const MAX_CHARS = 200_000; // ~200k chars max to send

export default class RodinExportPlugin extends Plugin {
  async onload() {
    // Add ribbon icon
    this.addRibbonIcon('fingerprint', 'Export to Rodin', async () => {
      await this.exportToRodin();
    });

    // Add command
    this.addCommand({
      id: 'export-to-rodin',
      name: 'Export vault to Rodin',
      callback: async () => {
        await this.exportToRodin();
      },
    });
  }

  async exportToRodin() {
    const notice = new Notice('Collecting vault content...');

    try {
      // Get all markdown files
      const files: TFile[] = this.app.vault.getMarkdownFiles();

      if (files.length === 0) {
        new Notice('No markdown files found in vault.');
        return;
      }

      // Read all files, sorted by modification time (most recent first)
      const sorted = files.sort((a, b) => b.stat.mtime - a.stat.mtime);

      let text = '';
      let fileCount = 0;

      for (const file of sorted) {
        if (text.length >= MAX_CHARS) break;

        const content = await this.app.vault.cachedRead(file);
        if (content.trim()) {
          text += `\n\n--- ${file.path} ---\n\n${content}`;
          fileCount++;
        }
      }

      text = text.trim();

      if (text.length < 100) {
        new Notice('Not enough text content in vault (need at least 100 characters).');
        return;
      }

      notice.setMessage(`Sending ${fileCount} files to Rodin...`);

      // POST to Rodin API
      const response = await requestUrl({
        url: RODIN_API,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          text,
          source: 'obsidian-plugin',
        }),
      });

      if (response.status !== 200) {
        const error = response.json?.error ?? 'Unknown error';
        new Notice(`Rodin export failed: ${error}`);
        return;
      }

      const { url } = response.json;

      // Open Rodin in browser
      window.open(url);
      new Notice(`Exported ${fileCount} files to Rodin!`);

    } catch (err) {
      console.error('Rodin export error:', err);
      new Notice('Failed to export to Rodin. Check your internet connection.');
    }
  }
}
