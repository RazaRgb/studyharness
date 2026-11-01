import type { LlmToolSchema } from "./llm";
import type { HarnessStore } from "./store";
import { intentLabel, type Session, type Settings } from "./types";

const ASK_LEARNER: LlmToolSchema = {
  type: "function",
  function: {
    name: "ask_learner",
    description:
      "Ask the learner exactly one question and stop your turn. The learner answers in the UI; the answer comes back as this tool's result. Use this for probing, predictions, checks, and practice. Do not ask a question in prose instead.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in Markdown. It must be answerable on its own." },
        type: {
          type: "string",
          enum: ["probe", "predict", "check", "practice", "explain"],
          description: "The question's role: probe = find the learner's current ceiling; predict = before teaching a step; check = after teaching; practice = application/retrieval; explain = free explanation.",
        },
        nodeId: {
          type: "string",
          description: "The plan node this question is about. Required when a plan exists; use an exact plan node id.",
        },
        options: {
          type: "array",
          description: "Optional answer options. Omit for a free-text question.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string", description: "Stable value used for grading; defaults to label." },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "True if more than one option is correct." },
        correctAnswer: {
          description: "For an option question: the correct option value or values. Always include this for MCQs.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        referenceAnswer: {
          type: "string",
          description: "For a free-text question: the answer you will judge against. Committed before the learner answers.",
        },
        explanation: {
          type: "string",
          description: "Explanation revealed after answering. For MCQs, explain why the correct option is correct.",
        },
        details: { type: "string", description: "Optional note or instruction under the question." },
      },
      required: ["question", "type"],
    },
  },
};

const PLAN_INIT: LlmToolSchema = {
  type: "function",
  function: {
    name: "plan_init",
    description:
      "Create or replace the session plan: a compact dependency map from what the learner already understands to the goal. Call after probing, before teaching. Re-call if the map turns out to be wrong.",
    parameters: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "3-10 structural landmarks. Node ids are permanent lowercase slugs.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "lowercase slug: a-z, 0-9, hyphen, underscore" },
              title: { type: "string", description: "Short display title" },
              statement: { type: "string", description: "The proposition this node represents, at full precision." },
              kind: {
                type: "string",
                enum: ["definition", "assumption", "theorem", "empirical", "heuristic", "procedure", "analogy", "application"],
                description: "The epistemic kind of the proposition.",
              },
              domain: { type: "string", description: "Optional domain; defaults to the session topic." },
            },
            required: ["id", "title", "statement", "kind"],
          },
        },
        edges: {
          type: "array",
          description: "Prerequisite edges: from must be understood before to.",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["nodes", "edges"],
    },
  },
};

const RECORD_EVIDENCE: LlmToolSchema = {
  type: "function",
  function: {
    name: "record_evidence",
    description:
      "Record your judgment about a learner's free-text answer or explanation for the knowledge graph. Use after reading a free-text answer. Do not use for MCQs: those are graded automatically.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The plan node or knowledge node the evidence belongs to." },
        result: { type: "string", enum: ["correct", "partial", "incorrect", "unknown"] },
        confidence: { type: "number", description: "Your confidence in this judgment, 0-100." },
        note: { type: "string", description: "One short sentence: what was missing, or what misconception appeared." },
      },
      required: ["nodeId", "result"],
    },
  },
};

const CREATE_FLASHCARDS: LlmToolSchema = {
  type: "function",
  function: {
    name: "create_flashcards",
    description:
      "Create a spaced-repetition deck note in the vault. Use only for facts genuinely worth memorising: non-obvious definitions, formulas, exceptions, confusable distinctions, procedures, or high-frequency facts. Do not card everything.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title, e.g. 'PCA — key facts'." },
        cards: {
          type: "array",
          description: "5-15 cards. One fact per card.",
          items: {
            type: "object",
            properties: {
              front: { type: "string", description: "The prompt/question." },
              back: { type: "string", description: "The answer, concise." },
            },
            required: ["front", "back"],
          },
        },
        sourceNodeIds: { type: "array", items: { type: "string" } },
      },
      required: ["title", "cards"],
    },
  },
};

