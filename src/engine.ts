import { LlmClient, extractJson, type LlmToolSchema } from "./llm";
import { TOOL_SCHEMAS, buildSystemPrompt, flashcardPrompt, newSessionKickoff } from "./prompts";
import { extractKnowledge, sessionExtractionText } from "./extraction";
import type { HarnessStore } from "./store";
import {
  type AskAnswer,
  type AskLearnerInput,
  type EvidenceType,
  type LlmMessage,
  type LlmToolCall,
  type Plan,
  type Session,
  type Settings,
  type KnowledgeKind,
  nowIso,
  uid,
} from "./types";

export interface EngineHost {
  store: HarnessStore;
  getSettings(): Settings;
  notify(): void;
  onStreamEnd(sessionId: string): void;
  writeFlashcardDeck(input: {
    session: Session;
    title: string;
    cards: Array<{ front: string; back: string }>;
    sourceNodeIds?: string[];
  }): Promise<string>;
}

interface ToolExecution {
  content: string;
  stopForQuestion?: { input: AskLearnerInput; toolCallId: string };
}

const MAX_STEPS = 10;

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseArgs(call: LlmToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "node";
}

function validatePlan(raw: Record<string, unknown>): { plan?: Plan; error?: string } {
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawNodes.length < 1 || rawNodes.length > 20) {
    return { error: "plan_init needs between 1 and 20 nodes." };
  }
  const nodes = rawNodes.map((item) => {
    const n = (item ?? {}) as Record<string, unknown>;
    const id = slug(typeof n.id === "string" ? n.id : "");
    const title = typeof n.title === "string" ? n.title.trim() : id;
    const statement = typeof n.statement === "string" ? n.statement.trim() : title;
    const kindValue = typeof n.kind === "string" ? n.kind : "definition";
    const kinds: KnowledgeKind[] = ["definition", "assumption", "theorem", "empirical", "heuristic", "procedure", "analogy", "application"];
    const kind = kinds.includes(kindValue as KnowledgeKind) ? (kindValue as KnowledgeKind) : "definition";
    const domain = typeof n.domain === "string" ? n.domain.trim() : undefined;
    return { id, title, statement, kind, domain };
  });
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) return { error: "plan_init has duplicate node ids." };
  const edges: Array<{ from: string; to: string }> = [];
  for (const item of rawEdges) {
    const e = (item ?? {}) as Record<string, unknown>;
    const from = typeof e.from === "string" ? slug(e.from) : "";
    const to = typeof e.to === "string" ? slug(e.to) : "";
    if (!ids.has(from) || !ids.has(to)) return { error: `plan_init edge ${from} -> ${to} references an unknown node.` };
    if (from === to) return { error: "plan_init has a self-loop edge." };
    if (!edges.some((x) => x.from === from && x.to === to)) edges.push({ from, to });
  }
  // Cycle check.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) if (hasCycle(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of ids) if (hasCycle(id)) return { error: "plan_init edges form a cycle." };
  return { plan: { nodes, edges, version: 1 } };
}

