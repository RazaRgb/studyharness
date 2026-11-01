import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  TFile,
  normalizePath,
} from "obsidian";
import { HarnessEngine, type EngineHost } from "./engine";
import { GraphView, VIEW_TYPE_GRAPH } from "./graph-view";
import { SessionView, VIEW_TYPE_SESSION } from "./session-view";
import { SessionListView, VIEW_TYPE_SESSIONS } from "./session-list-view";
import { NotesImportModal } from "./notes-import";
import { ConfirmModal, RenameSessionModal } from "./modals";
import { HarnessStore } from "./store";
import {
  DEFAULT_SETTINGS,
  type Intent,
  type PluginData,
  type Session,
  type SessionMode,
  type Settings,
  intentLabel,
} from "./types";

export default class StudyHarnessPlugin extends Plugin implements EngineHost {
  store!: HarnessStore;
  engine!: HarnessEngine;
  activeSessionId: string | null = null;
  private saveTimer: number | null = null;
  private lastGraphRevision = -1;

  get config(): Settings {
    return this.store.data.settings;
  }

  async onload(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginData> | null;
    this.store = new HarnessStore(raw as PluginData | null, () => this.scheduleSave());
    this.engine = new HarnessEngine(this);

    this.registerView(VIEW_TYPE_SESSION, (leaf: WorkspaceLeaf) => new SessionView(leaf, this));
    this.registerView(VIEW_TYPE_GRAPH, (leaf: WorkspaceLeaf) => new GraphView(leaf, this));
    this.registerView(VIEW_TYPE_SESSIONS, (leaf: WorkspaceLeaf) => new SessionListView(leaf, this));

    this.addRibbonIcon("graduation-cap", "Study Harness", () => void this.openSessionView());
    this.addRibbonIcon("list", "Study sessions", () => void this.openSessionsPanel());
    this.addCommand({ id: "open-study-session", name: "Open study workspace", callback: () => void this.openSessionView() });
    this.addCommand({ id: "open-knowledge-graph", name: "Open knowledge graph", callback: () => void this.openGraph() });
    this.addCommand({
      id: "new-study-session",
      name: "New study session",
      callback: () => {
        this.activeSessionId = null;
        void this.openSessionView();
      },
    });
    this.addCommand({
      id: "open-sessions-panel",
      name: "Open sessions panel",
      callback: () => void this.openSessionsPanel(),
    });
    this.addCommand({
      id: "import-notes",
      name: "Import notes into knowledge graph",
      callback: () => this.openNotesImport(),
    });
    this.addCommand({
      id: "extract-session-graph",
      name: "Extract knowledge graph from current session",
      checkCallback: (checking) => {
        const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
        if (!session) return false;
        if (!checking) void this.extractCurrentSession();
        return true;
      },
    });
    this.addCommand({
      id: "delete-empty-sessions",
      name: "Delete empty sessions",
      callback: () => void this.confirmDeleteEmptySessions(),
    });
    this.addCommand({
      id: "generate-flashcards",
      name: "Generate flashcards for current session",
      checkCallback: (checking) => {
        const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
        if (!session) return false;
        if (!checking) void this.generateFlashcards(session.id);
        return true;
      },
    });
    this.addCommand({
      id: "open-settings",
      name: "Open Study Harness settings",
      callback: () => this.openSettings(),
    });
    this.addCommand({
      id: "reload-study-harness",
      name: "Reload Study Harness (dev)",
      callback: async () => {
        const plugins = (this.app as unknown as {
          plugins?: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> };
        }).plugins;
        if (!plugins) return;
        await plugins.disablePlugin(this.manifest.id);
        await plugins.enablePlugin(this.manifest.id);
      },
    });