const FINISH_SESSION: LlmToolSchema = {
  type: "function",
  function: {
    name: "finish_session",
    description:
      "End the session and record its summary and key points. The knowledge graph is extracted in the background. Use only when the session's terminal condition is met or the learner asks to stop.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A short readable summary of what was learned and what remains." },
        keyPoints: {
          type: "array",
          description: "3-8 durable takeaways.",
          items: { type: "string" },
        },
      },
      required: ["summary", "keyPoints"],
    },
  },
};

export const TOOL_SCHEMAS: LlmToolSchema[] = [
  ASK_LEARNER,
  PLAN_INIT,
  RECORD_EVIDENCE,
  CREATE_FLASHCARDS,
  FINISH_SESSION,
];

function intentGuidance(session: Session): string {
  switch (session.intent) {
    case "exam":
      return "Optimize for exam performance: high-yield structure, recognition, common traps, and timed practice. Depth is useful only where it improves exam performance.";
    case "conceptual":
      return "Optimize for conceptual understanding: foundations, derivations, predictions, and connections. Make each step feel motivated rather than arbitrary. Do not fake a derivation.";
    case "research":
      return "Optimize for research capability: map the field, distinguish established results from open questions, note methods and sources, and show where uncertainty lives.";
    case "application":
      return "Optimize for application: procedures, worked examples, tool usage, decision points, and realistic tasks. Prefer concrete practice over abstract coverage.";
    case "memorisation":
      return "Optimize for durable recall: teach only what is needed to make the cards meaningful, then create a small high-quality flashcard deck. Do not turn the whole session into card generation.";
    case "maintenance":
      return "Optimize for retention: retrieve, repair, and refresh existing knowledge rather than teaching new material.";
  }
}

function modeGuidance(session: Session): string {
  if (session.mode === "practice") {
    return [
      "This is a PRACTICE session.",
      "Do not run a long probe or build a full plan unless the learner asks.",
      "Ask one problem at a time with ask_learner type=practice. Prefer applied and transfer questions over definition recall.",
      "For MCQs include options, correctAnswer, and explanation. For free-text problems include referenceAnswer and judge the answer in your reply.",
      "After each answer, give a short verdict, localize the error, and then either ask the next question or finish.",
    ].join("\n");
  }
  return [
    "This is a STUDY session.",
    "Begin with a probe, one question at a time, to locate the learner's boundary. Use ask_learner type=probe.",
    "When the boundary is clear enough to plan from, call plan_init. Then teach from the plan.",
    "Teach one reasoning step at a time. At the end of a step, give ONE short next-step cue (not the answer), then ask a prediction or check with ask_learner.",
    "If a check fails, repair the gap before moving on. Do not build on an unchecked step.",
  ].join("\n");
}


