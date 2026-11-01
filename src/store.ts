import {
  type AskLearnerInput,
  type Evidence,
  type EvidenceResult,
  type EvidenceType,
  type ExtractedProposition,
  type ExtractedRelation,
  type GraphEdge,
  type KnowledgeKind,
  type KnowledgeNode,
  type NoteSource,
  type Plan,
  type PluginData,
  type Session,
  type SessionMode,
  type Intent,
  emptyData,
  nowIso,
  slugify,
  uid,
} from "./types";

export interface NodeStrength {
  overall: number;
  recall: number;
  explanation: number;
  application: number;
  calibration: number | null;
  count: number;
  lastAt: string | null;
}

function resultScore(result: EvidenceResult): number {
  switch (result) {
    case "correct":
      return 1;
    case "partial":
      return 0.55;
    case "incorrect":
      return 0.05;
    default:
      return 0.35;
  }
}

function evidenceArea(type: EvidenceType): "recall" | "explanation" | "application" {
  if (type === "explain") return "explanation";
  if (type === "practice") return "application";
  return "recall";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export class HarnessStore {
  data: PluginData;
  graphRevision = 0;
  private readonly save: () => void;

  constructor(data: PluginData | null, save: () => void) {
    this.data = data ?? emptyData();
    this.data.settings = { ...emptyData().settings, ...(this.data.settings ?? {}) };
    this.data.sessions ??= {};
    this.data.nodes ??= {};
    this.data.edges ??= [];
    this.data.evidence ??= [];
    this.data.noteSources ??= [];
    for (const node of Object.values(this.data.nodes)) {
      node.sourcePaths ??= [];
      node.sessionIds ??= [];
    }
    for (const session of Object.values(this.data.sessions)) {
      if (session.status === "running") {
        session.status = session.pendingQuestion ? "waiting" : "idle";
      }
      if (session.graphExtraction?.status === "running") {
        session.graphExtraction = {
          status: "error",
          at: nowIso(),
          error: "Interrupted by a plugin reload. Run extraction again.",
        };
      }
    }
    for (const source of this.data.noteSources) {
      if (source.status === "running") {
        source.status = "error";
        source.error = "Interrupted by a plugin reload.";
      }
    }
    this.save = save;
  }

  persist(): void {
    this.save();
  }

  private bumpGraph(): void {
    this.graphRevision++;
  }

  createSession(input: {
    topic: string;
    intent: Intent;
    mode: SessionMode;
    focusNodeId?: string;
  }): Session {
    const topic = input.topic.trim() || "Untitled topic";
    const session: Session = {
      id: uid("s"),
      title: topic,
      topic,
      intent: input.intent,
      mode: input.mode,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "idle",
      phase: input.mode === "practice" ? "practice" : "probe",
      messages: [],
      focusNodeId: input.focusNodeId,
    };
    this.data.sessions[session.id] = session;
    this.persist();
    return session;
  }

  getSession(id: string): Session | null {
    return this.data.sessions[id] ?? null;
  }

  listSessions(): Session[] {
    return Object.values(this.data.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  touchSession(session: Session): void {
    session.updatedAt = nowIso();
    this.data.sessions[session.id] = session;
    this.persist();
  }

  deleteSession(id: string): void {
    delete this.data.sessions[id];
    this.persist();
  }

  renameSession(id: string, title: string): void {
    const session = this.data.sessions[id];
    if (!session) return;
    session.title = title.trim() || session.topic;
    this.persist();
  }

  emptySessions(): Session[] {
    return this.listSessions().filter((s) => s.messages.length === 0);
  }

  noteId(path: string): string {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `note_${(h >>> 0).toString(36)}`;
  }

  addNoteSource(path: string): NoteSource {
    const id = this.noteId(path);
    const existing = this.data.noteSources.find((n) => n.id === id);
    if (existing) {
      existing.status = "running";
      existing.error = undefined;
      existing.importedAt = nowIso();
      this.persist();
      return existing;
    }
    const source: NoteSource = { id, path, importedAt: nowIso(), status: "running" };
    this.data.noteSources.unshift(source);
    this.persist();
    return source;
  }

  updateNoteSource(id: string, patch: Partial<NoteSource>): void {
    const source = this.data.noteSources.find((n) => n.id === id);
    if (!source) return;
    Object.assign(source, patch);
    this.persist();
  }

  listNoteSources(): NoteSource[] {
    return this.data.noteSources.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  startTurn(session: Session): void {
    session.status = "running";
    session.lastError = undefined;
    this.touchSession(session);
  }

  finishTurn(session: Session): void {
    if (session.status === "running") session.status = "idle";
    this.touchSession(session);
  }

  failTurn(session: Session, message: string): void {
    session.status = "error";
    session.lastError = message;
    this.touchSession(session);
  }

  setPending(session: Session, pending: Session["pendingQuestion"]): void {
    session.pendingQuestion = pending;
    if (pending) session.status = "waiting";
    this.touchSession(session);
  }

  addUserMessage(session: Session, content: string): void {
    session.messages.push({ role: "user", content });
    this.touchSession(session);
  }

  addAssistantMessage(session: Session, message: Session["messages"][number]): void {
    session.messages.push(message);
    this.touchSession(session);
  }

  addToolMessage(session: Session, toolCallId: string, name: string, content: string): void {
    session.messages.push({ role: "tool", tool_call_id: toolCallId, name, content });
    this.touchSession(session);
  }

  upsertPlan(session: Session, plan: Plan): void {
    session.plan = plan;
    session.phase = session.phase === "practice" ? "practice" : "teach";
    const domain = session.topic;
    for (const node of plan.nodes) {
      this.upsertNode({
        id: node.id,
        name: node.title,
        statement: node.statement?.trim() || node.title,
        kind: node.kind ?? "definition",
        domain: node.domain ?? domain,
        sessionId: session.id,
      });
    }
    for (const edge of plan.edges) {
      this.addEdge({ from: edge.from, to: edge.to, type: "requires", sessionId: session.id });
    }
    this.touchSession(session);
  }

  upsertNode(input: {
    id: string;
    name: string;
    statement: string;
    kind: KnowledgeKind;
    domain: string;
    sessionId: string;
    sourcePath?: string;
    aliases?: string[];
  }): KnowledgeNode {
    const existing = this.data.nodes[input.id];
    if (existing) {
      existing.name = input.name || existing.name;
      existing.statement = input.statement || existing.statement;
      existing.kind = input.kind || existing.kind;
      existing.domain = input.domain || existing.domain;
      if (input.sessionId && !existing.sessionIds.includes(input.sessionId)) existing.sessionIds.push(input.sessionId);
      existing.sourcePaths ??= [];
      if (input.sourcePath && !existing.sourcePaths.includes(input.sourcePath)) existing.sourcePaths.push(input.sourcePath);
      if (input.aliases) {
        for (const alias of input.aliases) {
          if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
        }
      }
      existing.updatedAt = nowIso();
      this.bumpGraph();
      return existing;
    }
    const node: KnowledgeNode = {
      id: input.id,
      name: input.name,
      statement: input.statement,
      kind: input.kind,
      domain: input.domain,
      aliases: input.aliases ? [...input.aliases] : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sessionIds: input.sessionId ? [input.sessionId] : [],
      sourcePaths: input.sourcePath ? [input.sourcePath] : [],
    };
    this.data.nodes[input.id] = node;
    this.bumpGraph();
    return node;
  }

  addEdge(input: Omit<GraphEdge, "createdAt">): GraphEdge | null {
    if (input.from === input.to) return null;
    const exists = this.data.edges.some(
      (edge) => edge.from === input.from && edge.to === input.to && edge.type === input.type,
    );
    if (exists) return null;
    const edge: GraphEdge = { ...input, createdAt: nowIso() };
    this.data.edges.push(edge);
    this.bumpGraph();
    return edge;
  }

  addEvidence(input: {
    nodeId: string;
    sessionId: string;
    type: EvidenceType;
    result: EvidenceResult;
    confidence?: number;
    note?: string;
  }): Evidence {
    if (!this.data.nodes[input.nodeId]) {
      this.upsertNode({
        id: input.nodeId,
        name: input.nodeId,
        statement: input.nodeId,
        kind: "definition",
        domain: this.data.sessions[input.sessionId]?.topic ?? "Unknown",
        sessionId: input.sessionId,
      });
    }
    const evidence: Evidence = {
      id: uid("e"),
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      type: input.type,
      result: input.result,
      confidence: input.confidence,
      note: input.note,
      at: nowIso(),
    };
    this.data.evidence.push(evidence);
    this.bumpGraph();
    this.persist();
    return evidence;
  }

  evidenceFor(nodeId: string): Evidence[] {
    return this.data.evidence
      .filter((e) => e.nodeId === nodeId)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  strength(nodeId: string): NodeStrength {
    const evidence = this.evidenceFor(nodeId);
    if (evidence.length === 0) {
      return { overall: 0.12, recall: 0.12, explanation: 0.12, application: 0.12, calibration: null, count: 0, lastAt: null };
    }
    const groups: Record<"recall" | "explanation" | "application", number[]> = {
      recall: [],
      explanation: [],
      application: [],
    };
    const all: number[] = [];
    const calibration: number[] = [];
    for (const item of evidence) {
      const score = resultScore(item.result);
      all.push(score);
      groups[evidenceArea(item.type)].push(score);
      if (typeof item.confidence === "number" && item.result !== "unknown") {
        calibration.push(1 - Math.abs(item.confidence / 100 - score));
      }
    }
    const lastAt = evidence[0]?.at ?? null;
    const ageDays = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 86_400_000 : 0;
    const decay = ageDays > 60 ? 0.85 : ageDays > 30 ? 0.93 : 1;
    const overall = Math.max(0, Math.min(1, average(all) * decay));
    const fallback = overall;
    return {
      overall,
      recall: groups.recall.length ? average(groups.recall) : fallback,
      explanation: groups.explanation.length ? average(groups.explanation) : fallback,
      application: groups.application.length ? average(groups.application) : fallback,
      calibration: calibration.length ? average(calibration) : null,
      count: evidence.length,
      lastAt,
    };
  }


  mergeExtracted(input: {
    sourceId: string;
    sourcePath?: string;
    sessionId?: string;
    domain?: string;
    propositions: ExtractedProposition[];
    relations: ExtractedRelation[];
  }): { nodesCreated: number; nodesLinked: number; linksCreated: number } {
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const byStatement = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const node of Object.values(this.data.nodes)) {
      byStatement.set(normalize(node.statement), node.id);
      byName.set(normalize(node.name), node.id);
    }
    const uniqueId = (base: string): string => {
      let candidate = slugify(base);
      let counter = 2;
      while (this.data.nodes[candidate]) {
        candidate = `${slugify(base)}-${counter}`;
        counter++;
      }
      return candidate;
    };
    const local = new Map<string, string>();
    let nodesCreated = 0;
    let nodesLinked = 0;
    for (const prop of input.propositions) {
      const name = (prop.name || prop.statement || "").trim();
      const statement = (prop.statement || name).trim();
      if (!name || !statement) continue;
      const kindValue = prop.kind as KnowledgeKind;
      const kinds: KnowledgeKind[] = ["definition", "assumption", "theorem", "empirical", "heuristic", "procedure", "analogy", "application"];
      const kind = kinds.includes(kindValue) ? kindValue : "definition";
      const existingId =
        this.data.nodes[prop.id]?.id ??
        byStatement.get(normalize(statement)) ??
        byName.get(normalize(name));
      if (existingId && this.data.nodes[existingId]) {
        const node = this.data.nodes[existingId];
        node.sourcePaths ??= [];
        if (input.sourcePath && !node.sourcePaths.includes(input.sourcePath)) node.sourcePaths.push(input.sourcePath);
        if (input.sessionId && !node.sessionIds.includes(input.sessionId)) node.sessionIds.push(input.sessionId);
        if (name && normalize(name) !== normalize(node.name) && !node.aliases.includes(name)) node.aliases.push(name);
        if (statement && normalize(statement) !== normalize(node.statement) && !node.aliases.includes(statement)) node.aliases.push(statement);
        node.updatedAt = nowIso();
        local.set(prop.id, existingId);
        nodesLinked++;
        continue;
      }
      const id = uniqueId(name);
      this.data.nodes[id] = {
        id,
        name,
        statement,
        kind,
        domain: input.domain?.trim() || "Imported notes",
        aliases: prop.aliases ? [...prop.aliases] : [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        sessionIds: input.sessionId ? [input.sessionId] : [],
        sourcePaths: input.sourcePath ? [input.sourcePath] : [],
      };
      byStatement.set(normalize(statement), id);
      byName.set(normalize(name), id);
      local.set(prop.id, id);
      nodesCreated++;
    }
    let linksCreated = 0;
    for (const relation of input.relations) {
      const from = local.get(relation.from) ?? (this.data.nodes[relation.from] ? relation.from : undefined);
      const to = local.get(relation.to) ?? (this.data.nodes[relation.to] ? relation.to : undefined);
      if (!from || !to || from === to) continue;
      const type = relation.type === "related" ? "related" : "requires";
      const edge = this.addEdge({
        from,
        to,
        type,
        sessionId: input.sessionId ?? input.sourceId,
        sourceId: input.sourceId,
      });
      if (edge) linksCreated++;
    }
    if (nodesCreated > 0 || nodesLinked > 0 || linksCreated > 0) {
      this.bumpGraph();
      this.persist();
    }
    return { nodesCreated, nodesLinked, linksCreated };
  }

  nodes(): KnowledgeNode[] {
    return Object.values(this.data.nodes).sort((a, b) => a.name.localeCompare(b.name));
  }

  edges(): GraphEdge[] {
    return this.data.edges.filter((e) => this.data.nodes[e.from] && this.data.nodes[e.to]);
  }

  planStatus(session: Session): { current: string | null; visited: Set<string> } {
    const ids = new Set((session.plan?.nodes ?? []).map((n) => n.id));
    const runs: string[] = [];
    for (const message of session.messages) {
      if (message.role !== "assistant" || !message.tool_calls) continue;
      for (const call of message.tool_calls) {
        if (call.function.name !== "ask_learner") continue;
        try {
          const input = JSON.parse(call.function.arguments) as AskLearnerInput;
          if (input.nodeId && ids.has(input.nodeId) && runs.at(-1) !== input.nodeId) {
            runs.push(input.nodeId);
          }
        } catch {
          // ignore malformed historical calls
        }
      }
    }
    return {
      current: runs.at(-1) ?? null,
      visited: new Set(runs.slice(0, -1)),
    };
  }

  answerFor(session: Session, toolCallId: string): string | null {
    const result = session.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === toolCallId,
    );
    return result?.content ?? null;
  }
}
