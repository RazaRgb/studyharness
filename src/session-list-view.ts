import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type StudyHarnessPlugin from "./main";
import type { Session } from "./types";
import { intentLabel } from "./types";

export const VIEW_TYPE_SESSIONS = "study-harness-sessions";

type Filter = "all" | "study" | "practice" | "pending" | "empty";

export class SessionListView extends ItemView {
  private readonly plugin: StudyHarnessPlugin;
  private listEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private filterEl!: HTMLSelectElement;
  private query = "";
  private filter: Filter = "all";
  private lastKey = "";

  constructor(leaf: WorkspaceLeaf, plugin: StudyHarnessPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_SESSIONS; }
  getDisplayText(): string { return "Study sessions"; }
  getIcon(): string { return "list"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("sh-session-list-view");
    this.build();
    this.refresh();
  }

  refresh(): void {
    if (!this.listEl) return;
    const key = this.plugin.store
      .listSessions()
      .map((s) => `${s.id}:${s.title}:${s.messages.length}:${s.status}:${s.phase}:${s.updatedAt}:${s.pendingQuestion?.toolCallId ?? ""}:${s.graphExtraction?.status ?? ""}`)
      .join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.renderList();
  }

  private build(): void {
    const header = this.contentEl.createDiv({ cls: "sh-list-header" });
    const titleRow = header.createDiv({ cls: "sh-list-title-row" });
    titleRow.createDiv({ cls: "sh-list-title", text: "Sessions" });
    const actions = titleRow.createDiv({ cls: "sh-list-actions" });
    const add = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "New session" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => {
      this.plugin.activeSessionId = null;
      void this.plugin.openSessionView();
    });
    const refresh = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Refresh sessions" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.refresh());

    this.searchEl = header.createEl("input", {
      cls: "sh-list-search",
      attr: { type: "search", placeholder: "Search sessions…", "aria-label": "Search sessions" },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.renderList();
    });

    const filterRow = header.createDiv({ cls: "sh-list-filter-row" });
    this.filterEl = filterRow.createEl("select", { cls: "dropdown sh-list-filter" });
    for (const [value, label] of [
      ["all", "All sessions"],
      ["study", "Study"],
      ["practice", "Practice"],
      ["pending", "Waiting for answer"],
      ["empty", "Empty"],
    ] as Array<[Filter, string]>) {
      const option = this.filterEl.createEl("option", { text: label });
      option.value = value;
    }
    this.filterEl.addEventListener("change", () => {
      this.filter = this.filterEl.value as Filter;
      this.renderList();
    });
    const clean = filterRow.createEl("button", { cls: "sh-list-clean", text: "Delete empty", attr: { type: "button" } });
    clean.addEventListener("click", () => void this.plugin.confirmDeleteEmptySessions());

    this.listEl = this.contentEl.createDiv({ cls: "sh-session-list" });
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const q = this.query;
    let sessions = this.plugin.store.listSessions().filter((s) => {
      if (q && !s.title.toLowerCase().includes(q) && !s.topic.toLowerCase().includes(q)) return false;
      if (this.filter === "study" && s.mode !== "study") return false;
      if (this.filter === "practice" && s.mode !== "practice") return false;
      if (this.filter === "pending" && !s.pendingQuestion) return false;
      if (this.filter === "empty" && s.messages.length > 0) return false;
      return true;
    });
    if (sessions.length === 0) {
      const empty = this.listEl.createDiv({ cls: "sh-list-empty" });
      empty.createDiv({ cls: "sh-list-empty-title", text: q || this.filter !== "all" ? "No matching sessions" : "No sessions yet" });
      empty.createDiv({ cls: "sh-list-empty-text", text: q || this.filter !== "all" ? "Try a different search or filter." : "Start a session from the plus button." });
      return;
    }
    let lastDate = "";
    for (const session of sessions) {
      const date = new Date(session.updatedAt).toLocaleDateString();
      if (date !== lastDate) {
        lastDate = date;
        this.listEl.createDiv({ cls: "sh-list-date", text: date });
      }
      this.renderRow(session);
    }
  }

  private renderRow(session: Session): void {
    const row = this.listEl.createDiv({ cls: "sh-session-row" });
    if (session.id === this.plugin.activeSessionId) row.addClass("is-active");
    if (session.pendingQuestion) row.addClass("is-pending");
    if (session.messages.length === 0) row.addClass("is-empty");

    const main = row.createDiv({ cls: "sh-session-row-main" });
    const titleRow = main.createDiv({ cls: "sh-session-row-title-row" });
    titleRow.createDiv({ cls: "sh-session-row-title", text: session.title });
    if (session.pendingQuestion) {
      const pending = titleRow.createSpan({ cls: "sh-session-row-pending", text: "answer" });
      void pending;
    }
    if (session.graphExtraction?.status === "running") {
      titleRow.createSpan({ cls: "sh-session-row-extracting", text: "graph" });
    }
    const meta = main.createDiv({ cls: "sh-session-row-meta" });
    meta.createSpan({ cls: "sh-session-row-intent", text: intentLabel(session.intent) });
    meta.createSpan({ text: `· ${session.mode} · ${session.phase}` });
    meta.createSpan({ cls: "sh-session-row-count", text: `· ${session.messages.length} msgs` });
    if (session.messages.length === 0) meta.createSpan({ cls: "sh-session-row-empty", text: "· empty" });

    const actions = row.createDiv({ cls: "sh-session-row-actions" });
    const rename = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Rename session" } });
    setIcon(rename, "pencil");
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      this.plugin.openRenameSession(session.id);
    });
    const del = actions.createEl("button", { cls: "clickable-icon sh-delete-icon", attr: { type: "button", "aria-label": "Delete session" } });
    setIcon(del, "trash-2");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.plugin.confirmDeleteSession(session.id);
    });

    main.addEventListener("click", () => void this.plugin.openSession(session.id));
  }
}
