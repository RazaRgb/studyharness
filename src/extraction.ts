import { LlmClient, extractJson } from "./llm";
import type {
  ExtractedProposition,
  ExtractedRelation,
  KnowledgeKind,
  KnowledgeNode,
  Session,
  Settings,
} from "./types";

export interface ExtractionResult {
  propositions: ExtractedProposition[];
  relations: ExtractedRelation[];
}

const KINDS: KnowledgeKind[] = [
  "definition",
  "assumption",
  "theorem",
  "empirical",
  "heuristic",
  "procedure",
  "analogy",
  "application",
];

function existingGraphText(nodes: KnowledgeNode[]): string {
  return nodes
    .slice(0, 90)
    .map((n) => `- [${n.id}] ${n.name} — ${n.statement} (${n.kind})`)
    .join("\n");
}

function normalizeKind(value: unknown): KnowledgeKind {
  return typeof value === "string" && KINDS.includes(value as KnowledgeKind)
    ? (value as KnowledgeKind)
    : "definition";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function sessionExtractionText(session: Session): string {
  const answerFor = (callId: string): string => {
    const result = session.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
    if (!result?.content) return "";
    try {
      const raw = JSON.parse(result.content) as Record<string, unknown>;
      if (raw.dontKnow === true) return "I don't know.";
      if (typeof raw.text === "string") return raw.text;
      if (Array.isArray(raw.answer)) return raw.answer.join(", ");
      if (typeof raw.answer === "string") return raw.answer;
    } catch {
      return result.content.slice(0, 500);
    }
    return "";
  };
  const lines: string[] = [`TOPIC: ${session.topic}`, `INTENT: ${session.intent}`, `MODE: ${session.mode}`, ""];
  if (session.plan) {
    lines.push("PLAN:");
    for (const node of session.plan.nodes) {
      lines.push(`- [${node.id}] ${node.title} (${node.kind ?? "definition"}): ${node.statement ?? ""}`);
    }
    lines.push("");
  }
  for (const message of session.messages) {
    if (message.role === "user" && message.content) {
      lines.push(`LEARNER: ${message.content}`, "");
    } else if (message.role === "assistant") {
      if (message.content) lines.push(`TEACHER: ${message.content}`, "");
      for (const call of message.tool_calls ?? []) {
        if (call.function.name !== "ask_learner") continue;
        try {
          const args = JSON.parse(call.function.arguments) as { question?: string; type?: string; nodeId?: string };
          if (args.question) {
            lines.push(`QUESTION${args.nodeId ? ` [${args.nodeId}]` : ""}: ${args.question}`);
            const answer = answerFor(call.id);
            if (answer) lines.push(`LEARNER ANSWER: ${answer}`);
            lines.push("");
          }
        } catch {
          // ignore malformed historical call
        }
      }
    }
  }
  return lines.join("\n").slice(0, 32_000);
}

function extractionPrompt(input: {
  text: string;
  topic: string;
  sourceLabel: string;
  existing: KnowledgeNode[];
}): string {
  const existing = existingGraphText(input.existing);
  return `Extract a knowledge graph from the source below.

SOURCE: ${input.sourceLabel}
TOPIC: ${input.topic}

${existing ? `EXISTING GRAPH (reuse exact ids only when the proposition is genuinely the same):\n${existing}\n\n` : ""}Rules:
- Every proposition must be an objective, world-facing claim. Never write "the learner understands X" or "the teacher said X".
- A misconception enters as its true correction, not as a false proposition.
- Keep each statement self-contained and at full precision. The name is a short label, not a sentence.
- Use the epistemic kind: definition, assumption, theorem, empirical, heuristic, procedure, analogy, application.
- Relations are "requires" when the source must be understood before the target, and "related" for a useful non-prerequisite connection.
- Use local ids p1, p2, ... for new propositions. If a proposition is genuinely the same as an existing node, use that exact existing id.
- Only extract ideas actually supported by the source. Do not invent.
- If the source is thin or contains nothing graph-worthy, return empty arrays.

Return JSON only, with this shape:
{"propositions":[{"id":"p1","name":"Short label","statement":"Full proposition.","kind":"definition","aliases":["verbatim phrasing"]}],"relations":[{"from":"p1","to":"p2","type":"requires"}]}

SOURCE TEXT:
${input.text}`;
}

export async function extractKnowledge(
  client: LlmClient,
  settings: Settings,
  input: {
    text: string;
    topic: string;
    sourceLabel: string;
    existing: KnowledgeNode[];
  },
): Promise<ExtractionResult> {
  const result = await client.complete(
    [
      {
        role: "system",
        content:
          "You are a precise knowledge-graph extractor. Return only valid JSON. No prose, no code fences.",
      },
      { role: "user", content: extractionPrompt(input) },
    ],
    undefined,
    settings,
  );
  const parsed = extractJson<{
    propositions?: unknown;
    relations?: unknown;
    nodes?: unknown;
    edges?: unknown;
  }>(result.text);
  if (!parsed) throw new Error("The extraction model did not return valid JSON.");
  const rawProps = Array.isArray(parsed.propositions)
    ? parsed.propositions
    : Array.isArray(parsed.nodes)
      ? parsed.nodes
      : [];
  const rawRelations = Array.isArray(parsed.relations)
    ? parsed.relations
    : Array.isArray(parsed.edges)
      ? parsed.edges
      : [];
  const propositions: ExtractedProposition[] = [];
  for (const item of rawProps) {
    const p = (item ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : `p${propositions.length + 1}`;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const statement = typeof p.statement === "string" ? p.statement.trim() : "";
    if (!name || !statement) continue;
    propositions.push({
      id,
      name,
      statement,
      kind: normalizeKind(p.kind),
      aliases: stringList(p.aliases),
    });
  }
  const relations: ExtractedRelation[] = [];
  for (const item of rawRelations) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.from !== "string" || typeof r.to !== "string") continue;
    relations.push({
      from: r.from,
      to: r.to,
      type: r.type === "related" ? "related" : "requires",
    });
  }
  return { propositions, relations };
}