function normalizeCorrect(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function gradeAnswer(input: AskLearnerInput, answer: AskAnswer): boolean | undefined {
  if (!input.options || input.options.length === 0) return undefined;
  const correct = normalizeCorrect(input.correctAnswer);
  if (correct.length === 0) return undefined;
  const selected = Array.isArray(answer.answer) ? answer.answer : answer.answer ? [answer.answer] : [];
  if (selected.length === 0) return false;
  if (input.multiSelect) {
    const a = [...new Set(selected)].sort();
    const b = [...new Set(correct)].sort();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return selected.length === 1 && selected[0] === correct[0];
}

export class HarnessEngine {
  private readonly host: EngineHost;
  private readonly llm = new LlmClient();
  private readonly running = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly live = new Map<string, { text: string; reasoning: string }>();

  constructor(host: EngineHost) {
    this.host = host;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  liveText(sessionId: string): { text: string; reasoning: string } {
    return this.live.get(sessionId) ?? { text: "", reasoning: "" };
  }

  async startSession(sessionId: string): Promise<void> {
    const session = this.host.store.getSession(sessionId);
    if (!session || session.messages.length > 0) return;
    this.host.store.addUserMessage(session, newSessionKickoff(session));
    await this.runLoop(session);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.host.store.getSession(sessionId);
    if (!session || !text.trim()) return;
    if (session.pendingQuestion) return;
    this.host.store.addUserMessage(session, text.trim());
    await this.runLoop(session);
  }

  async submitAnswer(sessionId: string, answer: AskAnswer): Promise<void> {
    const session = this.host.store.getSession(sessionId);
    if (!session?.pendingQuestion) return;
    const pending = session.pendingQuestion;
    const input = pending.input;
    const correct = answer.dontKnow ? undefined : gradeAnswer(input, answer);
    const evidenceType = (input.type === "explain" ? "explain" : input.type) as EvidenceType;
    if (input.nodeId) {
      const result = answer.dontKnow ? "unknown" : correct === undefined ? null : correct ? "correct" : "incorrect";
      if (result) {
        this.host.store.addEvidence({
          nodeId: input.nodeId,
          sessionId: session.id,
          type: evidenceType,
          result,
          confidence: answer.confidence,
          note: answer.thinking?.slice(0, 240),
        });
      }
    }
    const payload = {
      questionType: input.type,
      answer: answer.answer ?? null,
      text: answer.text ?? null,
      correct: correct ?? null,
      dontKnow: answer.dontKnow === true,
      confidence: answer.confidence ?? null,
      thinking: answer.thinking ?? null,
      referenceAnswer: input.referenceAnswer ?? null,
      explanation: input.explanation ?? null,
    };
    this.host.store.addToolMessage(session, pending.toolCallId, "ask_learner", safeJson(payload));
    this.host.store.setPending(session, undefined);
    session.status = "idle";
    this.host.store.touchSession(session);
    this.host.notify();
    await this.runLoop(session);
  }

  stop(sessionId: string): void {
    this.aborts.get(sessionId)?.abort();
  }

  stopAll(): void {
    for (const id of this.running) this.aborts.get(id)?.abort();
  }

  async generateFlashcards(sessionId: string): Promise<string> {
    const session = this.host.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add an API key in Study Harness settings first.");
    const result = await this.llm.complete(
      [
        { role: "system", content: "You are a precise flashcard author. Return JSON only, no prose." },
        { role: "user", content: flashcardPrompt(session, this.host.store) },
      ],
      undefined,
      settings,
    );
    const parsed = extractJson<{ title?: string; cards?: Array<{ front?: string; back?: string }> }>(result.text);
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error("The model did not return a valid flashcard deck.");
    }
    const cards = parsed.cards
      .map((c) => ({ front: (c.front ?? "").trim(), back: (c.back ?? "").trim() }))
      .filter((c) => c.front && c.back)
      .slice(0, 20);
    if (cards.length === 0) throw new Error("The model returned empty cards.");
    return this.host.writeFlashcardDeck({
      session,
      title: (parsed.title ?? `${session.topic} — key facts`).trim(),
      cards,
      sourceNodeIds: session.plan?.nodes.map((n) => n.id),
    });
  }

  async extractSessionGraph(sessionId: string, force = false): Promise<{ nodes: number; links: number }> {
    const session = this.host.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.graphExtraction?.status === "running") return { nodes: 0, links: 0 };
    if (!force && session.graphExtraction?.status === "done") {
      return { nodes: session.graphExtraction.nodes ?? 0, links: session.graphExtraction.links ?? 0 };
    }
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add an API key in Study Harness settings first.");
    const text = sessionExtractionText(session);
    if (text.trim().length < 80) {
      session.graphExtraction = { status: "done", at: nowIso(), nodes: 0, links: 0 };
      this.host.store.touchSession(session);
      this.host.notify();
      return { nodes: 0, links: 0 };
    }
    session.graphExtraction = { status: "running", at: nowIso() };
    this.host.store.touchSession(session);
    this.host.notify();
    try {
      const result = await extractKnowledge(this.llm, settings, {
        text,
        topic: session.topic,
        sourceLabel: `Session: ${session.title}`,
        existing: this.host.store.nodes(),
      });
      const stats = this.host.store.mergeExtracted({
        sourceId: session.id,
        sessionId: session.id,
        domain: session.topic,
        propositions: result.propositions,
        relations: result.relations,
      });
      session.graphExtraction = {
        status: "done",
        at: nowIso(),
        nodes: stats.nodesCreated + stats.nodesLinked,
        links: stats.linksCreated,
      };
      this.host.store.touchSession(session);
      this.host.notify();
      return { nodes: stats.nodesCreated + stats.nodesLinked, links: stats.linksCreated };
    } catch (err) {
      session.graphExtraction = {
        status: "error",
        at: nowIso(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.host.store.touchSession(session);
      this.host.notify();
      throw err;
    }
  }

  async importNotes(
    notes: Array<{ path: string; text: string }>,
    domain: string,
    onProgress?: (message: string) => void,
  ): Promise<Array<{ path: string; ok: boolean; nodes: number; links: number; error?: string }>> {
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add an API key in Study Harness settings first.");
    const out: Array<{ path: string; ok: boolean; nodes: number; links: number; error?: string }> = [];
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const source = this.host.store.addNoteSource(note.path);
      onProgress?.(`Extracting ${i + 1}/${notes.length}: ${note.path}`);
      try {
        if (!note.text.trim()) throw new Error("Note is empty.");
        const result = await extractKnowledge(this.llm, settings, {
          text: note.text.slice(0, 28_000),
          topic: domain,
          sourceLabel: note.path,
          existing: this.host.store.nodes(),
        });
        const stats = this.host.store.mergeExtracted({
          sourceId: source.id,
          sourcePath: note.path,
          domain,
          propositions: result.propositions,
          relations: result.relations,
        });
        this.host.store.updateNoteSource(source.id, {
          status: "done",
          nodes: stats.nodesCreated + stats.nodesLinked,
          links: stats.linksCreated,
          importedAt: nowIso(),
        });
        out.push({ path: note.path, ok: true, nodes: stats.nodesCreated + stats.nodesLinked, links: stats.linksCreated });
      } catch (err) {
        this.host.store.updateNoteSource(source.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          importedAt: nowIso(),
        });
        out.push({ path: note.path, ok: false, nodes: 0, links: 0, error: err instanceof Error ? err.message : String(err) });
      }
      this.host.notify();
    }
    return out;
  }

  private async runLoop(session: Session): Promise<void> {
    if (this.running.has(session.id)) return;
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) {
      this.host.store.failTurn(session, "No API key configured. Open Settings → Study Harness.");
      this.host.notify();
      return;
    }
    this.running.add(session.id);
    const controller = new AbortController();
    this.aborts.set(session.id, controller);
    this.live.set(session.id, { text: "", reasoning: "" });
    this.host.store.startTurn(session);
    this.host.notify();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const messages: LlmMessage[] = [
          { role: "system", content: buildSystemPrompt(session, this.host.store, settings) },
          ...session.messages,
        ];
        this.live.set(session.id, { text: "", reasoning: "" });
        const result = await this.llm.stream(
          messages,
          TOOL_SCHEMAS,
          settings,
          {
            onText: (chunk) => {
              const live = this.live.get(session.id) ?? { text: "", reasoning: "" };
              live.text += chunk;
              this.live.set(session.id, live);
              this.host.notify();
            },
            onReasoning: (chunk) => {
              const live = this.live.get(session.id) ?? { text: "", reasoning: "" };
              live.reasoning += chunk;
              this.live.set(session.id, live);
            },
          },
          controller.signal,
        );
        const toolCalls = result.toolCalls.map((call, index) => ({
          ...call,
          id: call.id || `call_${Date.now().toString(36)}_${index}`,
        }));
        const assistant: LlmMessage = {
          role: "assistant",
          content: result.text.trim() ? result.text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(result.reasoning.trim() ? { reasoning: result.reasoning } : {}),
        };
        if (assistant.content || assistant.tool_calls?.length) {
          this.host.store.addAssistantMessage(session, assistant);
        }
        this.live.set(session.id, { text: "", reasoning: "" });
        if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
          session.status = "idle";
          break;
        }

        let pending: { input: AskLearnerInput; toolCallId: string } | undefined;
        let executed = 0;
        for (const call of assistant.tool_calls) {
          const execution = await this.executeTool(session, call);
          if (execution.stopForQuestion) {
            if (pending) {
              this.host.store.addToolMessage(
                session,
                call.id,
                call.function.name,
                safeJson({ ok: false, error: "only one ask_learner call is allowed per turn; this question was not posed" }),
              );
            } else {
              pending = execution.stopForQuestion;
            }
            continue;
          }
          this.host.store.addToolMessage(session, call.id, call.function.name, execution.content);
          executed++;
        }
        if (pending) {
          session.pendingQuestion = { toolCallId: pending.toolCallId, input: pending.input, createdAt: nowIso() };
          session.status = "waiting";
          session.phase = session.plan ? (session.mode === "practice" ? "practice" : "teach") : session.phase;
          this.host.store.touchSession(session);
          break;
        }
        if (executed === 0) {
          session.status = "idle";
          break;
        }
        if (session.status === "done") break;
        this.host.store.touchSession(session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        session.status = "idle";
        this.host.store.touchSession(session);
      } else {
        this.host.store.failTurn(session, message);
      }
    } finally {
      this.running.delete(session.id);
      this.aborts.delete(session.id);
      this.live.delete(session.id);
      this.host.onStreamEnd(session.id);
      this.host.notify();
    }
  }

  private async executeTool(session: Session, call: LlmToolCall): Promise<ToolExecution> {
    const name = call.function.name;
    const args = parseArgs(call);
    if (name === "ask_learner") {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const type = typeof args.type === "string" ? args.type : "check";
      if (!question) return { content: safeJson({ ok: false, error: "question is required" }) };
      const validTypes = ["probe", "predict", "check", "practice", "explain"];
      if (!validTypes.includes(type)) {
        return { content: safeJson({ ok: false, error: "type must be probe, predict, check, practice, or explain" }) };
      }
      const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
      if (session.plan && !nodeId) {
        return { content: safeJson({ ok: false, error: "nodeId is required when a plan exists" }) };
      }
      if (nodeId && session.plan && !session.plan.nodes.some((n) => n.id === nodeId)) {
        return { content: safeJson({ ok: false, error: `unknown nodeId ${nodeId}; use an exact node id` }) };
      }
      const options = Array.isArray(args.options)
        ? args.options
            .map((o) => {
              const item = (o ?? {}) as Record<string, unknown>;
              const label = typeof item.label === "string" ? item.label.trim() : "";
              const value = typeof item.value === "string" ? item.value.trim() : label;
              return label ? { label, value } : null;
            })
            .filter((o): o is { label: string; value: string } => o !== null)
        : undefined;
      if (options && options.length > 0 && options.length < 2) {
        return { content: safeJson({ ok: false, error: "an option question needs at least 2 options" }) };
      }
      const correctAnswer = args.correctAnswer as string | string[] | undefined;
      if (options && options.length >= 2) {
        const values = new Set(options.map((o) => o.value));
        const correct = normalizeCorrect(correctAnswer);
        if (correct.length === 0) {
          return { content: safeJson({ ok: false, error: "correctAnswer is required for an option question" }) };
        }
        if (!correct.every((v) => values.has(v))) {
          return { content: safeJson({ ok: false, error: "correctAnswer must match option values exactly" }) };
        }
        if (correct.length > 1 && args.multiSelect !== true) {
          return { content: safeJson({ ok: false, error: "set multiSelect true when several options are correct" }) };
        }
      }
      const input: AskLearnerInput = {
        question,
        type: type as AskLearnerInput["type"],
        nodeId,
        options,
        multiSelect: args.multiSelect === true,
        correctAnswer,
        referenceAnswer: typeof args.referenceAnswer === "string" ? args.referenceAnswer : undefined,
        explanation: typeof args.explanation === "string" ? args.explanation : undefined,
        details: typeof args.details === "string" ? args.details : undefined,
      };
      return { content: safeJson({ ok: true, note: "question posed" }), stopForQuestion: { input, toolCallId: call.id } };
    }

    if (name === "plan_init") {
      const validated = validatePlan(args);
      if (!validated.plan) return { content: safeJson({ ok: false, error: validated.error ?? "invalid plan" }) };
      this.host.store.upsertPlan(session, validated.plan);
      return {
        content: safeJson({
          ok: true,
          nodeIds: validated.plan.nodes.map((n) => n.id),
          note: "Plan saved. Every later ask_learner must include one of these nodeIds.",
        }),
      };
    }

    if (name === "record_evidence") {
      const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
      const result = typeof args.result === "string" ? args.result : "unknown";
      if (!nodeId) return { content: safeJson({ ok: false, error: "nodeId is required" }) };
      const valid = ["correct", "partial", "incorrect", "unknown"];
      if (!valid.includes(result)) return { content: safeJson({ ok: false, error: "invalid result" }) };
      if (!this.host.store.data.nodes[nodeId]) {
        return { content: safeJson({ ok: false, error: `unknown nodeId ${nodeId}` }) };
      }
      this.host.store.addEvidence({
        nodeId,
        sessionId: session.id,
        type: "explain",
        result: result as "correct" | "partial" | "incorrect" | "unknown",
        confidence: typeof args.confidence === "number" ? args.confidence : undefined,
        note: typeof args.note === "string" ? args.note : undefined,
      });
      return { content: safeJson({ ok: true }) };
    }

    if (name === "create_flashcards") {
      const cards = Array.isArray(args.cards)
        ? args.cards
            .map((c) => {
              const item = (c ?? {}) as Record<string, unknown>;
              return {
                front: typeof item.front === "string" ? item.front.trim() : "",
                back: typeof item.back === "string" ? item.back.trim() : "",
              };
            })
            .filter((c) => c.front && c.back)
        : [];
      if (cards.length === 0) return { content: safeJson({ ok: false, error: "cards is empty" }) };
      const title = typeof args.title === "string" ? args.title.trim() : `${session.topic} — key facts`;
      try {
        const path = await this.host.writeFlashcardDeck({
          session,
          title,
          cards,
          sourceNodeIds: session.plan?.nodes.map((n) => n.id),
        });
        this.host.notify();
        return { content: safeJson({ ok: true, path, note: `Deck written to ${path}.` }) };
      } catch (err) {
        return { content: safeJson({ ok: false, error: `could not write deck: ${err instanceof Error ? err.message : String(err)}` }) };
      }
    }

    if (name === "finish_session") {
      session.summary = typeof args.summary === "string" ? args.summary : "";
      session.keyPoints = Array.isArray(args.keyPoints)
        ? args.keyPoints.filter((v): v is string => typeof v === "string")
        : [];
      session.phase = "done";
      session.status = "done";
      this.host.store.touchSession(session);
      void this.extractSessionGraph(session.id).catch((err) => {
        console.error("Study Harness: session graph extraction failed", err);
      });
      return { content: safeJson({ ok: true, note: "Session concluded. The knowledge graph is being updated in the background." }) };
    }

    return { content: safeJson({ ok: false, error: `unknown tool ${name}` }) };
  }
}