    this.addSettingTab(new StudyHarnessSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.lastGraphRevision = this.store.graphRevision;
    });
  }

  onunload(): void {
    this.engine?.stopAll();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveData(this.store.data);
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SESSION);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GRAPH);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SESSIONS);
  }

  getSettings(): Settings {
    return this.config;
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.store.data);
    }, 250);
  }

  notify(): void {
    const sessionView = this.getSessionView();
    if (sessionView) void sessionView.refresh();
    const sessionList = this.getSessionListView();
    if (sessionList) sessionList.refresh();
    if (this.store.graphRevision !== this.lastGraphRevision) {
      this.lastGraphRevision = this.store.graphRevision;
      const graphView = this.getGraphView();
      if (graphView) graphView.refresh();
    }
  }

  onStreamEnd(): void {
    this.notify();
  }

  private getSessionView(): SessionView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)[0];
    const view = leaf?.view;
    return view instanceof SessionView ? view : null;
  }

  private getGraphView(): GraphView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH)[0];
    const view = leaf?.view;
    return view instanceof GraphView ? view : null;
  }

  private getSessionListView(): SessionListView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS)[0];
    const view = leaf?.view;
    return view instanceof SessionListView ? view : null;
  }

  async activateView(type: string): Promise<WorkspaceLeaf | null> {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = this.app.workspace.getLeaf("tab");
    if (!leaf) return null;
    await leaf.setViewState({ type, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openSessionView(): Promise<void> {
    const leaf = await this.activateView(VIEW_TYPE_SESSION);
    if (!leaf) return;
    const view = leaf.view;
    if (view instanceof SessionView) await view.refresh();
  }

  async openSession(id: string): Promise<void> {
    const session = this.store.getSession(id);
    if (!session) {
      new Notice("Session not found.");
      return;
    }
    this.activeSessionId = id;
    await this.openSessionView();
    this.notify();
  }

  async createAndStartSession(topic: string, intent: Intent, mode: SessionMode, focusNodeId?: string): Promise<void> {
    const session = this.store.createSession({ topic, intent, mode, focusNodeId });
    this.activeSessionId = session.id;
    await this.openSessionView();
    this.notify();
    void this.engine.startSession(session.id);
  }

  async startSessionForNode(nodeId: string, intent: Intent, mode: SessionMode): Promise<void> {
    const node = this.store.data.nodes[nodeId];
    if (!node) return;
    await this.createAndStartSession(node.name, intent, mode, nodeId);
  }

  async openSessionsPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      const view = existing[0].view;
      if (view instanceof SessionListView) view.refresh();
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(true);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_SESSIONS, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  openRenameSession(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    new RenameSessionModal(this.app, session.title, (value) => {
      this.store.renameSession(sessionId, value);
      this.notify();
    }).open();
  }

  async confirmDeleteSession(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (this.engine.isRunning(sessionId)) {
      new Notice("Stop the session before deleting it.");
      return;
    }
    new ConfirmModal(this.app, {
      title: "Delete session",
      message: `Delete "${session.title}"? The session record will be removed. Graph evidence already recorded is kept.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        this.store.deleteSession(sessionId);
        if (this.activeSessionId === sessionId) this.activeSessionId = null;
        this.notify();
        new Notice("Session deleted.");
      },
    }).open();
  }

  async confirmDeleteEmptySessions(): Promise<void> {
    const empty = this.store.emptySessions();
    if (empty.length === 0) {
      new Notice("No empty sessions to delete.");
      return;
    }
    new ConfirmModal(this.app, {
      title: "Delete empty sessions",
      message: `Delete ${empty.length} empty session${empty.length === 1 ? "" : "s"}?`,
      confirmLabel: "Delete empty",
      danger: true,
      onConfirm: () => {
        for (const session of empty) {
          this.store.deleteSession(session.id);
          if (this.activeSessionId === session.id) this.activeSessionId = null;
        }
        this.notify();
        new Notice(`Deleted ${empty.length} empty session${empty.length === 1 ? "" : "s"}.`);
      },
    }).open();
  }

  openNotesImport(): void {
    new NotesImportModal(this.app, this).open();
  }

  async importNotes(paths: string[], domain: string): Promise<void> {
    const notes: Array<{ path: string; text: string }> = [];
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        notes.push({ path, text: await this.app.vault.cachedRead(file) });
      } catch (err) {
        new Notice(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (notes.length === 0) {
      new Notice("No readable notes selected.");
      return;
    }
    const progress = new Notice(`Importing 0/${notes.length} notes…`, 0);
    try {
      const results = await this.engine.importNotes(notes, domain, (message) => {
        progress.setMessage(message);
      });
      progress.hide();
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      const nodes = results.reduce((sum, r) => sum + (r.ok ? r.nodes : 0), 0);
      const links = results.reduce((sum, r) => sum + (r.ok ? r.links : 0), 0);
      new Notice(`Notes import finished: ${ok} ok, ${failed} failed · ${nodes} nodes, ${links} links`);
      this.notify();
    } catch (err) {
      progress.hide();
      new Notice(`Notes import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async extractCurrentSession(): Promise<void> {
    const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
    if (!session) {
      new Notice("Open a session first.");
      return;
    }
    if (session.graphExtraction?.status === "running") {
      new Notice("Graph extraction is already running for this session.");
      return;
    }
    new Notice("Extracting knowledge graph…");
    try {
      const result = await this.engine.extractSessionGraph(session.id, true);
      new Notice(`Graph extraction finished: ${result.nodes} nodes, ${result.links} links.`);
      this.notify();
    } catch (err) {
      new Notice(`Graph extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stopSession(sessionId: string): void {
    this.engine.stop(sessionId);
  }

  async openGraph(nodeId?: string): Promise<void> {
    const leaf = await this.activateView(VIEW_TYPE_GRAPH);
    const view = leaf?.view;
    if (view instanceof GraphView) {
      view.refresh();
      if (nodeId) view.selectNode(nodeId);
      await this.app.workspace.revealLeaf(leaf!);
    }
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
    }
  }

  async generateFlashcards(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    new Notice("Generating flashcards…");
    try {
      const path = await this.engine.generateFlashcards(sessionId);
      new Notice(`Flashcards written to ${path}`);
      this.notify();
    } catch (err) {
      new Notice(`Flashcards failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async writeFlashcardDeck(input: {
    session: Session;
    title: string;
    cards: Array<{ front: string; back: string }>;
    sourceNodeIds?: string[];
  }): Promise<string> {
    const folder = "StudyHarness/Flashcards";
    await this.ensureFolder(folder);
    const base = this.safeName(input.title || `${input.session.topic} — key facts`);
    let path = normalizePath(`${folder}/${base}.md`);
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${base} ${counter}.md`);
      counter++;
    }
    const lines: string[] = [
      "---",
      "flashcard: true",
      `lh-source: ${this.yaml(input.session.id)}`,
      `lh-topic: ${this.yaml(input.session.topic)}`,
      `lh-created: ${new Date().toISOString()}`,
      "tags:",
      "  - study-harness/flashcards",
      "---",
      "",
      `# ${input.title}`,
      "",
      `> Generated from study session: **${input.session.title}**`,
      "",
    ];
    for (const card of input.cards) {
      lines.push(`## ${card.front.replace(/\s*\n\s*/g, " ").replace(/^#+\s*/, "")}`, "", card.back.trim(), "");
    }
    await this.app.vault.create(path, lines.join("\n"));
    return path;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // another writer may have created it
        }
      }
    }
  }

  private safeName(value: string): string {
    const name = value
      .replace(/[\\/:*?"<>|#^[\]]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return name || "Study Harness";
  }

  private yaml(value: string): string {
    return JSON.stringify(value);
  }
}

class StudyHarnessSettingTab extends PluginSettingTab {
  private readonly plugin: StudyHarnessPlugin;
  constructor(app: App, plugin: StudyHarnessPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Study Harness" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "The harness calls an OpenAI-compatible chat completions API. OpenRouter is a convenient default because it exposes many models through one key.",
    });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in this plugin's data.json. Do not put secrets in synced notes.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("sk-or-…")
          .setValue(this.plugin.config.apiKey)
          .onChange((value) => {
            this.plugin.config.apiKey = value.trim();
            this.plugin.scheduleSave();
          });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("OpenAI-compatible base URL, without /chat/completions.")
      .addText((text) =>
        text
          .setPlaceholder("https://openrouter.ai/api/v1")
          .setValue(this.plugin.config.baseUrl)
          .onChange((value) => {
            this.plugin.config.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
            this.plugin.scheduleSave();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model id, e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet.")
      .addText((text) =>
        text
          .setPlaceholder("openai/gpt-4o-mini")
          .setValue(this.plugin.config.model)
          .onChange((value) => {
            this.plugin.config.model = value.trim() || DEFAULT_SETTINGS.model;
            this.plugin.scheduleSave();
          }),
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Upper bound for a single model response.")
      .addText((text) =>
        text
          .setPlaceholder("2400")
          .setValue(String(this.plugin.config.maxTokens))
          .onChange((value) => {
            const parsed = Number(value);
            this.plugin.config.maxTokens = Number.isFinite(parsed) ? Math.max(256, Math.min(16000, Math.round(parsed))) : DEFAULT_SETTINGS.maxTokens;
            this.plugin.scheduleSave();
          }),
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower is more consistent; higher is more exploratory.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.config.temperature)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.config.temperature = value;
            this.plugin.scheduleSave();
          }),
      );

    new Setting(containerEl)
      .setName("Default intent")
      .setDesc("Used when starting a new session.")
      .addDropdown((dropdown) => {
        for (const intent of ["conceptual", "exam", "research", "application", "memorisation", "maintenance"] as Intent[]) {
          dropdown.addOption(intent, intentLabel(intent));
        }
        dropdown.setValue(this.plugin.config.defaultIntent).onChange((value) => {
          this.plugin.config.defaultIntent = value as Intent;
          this.plugin.scheduleSave();
        });
      });

    new Setting(containerEl)
      .setName("Auto-suggest cards")
      .setDesc("Adds a prompt instruction to generate cards at the end of memorisation sessions.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.config.autoCards).onChange((value) => {
          this.plugin.config.autoCards = value;
          this.plugin.scheduleSave();
        }),
      );

    const buttons = containerEl.createDiv({ cls: "sh-settings-actions" });
    const graph = buttons.createEl("button", { text: "Open knowledge graph", attr: { type: "button" } });
    graph.addEventListener("click", () => void this.plugin.openGraph());
    const session = buttons.createEl("button", { text: "Open study workspace", attr: { type: "button" } });
    session.addEventListener("click", () => void this.plugin.openSessionView());
  }
}
