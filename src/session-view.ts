import { ItemView, MarkdownRenderer, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type StudyHarnessPlugin from "./main";
import type {
  AskAnswer,
  AskLearnerInput,
  Intent,
  LlmToolCall,
  Session,
  SessionMode,
} from "./types";
import { intentLabel } from "./types";

export const VIEW_TYPE_SESSION = "study-harness-session";

const INTENTS: Intent[] = ["conceptual", "exam", "research", "application", "memorisation", "maintenance"];
const MODES: SessionMode[] = ["study", "practice"];

function parseToolArgs(call: LlmToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseAsk(call: LlmToolCall): AskLearnerInput | null {
  const args = parseToolArgs(call);
  if (typeof args.question !== "string") return null;
  const options = Array.isArray(args.options)
    ? args.options
        .map((o) => {
          const item = (o ?? {}) as Record<string, unknown>;
          const label = typeof item.label === "string" ? item.label : "";
          const value = typeof item.value === "string" ? item.value : label;
          return label ? { label, value } : null;
        })
        .filter((o): o is { label: string; value: string } => o !== null)
    : undefined;
  return {
    question: args.question,
    type: (typeof args.type === "string" ? args.type : "check") as AskLearnerInput["type"],
    nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined,
    options,
    multiSelect: args.multiSelect === true,
    correctAnswer: args.correctAnswer as string | string[] | undefined,
    referenceAnswer: typeof args.referenceAnswer === "string" ? args.referenceAnswer : undefined,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
    details: typeof args.details === "string" ? args.details : undefined,
  };
}

function answerFrom(session: Session, callId: string): (AskAnswer & { raw: Record<string, unknown> }) | null {
  const message = session.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  if (!message?.content) return null;
  try {
    const raw = JSON.parse(message.content) as Record<string, unknown>;
    return {
      raw,
      answer: raw.answer as string | string[] | undefined,
      text: typeof raw.text === "string" ? raw.text : undefined,
      confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
      thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
      correct: typeof raw.correct === "boolean" ? raw.correct : undefined,
      at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export class SessionView extends ItemView {
  private readonly plugin: StudyHarnessPlugin;
  private rootEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private liveEl: HTMLElement | null = null;
  private planEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private lastKey = "";
  private renderChain: Promise<void> = Promise.resolve();
  private renderQueued = false;
  private draftComposer = "";
  private draftTopic = "";
  private draftIntent: Intent;
  private draftMode: SessionMode = "study";

  constructor(leaf: WorkspaceLeaf, plugin: StudyHarnessPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.draftIntent = plugin.config.defaultIntent;
  }

  getViewType(): string { return VIEW_TYPE_SESSION; }
  getDisplayText(): string {
    const session = this.plugin.activeSessionId ? this.plugin.store.getSession(this.plugin.activeSessionId) : null;
    return session?.title || "Study session";
  }
  getIcon(): string { return "graduation-cap"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("sh-session-view");
    this.addAction("history", "Open sessions panel", () => void this.plugin.openSessionsPanel());
    this.addAction("network", "Open knowledge graph", () => void this.plugin.openGraph());
    this.addAction("layers", "Generate flashcards", () => {
      if (this.plugin.activeSessionId) void this.plugin.generateFlashcards(this.plugin.activeSessionId);
      else new Notice("Open a session first.");
    });
    this.addAction("plus", "New session", () => {
      this.plugin.activeSessionId = null;
      this.lastKey = "";
      void this.refresh();
    });
    this.addAction("upload", "Import notes into knowledge graph", () => this.plugin.openNotesImport());
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.renderQueued = true;
    this.renderChain = this.renderChain
      .then(async () => {
        if (!this.renderQueued) return;
        this.renderQueued = false;
        await this.renderOnce();
      })
      .catch((err) => console.error("Study Harness: session render failed", err));
    return this.renderChain;
  }

  private async renderOnce(): Promise<void> {
    const session = this.plugin.activeSessionId ? this.plugin.store.getSession(this.plugin.activeSessionId) : null;
    const key = session
      ? [
          session.id,
          session.title,
          session.messages.length,
          session.status,
          session.pendingQuestion?.toolCallId ?? "",
          session.plan?.version ?? 0,
          session.lastError ?? "",
          session.phase,
          session.summary ?? "",
        ].join("|")
      : "new";
    if (key === this.lastKey && session?.status === "running") {
      this.updateLive(session);
      return;
    }
    const previous = this.transcriptEl;
    const previousScroll = previous?.scrollTop ?? 0;
    const previousHeight = previous?.scrollHeight ?? 0;
    const previousClient = previous?.clientHeight ?? 0;
    const wasNearBottom = previous ? previousHeight - (previousScroll + previousClient) < 180 : true;

    this.lastKey = key;
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "sh-root" });
    const headerTitle = this.containerEl.querySelector(".view-header-title");
    if (headerTitle instanceof HTMLElement) headerTitle.textContent = this.getDisplayText();
    if (!session) {
      this.renderNewSession();
      return;
    }
    const body = this.rootEl.createDiv({ cls: "sh-body" });
    this.planEl = body.createDiv({ cls: "sh-plan-panel" });
    this.transcriptEl = body.createDiv({ cls: "sh-transcript" });
    await this.renderPlan(session);
    await this.renderTranscript(session);
    this.renderComposer(session);
    window.requestAnimationFrame(() => {
      if (!this.transcriptEl) return;
      if (wasNearBottom || session.status === "waiting") {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      } else {
        this.transcriptEl.scrollTop = Math.min(previousScroll, this.transcriptEl.scrollHeight);
      }
    });
  }

  private renderNewSession(): void {
    const wrap = this.rootEl.createDiv({ cls: "sh-new-session" });
    const card = wrap.createDiv({ cls: "sh-new-card" });
    card.createEl("h2", { text: "Start a study session" });
    card.createEl("p", {
      cls: "sh-muted",
      text: "Choose what you want to learn and why. The harness will probe your boundary, plan a path, and teach one step at a time.",
    });
    const topic = card.createEl("input", {
      cls: "sh-topic-input",
      attr: { type: "text", placeholder: "What do you want to learn?", "aria-label": "Topic" },
    });
    topic.value = this.draftTopic;
    topic.addEventListener("input", () => { this.draftTopic = topic.value; });

    const intentRow = card.createDiv({ cls: "sh-choice-row" });
    intentRow.createDiv({ cls: "sh-choice-label", text: "Intent" });
    const intentSelect = intentRow.createEl("select", { cls: "dropdown" });
    for (const intent of INTENTS) {
      const option = intentSelect.createEl("option", { text: intentLabel(intent) });
      option.value = intent;
      if (intent === this.draftIntent) option.selected = true;
    }
    intentSelect.addEventListener("change", () => {
      this.draftIntent = intentSelect.value as Intent;
    });

    const modeRow = card.createDiv({ cls: "sh-choice-row" });
    modeRow.createDiv({ cls: "sh-choice-label", text: "Mode" });
    const modeSelect = modeRow.createEl("select", { cls: "dropdown" });
    for (const mode of MODES) {
      const option = modeSelect.createEl("option", { text: mode === "study" ? "Study / teach" : "Practice" });
      option.value = mode;
      if (mode === this.draftMode) option.selected = true;
    }
    modeSelect.addEventListener("change", () => { this.draftMode = modeSelect.value as SessionMode; });

    const recent = this.plugin.store.listSessions().slice(0, 5);
    if (recent.length > 0) {
      card.createDiv({ cls: "sh-section-label", text: "Continue a session" });
      const list = card.createDiv({ cls: "sh-recent-list" });
      for (const session of recent) {
        const row = list.createDiv({ cls: "sh-recent-row" });
        row.createDiv({ cls: "sh-recent-title", text: session.title });
        row.createDiv({ cls: "sh-recent-meta", text: `${session.phase} · ${new Date(session.updatedAt).toLocaleDateString()}` });
        row.addEventListener("click", () => void this.plugin.openSession(session.id));
      }
    }

    const footer = card.createDiv({ cls: "sh-new-actions" });
    const start = footer.createEl("button", { cls: "mod-cta", text: "Start", attr: { type: "button" } });
    start.addEventListener("click", () => {
      const value = this.draftTopic.trim();
      if (!value) {
        new Notice("Give the session a topic first.");
        return;
      }
      this.draftTopic = "";
      void this.plugin.createAndStartSession(value, this.draftIntent, this.draftMode);
    });
    topic.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        start.click();
      }
    });
    const settings = footer.createEl("button", { text: "Settings", attr: { type: "button" } });
    settings.addEventListener("click", () => this.plugin.openSettings());
  }

  private async renderPlan(session: Session): Promise<void> {
    this.planEl.empty();
    const summary = this.planEl.createDiv({ cls: "sh-session-summary" });
    const intent = summary.createDiv({ cls: "sh-pill", text: intentLabel(session.intent) });
    intent.addClass(`is-${session.intent}`);
    if (session.mode === "practice") summary.createDiv({ cls: "sh-pill is-practice", text: "Practice" });
    summary.createDiv({ cls: "sh-session-summary-meta", text: `${session.phase} · ${session.status}` });
    this.planEl.createDiv({ cls: "sh-panel-title", text: "Plan" });
    if (!session.plan) {
      this.planEl.createDiv({ cls: "sh-empty-small", text: session.mode === "practice" ? "Practice session — no plan yet." : "The plan appears after probing." });
      return;
    }
    const status = this.plugin.store.planStatus(session);
    const nodes = this.planEl.createDiv({ cls: "sh-plan-nodes" });
    for (const node of session.plan.nodes) {
      const row = nodes.createDiv({ cls: "sh-plan-node" });
      if (status.current === node.id) row.addClass("is-current");
      else if (status.visited.has(node.id)) row.addClass("is-visited");
      const dot = row.createSpan({ cls: "sh-plan-dot" });
      dot.setText(status.current === node.id ? "●" : status.visited.has(node.id) ? "✓" : "○");
      const text = row.createDiv({ cls: "sh-plan-node-text" });
      text.createDiv({ cls: "sh-plan-node-title", text: node.title });
      if (node.statement) text.createDiv({ cls: "sh-plan-node-statement", text: node.statement });
      row.addEventListener("click", () => {
        const existing = this.plugin.store.data.nodes[node.id];
        if (existing) {
          void this.plugin.openGraph(existing.id);
        }
      });
    }
    const edges = session.plan.edges;
    if (edges.length > 0) {
      this.planEl.createDiv({ cls: "sh-plan-edge-count", text: `${edges.length} prerequisite links` });
    }
  }

  private async renderTranscript(session: Session): Promise<void> {
    this.transcriptEl.empty();
    this.liveEl = null;
    for (const message of session.messages) {
      if (message.role === "user") {
        const block = this.transcriptEl.createDiv({ cls: "sh-learner-block" });
        block.createDiv({ cls: "sh-block-kicker", text: "You" });
        const body = block.createDiv({ cls: "sh-markdown" });
        await MarkdownRenderer.render(this.app, message.content ?? "", body, "", this);
        continue;
      }
      if (message.role === "assistant") {
        if (message.content) {
          const block = this.transcriptEl.createDiv({ cls: "sh-teacher-block" });
          block.createDiv({ cls: "sh-block-kicker", text: "Teacher" });
          const body = block.createDiv({ cls: "sh-markdown" });
          await MarkdownRenderer.render(this.app, message.content, body, "", this);
        }
        for (const call of message.tool_calls ?? []) {
          await this.renderToolCall(session, call);
        }
      }
    }
    if (session.status === "running") {
      this.liveEl = this.transcriptEl.createDiv({ cls: "sh-teacher-block sh-live-block" });
      this.liveEl.createDiv({ cls: "sh-block-kicker", text: "Teacher" });
      this.liveEl.createDiv({ cls: "sh-markdown sh-live-text", text: "Thinking…" });
      this.updateLive(session);
    }
    if (session.status === "error" && session.lastError) {
      const block = this.transcriptEl.createDiv({ cls: "sh-error-block" });
      block.createDiv({ cls: "sh-error-title", text: "The turn failed" });
      block.createDiv({ cls: "sh-error-text", text: session.lastError });
      const retry = block.createEl("button", { text: "Retry", attr: { type: "button" } });
      retry.addEventListener("click", () => {
        if (session.messages.length > 0) void this.plugin.engine.sendMessage(session.id, "Please continue.");
      });
    }
    if (session.status === "done") {
      const block = this.transcriptEl.createDiv({ cls: "sh-done-block" });
      block.createDiv({ cls: "sh-done-title", text: "Session complete" });
      if (session.summary) block.createDiv({ cls: "sh-done-summary", text: session.summary });
      if (session.keyPoints?.length) {
        const list = block.createEl("ul");
        for (const point of session.keyPoints) list.createEl("li", { text: point });
      }
      if (session.graphExtraction?.status === "running") {
        block.createEl("p", { cls: "sh-muted", text: "Updating the knowledge graph in the background…" });
      } else if (session.graphExtraction?.status === "done") {
        block.createEl("p", {
          cls: "sh-muted",
          text: `Graph updated: ${session.graphExtraction.nodes ?? 0} nodes, ${session.graphExtraction.links ?? 0} links.`,
        });
      } else if (session.graphExtraction?.status === "error") {
        block.createEl("p", {
          cls: "sh-error-text",
          text: `Graph extraction failed: ${session.graphExtraction.error ?? "unknown error"}`,
        });
      } else {
        block.createEl("p", { cls: "sh-muted", text: "Open the knowledge graph to see what was added." });
      }
      if (session.graphExtraction?.status !== "running") {
        const extract = block.createEl("button", {
          cls: "sh-ghost",
          text: session.graphExtraction?.status === "done" ? "Re-extract graph" : "Extract graph now",
          attr: { type: "button" },
        });
        extract.addEventListener("click", () => void this.plugin.extractCurrentSession());
      }
    }
    if (this.transcriptEl.childElementCount === 0) {
      this.transcriptEl.createDiv({ cls: "sh-empty", text: "The teacher will begin shortly." });
    }
  }

  private updateLive(session: Session): void {
    if (!this.liveEl) return;
    const live = this.plugin.engine.liveText(session.id);
    const body = this.liveEl.querySelector(".sh-live-text");
    if (!(body instanceof HTMLElement)) return;
    if (live.text.trim()) {
      body.setText(live.text);
      body.removeClass("is-thinking");
    } else {
      body.setText("Thinking…");
      body.addClass("is-thinking");
    }
  }

  private async renderToolCall(session: Session, call: LlmToolCall): Promise<void> {
    if (call.function.name === "ask_learner") {
      const input = parseAsk(call);
      if (!input) return;
      const answered = answerFrom(session, call.id);
      if (!answered) {
        if (session.pendingQuestion?.toolCallId === call.id) {
          await this.renderQuestionCard(input, call.id, session);
        }
        return;
      }
      await this.renderAnsweredCard(input, answered.raw);
      return;
    }
    if (call.function.name === "plan_init") {
      const args = parseToolArgs(call);
      const nodes = Array.isArray(args.nodes) ? args.nodes : [];
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip sh-plan-chip" });
      setIcon(block.createSpan({ cls: "sh-chip-icon" }), "map");
      block.createSpan({ cls: "sh-chip-title", text: "Plan updated" });
      block.createSpan({ cls: "sh-chip-meta", text: `${nodes.length} landmarks` });
      return;
    }
    if (call.function.name === "record_evidence") {
      const args = parseToolArgs(call);
      const result = typeof args.result === "string" ? args.result : "unknown";
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip" });
      setIcon(block.createSpan({ cls: "sh-chip-icon" }), "check-circle");
      block.createSpan({ cls: "sh-chip-title", text: "Evidence recorded" });
      block.createSpan({ cls: `sh-chip-meta is-${result}`, text: result });
      return;
    }
    if (call.function.name === "create_flashcards") {
      const args = parseToolArgs(call);
      const title = typeof args.title === "string" ? args.title : "Flashcard deck";
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip" });
      setIcon(block.createSpan({ cls: "sh-chip-icon" }), "layers");
      block.createSpan({ cls: "sh-chip-title", text: title });
      block.createSpan({ cls: "sh-chip-meta", text: "deck written" });
      return;
    }
    if (call.function.name === "finish_session") {
      const args = parseToolArgs(call);
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip sh-finish-chip" });
      setIcon(block.createSpan({ cls: "sh-chip-icon" }), "flag");
      block.createSpan({ cls: "sh-chip-title", text: "Session finished" });
      if (typeof args.summary === "string") block.createSpan({ cls: "sh-chip-meta", text: args.summary });
    }
  }

  private async renderQuestionCard(input: AskLearnerInput, callId: string, session: Session): Promise<void> {
    const card = this.transcriptEl.createDiv({ cls: "sh-question-card" });
    const kicker = card.createDiv({ cls: "sh-question-kicker" });
    kicker.createSpan({ text: input.type === "probe" ? "Probe" : input.type === "predict" ? "Predict" : input.type === "practice" ? "Practice" : "Check your understanding" });
    if (input.nodeId) kicker.createSpan({ cls: "sh-question-node", text: input.nodeId });
    const qBody = card.createDiv({ cls: "sh-markdown sh-question-text" });
    await MarkdownRenderer.render(this.app, input.question, qBody, "", this);
    if (input.details) {
      const detail = card.createDiv({ cls: "sh-question-details" });
      await MarkdownRenderer.render(this.app, input.details, detail, "", this);
    }
    const selected = new Set<string>();
    let textAnswer = "";
    if (input.options && input.options.length > 0) {
      const options = card.createDiv({ cls: "sh-options" });
      for (const option of input.options) {
        const row = options.createEl("label", { cls: "sh-option" });
        const radio = row.createEl("input", {
          attr: { type: input.multiSelect ? "checkbox" : "radio", name: `q-${callId}` },
        });
        radio.value = option.value;
        radio.addEventListener("change", () => {
          if (input.multiSelect) {
            if (radio.checked) selected.add(option.value);
            else selected.delete(option.value);
          } else {
            selected.clear();
            selected.add(option.value);
          }
        });
        const label = row.createSpan({ cls: "sh-option-label" });
        await MarkdownRenderer.render(this.app, option.label, label, "", this);
      }
    } else {
      const answer = card.createEl("textarea", {
        cls: "sh-free-answer",
        attr: { rows: "4", placeholder: "Explain in your own words…" },
      });
      answer.addEventListener("input", () => { textAnswer = answer.value; });
    }

    const controls = card.createDiv({ cls: "sh-answer-controls" });
    const confidenceWrap = controls.createDiv({ cls: "sh-confidence" });
    confidenceWrap.createSpan({ cls: "sh-confidence-label", text: "Confidence" });
    const slider = confidenceWrap.createEl("input", {
      attr: { type: "range", min: "0", max: "100", value: "50", step: "1" },
    });
    const confidenceValue = confidenceWrap.createSpan({ cls: "sh-confidence-value", text: "50%" });
    slider.addEventListener("input", () => { confidenceValue.setText(`${slider.value}%`); });
    const thinking = card.createEl("textarea", {
      cls: "sh-thinking",
      attr: { rows: "3", placeholder: "Think out loud: your reasoning, uncertainty, or questions…" },
    });
    thinking.addEventListener("input", () => { /* kept in closure via value */ });
    const submit = controls.createEl("button", { cls: "mod-cta", text: "Answer", attr: { type: "button" } });
    submit.addEventListener("click", () => {
      submit.disabled = true;
      const answer: AskAnswer = {
        answer: input.options ? [...selected] : undefined,
        text: input.options ? undefined : textAnswer.trim(),
        confidence: Number(slider.value),
        thinking: thinking.value.trim() || undefined,
        at: new Date().toISOString(),
      };
      if (input.options && answer.answer?.length === 0) {
        new Notice("Select an option first.");
        submit.disabled = false;
        return;
      }
      if (!input.options && !answer.text) {
        new Notice("Write an answer first.");
        submit.disabled = false;
        return;
      }
      void this.plugin.engine.submitAnswer(session.id, answer);
    });
    const dontKnow = controls.createEl("button", { cls: "sh-ghost", text: "I don't know", attr: { type: "button" } });
    dontKnow.addEventListener("click", () => {
      void this.plugin.engine.submitAnswer(session.id, {
        answer: input.options ? [] : undefined,
        text: input.options ? undefined : "I don't know.",
        confidence: Number(slider.value),
        thinking: thinking.value.trim() || undefined,
        dontKnow: true,
        at: new Date().toISOString(),
      });
    });
  }

  private async renderAnsweredCard(input: AskLearnerInput, raw: Record<string, unknown>): Promise<void> {
    const card = this.transcriptEl.createDiv({ cls: "sh-question-card is-answered" });
    const kicker = card.createDiv({ cls: "sh-question-kicker" });
    kicker.createSpan({ text: input.type === "probe" ? "Probe" : input.type === "practice" ? "Practice" : "Check" });
    if (typeof raw.correct === "boolean") {
      kicker.createSpan({ cls: raw.correct ? "sh-correct" : "sh-incorrect", text: raw.correct ? "Correct" : "Incorrect" });
    }
    const qBody = card.createDiv({ cls: "sh-markdown sh-question-text" });
    await MarkdownRenderer.render(this.app, input.question, qBody, "", this);
    const answerText = raw.dontKnow === true
      ? "I don't know"
      : Array.isArray(raw.answer)
        ? raw.answer.join(", ")
        : typeof raw.answer === "string"
          ? raw.answer
          : typeof raw.text === "string"
            ? raw.text
            : "(no answer)";
    const answerLine = card.createDiv({ cls: "sh-answer-line" });
    answerLine.createSpan({ cls: "sh-answer-label", text: "Your answer: " });
    answerLine.createSpan({ text: answerText || "(empty)" });
    if (typeof raw.confidence === "number") {
      answerLine.createSpan({ cls: "sh-answer-confidence", text: ` · ${raw.confidence}% confident` });
    }
    if (typeof raw.thinking === "string" && raw.thinking.trim()) {
      const think = card.createDiv({ cls: "sh-answer-thinking" });
      think.createSpan({ cls: "sh-answer-label", text: "Your thinking: " });
      think.createSpan({ text: raw.thinking });
    }
    if (input.explanation) {
      const exp = card.createDiv({ cls: "sh-explanation" });
      await MarkdownRenderer.render(this.app, input.explanation, exp, "", this);
    }
  }

  private renderComposer(session: Session): void {
    const composer = this.rootEl.createDiv({ cls: "sh-composer-wrap" });
    if (session.pendingQuestion) {
      const waiting = composer.createDiv({ cls: "sh-composer-waiting" });
      waiting.createSpan({ text: "Answer the question above to continue." });
      return;
    }
    if (session.status === "done") {
      const done = composer.createDiv({ cls: "sh-composer-waiting" });
      done.createSpan({ text: "Session complete. " });
      const again = done.createEl("button", { cls: "sh-link-button", text: "Start another", attr: { type: "button" } });
      again.addEventListener("click", () => {
        this.plugin.activeSessionId = null;
        this.lastKey = "";
        void this.refresh();
      });
      return;
    }
    const shell = composer.createDiv({ cls: "sh-composer" });
    this.composerEl = shell.createEl("textarea", {
      cls: "sh-composer-input",
      attr: { rows: "2", placeholder: "Ask, answer, or think out loud…" },
    });
    this.composerEl.value = this.draftComposer;
    this.composerEl.addEventListener("input", () => { this.draftComposer = this.composerEl.value; });
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.sendComposer(session);
      }
    });
    this.sendEl = shell.createEl("button", {
      cls: "sh-send-button",
      attr: { type: "button", "aria-label": session.status === "running" ? "Stop" : "Send" },
    });
    setIcon(this.sendEl, session.status === "running" ? "square" : "corner-down-left");
    this.sendEl.addEventListener("click", () => {
      if (session.status === "running") this.plugin.stopSession(session.id);
      else this.sendComposer(session);
    });
    const hint = composer.createDiv({ cls: "sh-composer-hint", text: "Enter to send · Shift+Enter for a new line · thinking out loud is encouraged" });
    void hint;
  }

  private sendComposer(session: Session): void {
    const text = this.composerEl?.value.trim() ?? "";
    if (!text) return;
    this.draftComposer = "";
    if (this.composerEl) this.composerEl.value = "";
    void this.plugin.engine.sendMessage(session.id, text);
  }
}
