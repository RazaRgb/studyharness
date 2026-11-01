import { App, Modal, Notice, type TFile } from "obsidian";
import type StudyHarnessPlugin from "./main";

export class NotesImportModal extends Modal {
  private readonly plugin: StudyHarnessPlugin;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private domainEl!: HTMLInputElement;
  private selected = new Set<string>();
  private query = "";
  private files: TFile[] = [];

  constructor(app: App, plugin: StudyHarnessPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass("sh-notes-modal");
    this.titleEl.setText("Import notes into the knowledge graph");
    this.contentEl.empty();
    const intro = this.contentEl.createEl("p", {
      cls: "sh-muted",
      text: "Choose Markdown notes. The model will extract propositions and prerequisite links into the knowledge bank. Nothing is written back to your notes.",
    });
    void intro;

    const searchRow = this.contentEl.createDiv({ cls: "sh-notes-search-row" });
    this.searchEl = searchRow.createEl("input", {
      cls: "sh-list-search",
      attr: { type: "search", placeholder: "Search notes…", "aria-label": "Search notes" },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.renderList();
    });
    const selectAll = searchRow.createEl("button", { text: "Select all visible", attr: { type: "button" } });
    selectAll.addEventListener("click", () => {
      for (const file of this.visibleFiles()) this.selected.add(file.path);
      this.renderList();
    });
    const clear = searchRow.createEl("button", { text: "Clear", attr: { type: "button" } });
    clear.addEventListener("click", () => {
      this.selected.clear();
      this.renderList();
    });

    this.listEl = this.contentEl.createDiv({ cls: "sh-notes-list" });
    this.files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !f.path.startsWith("StudyHarness/") && !f.path.startsWith(".trash/"))
      .sort((a, b) => a.path.localeCompare(b.path));

    const domainRow = this.contentEl.createDiv({ cls: "sh-notes-domain-row" });
    domainRow.createSpan({ text: "Domain" });
    this.domainEl = domainRow.createEl("input", {
      cls: "sh-notes-domain",
      attr: { type: "text", value: "Imported notes", "aria-label": "Knowledge domain" },
    });

    const footer = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = footer.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const importBtn = footer.createEl("button", { cls: "mod-cta", text: "Import selected", attr: { type: "button" } });
    importBtn.addEventListener("click", () => {
      if (this.selected.size === 0) {
        new Notice("Select at least one note.");
        return;
      }
      const paths = [...this.selected];
      const domain = this.domainEl.value.trim() || "Imported notes";
      this.close();
      void this.plugin.importNotes(paths, domain);
    });

    this.renderList();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private visibleFiles(): TFile[] {
    const q = this.query;
    return this.files.filter((f) => !q || f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q));
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const files = this.visibleFiles();
    const summary = this.listEl.createDiv({ cls: "sh-notes-summary" });
    summary.setText(`${files.length} notes shown · ${this.selected.size} selected`);
    if (files.length === 0) {
      this.listEl.createDiv({ cls: "sh-list-empty-text", text: "No matching Markdown notes." });
      return;
    }
    for (const file of files.slice(0, 500)) {
      const row = this.listEl.createEl("label", { cls: "sh-note-row" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selected.has(file.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(file.path);
        else this.selected.delete(file.path);
        summary.setText(`${files.length} notes shown · ${this.selected.size} selected`);
      });
      const text = row.createDiv({ cls: "sh-note-row-text" });
      text.createDiv({ cls: "sh-note-row-title", text: file.basename });
      text.createDiv({ cls: "sh-note-row-path", text: file.path });
    }
    if (files.length > 500) {
      this.listEl.createDiv({ cls: "sh-list-empty-text", text: "Showing the first 500 matches. Narrow the search to select more." });
    }
  }
}
