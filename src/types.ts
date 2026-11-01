export type Intent =
  | "conceptual"
  | "exam"
  | "research"
  | "application"
  | "memorisation"
  | "maintenance";

export type SessionMode = "study" | "practice";
export type SessionStatus = "idle" | "running" | "waiting" | "done" | "error";
export type SessionPhase = "probe" | "plan" | "teach" | "practice" | "done";
export type KnowledgeKind =
  | "definition"
  | "assumption"
  | "theorem"
  | "empirical"
  | "heuristic"
  | "procedure"
  | "analogy"
  | "application";
export type EvidenceResult = "correct" | "partial" | "incorrect" | "unknown";
export type EvidenceType = "probe" | "predict" | "check" | "practice" | "explain" | "review";

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  defaultIntent: Intent;
  autoCards: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  maxTokens: 2400,
  temperature: 0.4,
  defaultIntent: "conceptual",
  autoCards: false,
};

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
}

export interface QuestionOption {
  label: string;
  value: string;
}

export interface AskLearnerInput {
  question: string;
  type: "probe" | "predict" | "check" | "practice" | "explain";
  nodeId?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  correctAnswer?: string | string[];
  referenceAnswer?: string;
  explanation?: string;
  details?: string;
}

export interface AskAnswer {
  answer?: string | string[];
  text?: string;
  confidence?: number;
  thinking?: string;
  correct?: boolean;
  dontKnow?: boolean;
  at: string;
}

export interface PendingQuestion {
  toolCallId: string;
  input: AskLearnerInput;
  createdAt: string;
}

export interface PlanNode {
  id: string;
  title: string;
  statement?: string;
  kind?: KnowledgeKind;
  domain?: string;
}

export interface PlanEdge {
  from: string;
  to: string;
}

export interface Plan {
  nodes: PlanNode[];
  edges: PlanEdge[];
  version: number;
}

export interface Session {
  id: string;
  title: string;
  topic: string;
  intent: Intent;
  mode: SessionMode;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  phase: SessionPhase;
  messages: LlmMessage[];
  plan?: Plan;
  pendingQuestion?: PendingQuestion;
  lastError?: string;
  focusNodeId?: string;
  summary?: string;
  keyPoints?: string[];
  graphExtraction?: {
    status: "running" | "done" | "error";
    at?: string;
    error?: string;
    nodes?: number;
    links?: number;
  };
}

export interface KnowledgeNode {
  id: string;
  name: string;
  statement: string;
  kind: KnowledgeKind;
  domain: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sourcePaths?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "requires" | "related";
  sessionId: string;
  sourceId?: string;
  createdAt: string;
}

export interface NoteSource {
  id: string;
  path: string;
  importedAt: string;
  status: "running" | "done" | "error";
  nodes?: number;
  links?: number;
  error?: string;
}

export interface ExtractedProposition {
  id: string;
  name: string;
  statement: string;
  kind: KnowledgeKind;
  aliases?: string[];
}

export interface ExtractedRelation {
  from: string;
  to: string;
  type: "requires" | "related";
}

export interface Evidence {
  id: string;
  nodeId: string;
  sessionId: string;
  type: EvidenceType;
  result: EvidenceResult;
  confidence?: number;
  note?: string;
  at: string;
}

export interface PluginData {
  version: number;
  settings: Settings;
  sessions: Record<string, Session>;
  nodes: Record<string, KnowledgeNode>;
  edges: GraphEdge[];
  evidence: Evidence[];
  noteSources: NoteSource[];
}

export const DATA_VERSION = 1;

export function emptyData(): PluginData {
  return {
    version: DATA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {},
    nodes: {},
    edges: [],
    evidence: [],
    noteSources: [],
  };
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "node";
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function intentLabel(intent: Intent): string {
  const map: Record<Intent, string> = {
    conceptual: "Conceptual understanding",
    exam: "Exam / cram",
    research: "Research",
    application: "Application",
    memorisation: "Memorisation",
    maintenance: "Maintenance",
  };
  return map[intent];
}

export function kindLabel(kind: KnowledgeKind): string {
  const map: Record<KnowledgeKind, string> = {
    definition: "Definition",
    assumption: "Assumption",
    theorem: "Theorem",
    empirical: "Empirical claim",
    heuristic: "Heuristic",
    procedure: "Procedure",
    analogy: "Analogy",
    application: "Application pattern",
  };
  return map[kind];
}

export function resultLabel(result: EvidenceResult): string {
  const map: Record<EvidenceResult, string> = {
    correct: "Correct",
    partial: "Partial",
    incorrect: "Incorrect",
    unknown: "Unknown",
  };
  return map[result];
}