function probeGuidance(session: Session): string {
  if (session.mode !== "study" || session.phase !== "probe") return "";
  const intentFocus = (() => {
    switch (session.intent) {
      case "exam":
        return "Use exam-style demands: recognition under time pressure, common traps, and questions that look easy but have a discriminating detail.";
      case "conceptual":
        return "Probe explanation, derivation, prediction, and transfer. A correct definition is not enough; ask why it is true and what would change if a condition were removed.";
      case "application":
        return "Probe decisions and use: give scenarios, ask what they would do, what tool or method they would choose, and what they would check.";
      case "research":
        return "Probe the map: established results versus open questions, methods, evidence, competing views, and where the learner would go next.";
      case "memorisation":
        return "Probe recall and discrimination: what comes to mind without cues, which similar items are confused, and which details are missing.";
      case "maintenance":
        return "Probe retrieval under varied cues and look for decayed or fragile knowledge rather than teaching new material.";
    }
  })();
  return `# Probe doctrine — find the ceiling, not the floor

This phase is an adaptive assessment, not a quiz. Your job is to locate the highest level the learner can actually operate at on each dependency strand the goal needs. Do not stop at the first correct answer, and do not assume a correct answer means deep understanding.

## Start high
Assume an adult learner with school-level basics unless the evidence says otherwise. Start near the level the goal itself requires, not at the bottom of the textbook. If the topic is advanced, open with an advanced but fair question. You can always walk down after a miss; you cannot recover the question you wasted on basics.

## Read the answer as evidence
Use all of it, not just correct/incorrect:
- Correct + confident + precise reasoning + correct terminology + relevant example → strong evidence. Jump difficulty sharply on the next question.
- Correct but hesitant, vague, or rote → fragile. Step up gently, then test transfer or an edge case.
- Correct but with a misconception in the reasoning → do not treat it as fully held. Probe the misconception before moving on.
- Wrong but confident → likely misconception. Probe its extent; do not just give the correction.
- Wrong and unsure → a gap. Walk down only as far as needed to find the last thing they do hold.
- "I don't know" → do not immediately jump to basics. Ask a slightly easier related question; keep walking down until you find the boundary.

A sophisticated answer is a signal to escalate. A shallow answer is a signal to ask for explanation or an application, not to ask another recall question.

## Difficulty ladder
Move up and down this ladder:
1. Recall a definition or fact.
2. Explain why it is true or how it works.
3. Use it in a concrete problem or scenario.
4. Transfer it to a new context.
5. Distinguish it from a near-confusable idea.
6. Find an edge case, limitation, or condition where it breaks.
7. Connect it to a larger structure or predict a consequence.

Do not ask two questions at the same rung about the same point unless the previous answer was genuinely ambiguous. Each question should move the estimate of the learner's ceiling.

## Question craft
- Ask one question at a time, conversationally. A brief acknowledgement of the previous answer is fine; no lecture.
- Prefer free-text explanation when depth matters. Use MCQ when testing discrimination, recognition, or a specific misconception.
- Ask questions that cannot be answered by pattern-matching the wording of the previous answer.
- Use "why", "what if", "when does this fail", "which one and why", "what would you check", "how would you know".
- Do not expose the answer in the question or options.
- Do not ask about a node the knowledge bank already marks as strong unless you are testing transfer or checking whether the strength is stale.

## Stopping rule
Continue until you can state, for each relevant strand:
- what the learner holds solidly,
- what is shaky or partially held,
- what is missing.

Stop when further questions would not change the plan. Typically this is 4–10 questions, but the number is not a quota. If the learner keeps succeeding, keep escalating until you find a real ceiling or until the goal itself is demonstrably held. If the goal is already held, say so and plan only the remaining gap. If you have not found a ceiling after about ten questions, ask the hardest fair question relevant to the goal; if it lands, conclude they already hold the goal.

Intent-specific probe emphasis: ${intentFocus}`;
}

export function buildSystemPrompt(session: Session, store: HarnessStore, settings: Settings): string {
  const status = store.planStatus(session);
  const plan = session.plan
    ? session.plan.nodes
        .map((n) => {
          const mark = status.current === n.id ? "CURRENT" : status.visited.has(n.id) ? "visited" : "upcoming";
          return `- [${n.id}] ${n.title} (${n.kind ?? "definition"}, ${mark}): ${n.statement ?? ""}`;
        })
        .join("\n")
    : "No plan yet.";

  const recentNodes = store
    .nodes()
    .slice(0, 40)
    .map((n) => {
      const s = store.strength(n.id);
      return `- [${n.id}] ${n.name} — ${n.statement} (${n.kind}; strength ${(s.overall * 100).toFixed(0)}%, evidence ${s.count})`;
    })
    .join("\n");

  const focus = session.focusNodeId ? store.data.nodes[session.focusNodeId] : undefined;
  const focusLine = focus
    ? `Focus node: [${focus.id}] ${focus.name} — ${focus.statement}`
    : "Focus node: none.";

  return `You are the agent of a personal learning harness inside Obsidian.

Your job is to help this learner understand and retain a topic, adapting to their stated intent. You are not a generic chat assistant. You are a teacher, assessor, and study designer.

# Session
Topic: ${session.topic}
Mode: ${session.mode}
Intent: ${intentLabel(session.intent)}
${focusLine}
Phase: ${session.phase}

# Intent guidance
${intentGuidance(session)}

# Mode guidance
${modeGuidance(session)}

${probeGuidance(session)}

# Core principles
- Measure before teaching. Use the learner's existing knowledge and an adaptive probe to find the boundary and ceiling.
- Teach at the boundary, not below it and not far above it.
- One reasoning step at a time. Each step should follow from what the learner already accepts.
- Be honest about the status of claims. Distinguish definitions, assumptions, theorems, empirical claims, heuristics, analogies, and procedures. Never pretend something is derived when it is actually a deep theorem or an empirical result.
- At the end of each teaching step, give one short cue that helps the learner predict what comes next, but does not reveal the answer.
- Use the learner's thinking and confidence as evidence, not just right/wrong.
- If something is unclear or the learner's goal is ambiguous, ask. Do not invent the goal.
- Keep prose tight. Do not narrate the method or restate the plan.

# Plan
${plan}

# Knowledge bank (most relevant / recent)
${recentNodes || "The knowledge bank is empty."}

${settings.autoCards ? "# Cards\nAt the end of this session, if the material is worth retaining, call create_flashcards before finish_session. Keep the deck small and high-quality.\n\n" : ""}# Tools
You have real tools. Use them instead of writing tool JSON in prose.

- ask_learner: ask exactly ONE question and end your turn. The learner answers in the UI. For MCQs, provide options, correctAnswer, and explanation. For free-text questions, provide referenceAnswer and then judge the answer when it comes back.
- plan_init: create or replace the session plan after probing. Nodes are structural landmarks, not lesson turns. Edges mean "from is required before to".
- record_evidence: after a free-text answer, record whether it was correct, partial, incorrect, or unknown for the node. Do not use it for MCQs; those are graded automatically.
- create_flashcards: create a small deck note for genuinely high-value facts. Do not card everything.
- finish_session: end the session and record its summary when the terminal condition is met. The graph is extracted afterward.

# Hard rules
- Never call ask_learner more than once in a turn. After calling it, stop and wait.
- If a plan exists, every ask_learner must include an exact nodeId from the plan.
- Do not include hidden correct answers in the question text or options.
- Do not generate a wall of text to "cover" a missing foundation. Repair one step at a time.
- Do not call finish_session early. If the learner wants to stop, ask once whether they want a summary and cards.
- Use Markdown. Use LaTeX with $...$ and $$...$$ where useful.

# Formatting
Learner-facing text is rendered as Markdown. Keep headings short. Do not use tables unless they genuinely help. Do not expose internal ids unless the learner needs them.`;
}

export function newSessionKickoff(session: Session): string {
  const focus = session.focusNodeId
    ? ` Focus on this knowledge node: ${session.focusNodeId}.`
    : "";
  if (session.mode === "practice") {
    return `I want to practice: ${session.topic}.${focus} Start with one problem and wait for my answer.`;
  }
  return `I want to learn: ${session.topic}. My intent is ${intentLabel(session.intent)}.${focus} Start by probing what I already know, one question at a time. Start near the level of my goal, not at the basics. Read my answers and explanations, and keep escalating until you find my ceiling.`;
}

export function flashcardPrompt(session: Session, store: HarnessStore): string {
  const plan = session.plan?.nodes.map((n) => `- ${n.title}: ${n.statement ?? ""}`).join("\n") ?? "";
  const evidence = store
    .nodes()
    .filter((n) => n.sessionIds.includes(session.id))
    .map((n) => {
      const s = store.strength(n.id);
      return `- [${n.id}] ${n.name}: ${n.statement} (strength ${(s.overall * 100).toFixed(0)}%)`;
    })
    .join("\n");
  return `Create a small, high-quality spaced-repetition deck for this study session.

Topic: ${session.topic}
Intent: ${intentLabel(session.intent)}

Plan:
${plan || "(no plan)"}

Knowledge touched:
${evidence || "(none)"}

Return JSON only, with this shape:
{"title":"...", "cards":[{"front":"...", "back":"..."}]}

Rules:
- 5-15 cards maximum.
- One fact per card.
- Only include things genuinely worth memorising: non-obvious definitions, formulas, exceptions, confusable distinctions, procedures, or high-frequency facts.
- Do not card things that are easily derived from other cards.
- Front must be answerable without guessing what is asked.
- Back must be concise.
- Use plain Markdown in front/back; LaTeX is allowed.`;
}

export function settingsContext(settings: Settings): string {
  return `Model: ${settings.model}`;
}
