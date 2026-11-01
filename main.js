"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => StudyHarnessPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");

// src/llm.ts
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
function endpoint(settings) {
  const base = settings.baseUrl.trim().replace(/\/+$/, "");
  return new URL(`${base}/chat/completions`);
}
function requestOptions(url, settings) {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
      "HTTP-Referer": "https://obsidian.md",
      "X-Title": "Study Harness"
    }
  };
}
function jsonBody(req) {
  const body = {
    model: req.settings.model,
    messages: req.messages.map(stripMessage),
    stream: req.stream,
    temperature: req.settings.temperature,
    max_tokens: req.settings.maxTokens
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = "auto";
  }
  return JSON.stringify(body);
}
function stripMessage(message) {
  const out = { role: message.role, content: message.content };
  if (message.tool_calls?.length) out.tool_calls = message.tool_calls;
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.name) out.name = message.name;
  return out;
}
async function readError(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
  }
  return text.slice(0, 1200) || `HTTP ${res.statusCode ?? 0}`;
}
function parseToolCalls(raw, accum) {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    const index = typeof item.index === "number" ? item.index : accum.size;
    const existing = accum.get(index) ?? {
      id: "",
      type: "function",
      function: { name: "", arguments: "" }
    };
    if (typeof item.id === "string" && item.id) existing.id = item.id;
    const fn = item.function;
    if (fn) {
      if (typeof fn.name === "string" && fn.name && !existing.function.name) existing.function.name = fn.name;
      if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
    }
    accum.set(index, existing);
  }
}
function parseContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).join("");
  }
  return "";
}
function streamChat(req, callbacks) {
  const url = endpoint(req.settings);
  const transport = url.protocol === "http:" ? http : https;
  const body = jsonBody(req);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(requestOptions(url, req.settings), (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        void readError(res).then((message) => finish(() => reject(new Error(message)))).catch((err) => finish(() => reject(err)));
        return;
      }
      let buffer = "";
      let text = "";
      let reasoning = "";
      const toolCalls = /* @__PURE__ */ new Map();
      let finishReason;
      let usage;
      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) return false;
        if (!trimmed.startsWith("data:")) return false;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return true;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return false;
        }
        if (parsed.usage) usage = parsed.usage;
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0) return false;
        const choice = choices[0];
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice.delta ?? choice.message;
        if (!delta) return false;
        const content = parseContent(delta.content);
        if (content) {
          text += content;
          callbacks.onText?.(content);
        }
        const thinking = typeof delta.reasoning === "string" && delta.reasoning || typeof delta.reasoning_content === "string" && delta.reasoning_content || typeof delta.thinking === "string" && delta.thinking || "";
        if (thinking) {
          reasoning += thinking;
          callbacks.onReasoning?.(thinking);
        }
        parseToolCalls(delta.tool_calls, toolCalls);
        return false;
      };
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            if (handleLine(line)) {
              finish(() => resolve({ text, reasoning, toolCalls: [...toolCalls.values()], finishReason, usage }));
              res.destroy();
              return;
            }
          } catch (err) {
            finish(() => reject(err));
            res.destroy();
            return;
          }
          newline = buffer.indexOf("\n");
        }
      });
      res.on("end", () => {
        if (buffer.trim()) handleLine(buffer);
        finish(() => resolve({ text, reasoning, toolCalls: [...toolCalls.values()], finishReason, usage }));
      });
      res.on("error", (err) => finish(() => reject(err)));
    });
    const abort = () => {
      request.destroy(new Error("Request aborted"));
    };
    if (req.signal?.aborted) {
      finish(() => reject(new Error("Request aborted")));
      return;
    }
    req.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (err) => finish(() => reject(err)));
    request.write(body);
    request.end();
  });
}
function completeChat(req) {
  const url = endpoint(req.settings);
  const transport = url.protocol === "http:" ? http : https;
  const body = jsonBody({ ...req, stream: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(requestOptions(url, req.settings), (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        void readError(res).then((message) => finish(() => reject(new Error(message)))).catch((err) => finish(() => reject(err)));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const choice = parsed.choices?.[0];
          const message = choice?.message;
          const toolCalls = /* @__PURE__ */ new Map();
          parseToolCalls(message?.tool_calls, toolCalls);
          finish(
            () => resolve({
              text: parseContent(message?.content),
              reasoning: typeof message?.reasoning === "string" ? message.reasoning : "",
              toolCalls: [...toolCalls.values()],
              finishReason: choice?.finish_reason,
              usage: parsed.usage
            })
          );
        } catch (err) {
          finish(() => reject(err));
        }
      });
      res.on("error", (err) => finish(() => reject(err)));
    });
    const abort = () => request.destroy(new Error("Request aborted"));
    if (req.signal?.aborted) {
      finish(() => reject(new Error("Request aborted")));
      return;
    }
    req.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (err) => finish(() => reject(err)));
    request.write(body);
    request.end();
  });
}
var LlmClient = class {
  stream(messages, tools, settings, callbacks, signal) {
    return streamChat({ messages, tools, stream: true, settings, signal }, callbacks);
  }
  complete(messages, tools, settings, signal) {
    return completeChat({ messages, tools, stream: false, settings, signal });
  }
};
function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// src/types.ts
var DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  maxTokens: 2400,
  temperature: 0.4,
  defaultIntent: "conceptual",
  autoCards: false
};
var DATA_VERSION = 1;
function emptyData() {
  return {
    version: DATA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {},
    nodes: {},
    edges: [],
    evidence: [],
    noteSources: []
  };
}
function slugify(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "node";
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function intentLabel(intent) {
  const map = {
    conceptual: "Conceptual understanding",
    exam: "Exam / cram",
    research: "Research",
    application: "Application",
    memorisation: "Memorisation",
    maintenance: "Maintenance"
  };
  return map[intent];
}
function kindLabel(kind) {
  const map = {
    definition: "Definition",
    assumption: "Assumption",
    theorem: "Theorem",
    empirical: "Empirical claim",
    heuristic: "Heuristic",
    procedure: "Procedure",
    analogy: "Analogy",
    application: "Application pattern"
  };
  return map[kind];
}

// src/prompts.ts
var ASK_LEARNER = {
  type: "function",
  function: {
    name: "ask_learner",
    description: "Ask the learner exactly one question and stop your turn. The learner answers in the UI; the answer comes back as this tool's result. Use this for probing, predictions, checks, and practice. Do not ask a question in prose instead.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in Markdown. It must be answerable on its own." },
        type: {
          type: "string",
          enum: ["probe", "predict", "check", "practice", "explain"],
          description: "The question's role: probe = find the learner's current ceiling; predict = before teaching a step; check = after teaching; practice = application/retrieval; explain = free explanation."
        },
        nodeId: {
          type: "string",
          description: "The plan node this question is about. Required when a plan exists; use an exact plan node id."
        },
        options: {
          type: "array",
          description: "Optional answer options. Omit for a free-text question.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string", description: "Stable value used for grading; defaults to label." }
            },
            required: ["label"]
          }
        },
        multiSelect: { type: "boolean", description: "True if more than one option is correct." },
        correctAnswer: {
          description: "For an option question: the correct option value or values. Always include this for MCQs.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
        },
        referenceAnswer: {
          type: "string",
          description: "For a free-text question: the answer you will judge against. Committed before the learner answers."
        },
        explanation: {
          type: "string",
          description: "Explanation revealed after answering. For MCQs, explain why the correct option is correct."
        },
        details: { type: "string", description: "Optional note or instruction under the question." }
      },
      required: ["question", "type"]
    }
  }
};
var PLAN_INIT = {
  type: "function",
  function: {
    name: "plan_init",
    description: "Create or replace the session plan: a compact dependency map from what the learner already understands to the goal. Call after probing, before teaching. Re-call if the map turns out to be wrong.",
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
                description: "The epistemic kind of the proposition."
              },
              domain: { type: "string", description: "Optional domain; defaults to the session topic." }
            },
            required: ["id", "title", "statement", "kind"]
          }
        },
        edges: {
          type: "array",
          description: "Prerequisite edges: from must be understood before to.",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" }
            },
            required: ["from", "to"]
          }
        }
      },
      required: ["nodes", "edges"]
    }
  }
};
var RECORD_EVIDENCE = {
  type: "function",
  function: {
    name: "record_evidence",
    description: "Record your judgment about a learner's free-text answer or explanation for the knowledge graph. Use after reading a free-text answer. Do not use for MCQs: those are graded automatically.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The plan node or knowledge node the evidence belongs to." },
        result: { type: "string", enum: ["correct", "partial", "incorrect", "unknown"] },
        confidence: { type: "number", description: "Your confidence in this judgment, 0-100." },
        note: { type: "string", description: "One short sentence: what was missing, or what misconception appeared." }
      },
      required: ["nodeId", "result"]
    }
  }
};
var CREATE_FLASHCARDS = {
  type: "function",
  function: {
    name: "create_flashcards",
    description: "Create a spaced-repetition deck note in the vault. Use only for facts genuinely worth memorising: non-obvious definitions, formulas, exceptions, confusable distinctions, procedures, or high-frequency facts. Do not card everything.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title, e.g. 'PCA \u2014 key facts'." },
        cards: {
          type: "array",
          description: "5-15 cards. One fact per card.",
          items: {
            type: "object",
            properties: {
              front: { type: "string", description: "The prompt/question." },
              back: { type: "string", description: "The answer, concise." }
            },
            required: ["front", "back"]
          }
        },
        sourceNodeIds: { type: "array", items: { type: "string" } }
      },
      required: ["title", "cards"]
    }
  }
};
var FINISH_SESSION = {
  type: "function",
  function: {
    name: "finish_session",
    description: "End the session and record its summary and key points. The knowledge graph is extracted in the background. Use only when the session's terminal condition is met or the learner asks to stop.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A short readable summary of what was learned and what remains." },
        keyPoints: {
          type: "array",
          description: "3-8 durable takeaways.",
          items: { type: "string" }
        }
      },
      required: ["summary", "keyPoints"]
    }
  }
};
var TOOL_SCHEMAS = [
  ASK_LEARNER,
  PLAN_INIT,
  RECORD_EVIDENCE,
  CREATE_FLASHCARDS,
  FINISH_SESSION
];
function intentGuidance(session) {
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
function modeGuidance(session) {
  if (session.mode === "practice") {
    return [
      "This is a PRACTICE session.",
      "Do not run a long probe or build a full plan unless the learner asks.",
      "Ask one problem at a time with ask_learner type=practice. Prefer applied and transfer questions over definition recall.",
      "For MCQs include options, correctAnswer, and explanation. For free-text problems include referenceAnswer and judge the answer in your reply.",
      "After each answer, give a short verdict, localize the error, and then either ask the next question or finish."
    ].join("\n");
  }
  return [
    "This is a STUDY session.",
    "Begin with a probe, one question at a time, to locate the learner's boundary. Use ask_learner type=probe.",
    "When the boundary is clear enough to plan from, call plan_init. Then teach from the plan.",
    "Teach one reasoning step at a time. At the end of a step, give ONE short next-step cue (not the answer), then ask a prediction or check with ask_learner.",
    "If a check fails, repair the gap before moving on. Do not build on an unchecked step."
  ].join("\n");
}
function probeGuidance(session) {
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
  return `# Probe doctrine \u2014 find the ceiling, not the floor

This phase is an adaptive assessment, not a quiz. Your job is to locate the highest level the learner can actually operate at on each dependency strand the goal needs. Do not stop at the first correct answer, and do not assume a correct answer means deep understanding.

## Start high
Assume an adult learner with school-level basics unless the evidence says otherwise. Start near the level the goal itself requires, not at the bottom of the textbook. If the topic is advanced, open with an advanced but fair question. You can always walk down after a miss; you cannot recover the question you wasted on basics.

## Read the answer as evidence
Use all of it, not just correct/incorrect:
- Correct + confident + precise reasoning + correct terminology + relevant example \u2192 strong evidence. Jump difficulty sharply on the next question.
- Correct but hesitant, vague, or rote \u2192 fragile. Step up gently, then test transfer or an edge case.
- Correct but with a misconception in the reasoning \u2192 do not treat it as fully held. Probe the misconception before moving on.
- Wrong but confident \u2192 likely misconception. Probe its extent; do not just give the correction.
- Wrong and unsure \u2192 a gap. Walk down only as far as needed to find the last thing they do hold.
- "I don't know" \u2192 do not immediately jump to basics. Ask a slightly easier related question; keep walking down until you find the boundary.

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

Stop when further questions would not change the plan. Typically this is 4\u201310 questions, but the number is not a quota. If the learner keeps succeeding, keep escalating until you find a real ceiling or until the goal itself is demonstrably held. If the goal is already held, say so and plan only the remaining gap. If you have not found a ceiling after about ten questions, ask the hardest fair question relevant to the goal; if it lands, conclude they already hold the goal.

Intent-specific probe emphasis: ${intentFocus}`;
}
function buildSystemPrompt(session, store, settings) {
  const status = store.planStatus(session);
  const plan = session.plan ? session.plan.nodes.map((n) => {
    const mark = status.current === n.id ? "CURRENT" : status.visited.has(n.id) ? "visited" : "upcoming";
    return `- [${n.id}] ${n.title} (${n.kind ?? "definition"}, ${mark}): ${n.statement ?? ""}`;
  }).join("\n") : "No plan yet.";
  const recentNodes = store.nodes().slice(0, 40).map((n) => {
    const s = store.strength(n.id);
    return `- [${n.id}] ${n.name} \u2014 ${n.statement} (${n.kind}; strength ${(s.overall * 100).toFixed(0)}%, evidence ${s.count})`;
  }).join("\n");
  const focus = session.focusNodeId ? store.data.nodes[session.focusNodeId] : void 0;
  const focusLine = focus ? `Focus node: [${focus.id}] ${focus.name} \u2014 ${focus.statement}` : "Focus node: none.";
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
function newSessionKickoff(session) {
  const focus = session.focusNodeId ? ` Focus on this knowledge node: ${session.focusNodeId}.` : "";
  if (session.mode === "practice") {
    return `I want to practice: ${session.topic}.${focus} Start with one problem and wait for my answer.`;
  }
  return `I want to learn: ${session.topic}. My intent is ${intentLabel(session.intent)}.${focus} Start by probing what I already know, one question at a time. Start near the level of my goal, not at the basics. Read my answers and explanations, and keep escalating until you find my ceiling.`;
}
function flashcardPrompt(session, store) {
  const plan = session.plan?.nodes.map((n) => `- ${n.title}: ${n.statement ?? ""}`).join("\n") ?? "";
  const evidence = store.nodes().filter((n) => n.sessionIds.includes(session.id)).map((n) => {
    const s = store.strength(n.id);
    return `- [${n.id}] ${n.name}: ${n.statement} (strength ${(s.overall * 100).toFixed(0)}%)`;
  }).join("\n");
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

// src/extraction.ts
var KINDS = [
  "definition",
  "assumption",
  "theorem",
  "empirical",
  "heuristic",
  "procedure",
  "analogy",
  "application"
];
function existingGraphText(nodes) {
  return nodes.slice(0, 90).map((n) => `- [${n.id}] ${n.name} \u2014 ${n.statement} (${n.kind})`).join("\n");
}
function normalizeKind(value) {
  return typeof value === "string" && KINDS.includes(value) ? value : "definition";
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function sessionExtractionText(session) {
  const answerFor = (callId) => {
    const result = session.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
    if (!result?.content) return "";
    try {
      const raw = JSON.parse(result.content);
      if (raw.dontKnow === true) return "I don't know.";
      if (typeof raw.text === "string") return raw.text;
      if (Array.isArray(raw.answer)) return raw.answer.join(", ");
      if (typeof raw.answer === "string") return raw.answer;
    } catch {
      return result.content.slice(0, 500);
    }
    return "";
  };
  const lines = [`TOPIC: ${session.topic}`, `INTENT: ${session.intent}`, `MODE: ${session.mode}`, ""];
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
          const args = JSON.parse(call.function.arguments);
          if (args.question) {
            lines.push(`QUESTION${args.nodeId ? ` [${args.nodeId}]` : ""}: ${args.question}`);
            const answer = answerFor(call.id);
            if (answer) lines.push(`LEARNER ANSWER: ${answer}`);
            lines.push("");
          }
        } catch {
        }
      }
    }
  }
  return lines.join("\n").slice(0, 32e3);
}
function extractionPrompt(input) {
  const existing = existingGraphText(input.existing);
  return `Extract a knowledge graph from the source below.

SOURCE: ${input.sourceLabel}
TOPIC: ${input.topic}

${existing ? `EXISTING GRAPH (reuse exact ids only when the proposition is genuinely the same):
${existing}

` : ""}Rules:
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
async function extractKnowledge(client, settings, input) {
  const result = await client.complete(
    [
      {
        role: "system",
        content: "You are a precise knowledge-graph extractor. Return only valid JSON. No prose, no code fences."
      },
      { role: "user", content: extractionPrompt(input) }
    ],
    void 0,
    settings
  );
  const parsed = extractJson(result.text);
  if (!parsed) throw new Error("The extraction model did not return valid JSON.");
  const rawProps = Array.isArray(parsed.propositions) ? parsed.propositions : Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : Array.isArray(parsed.edges) ? parsed.edges : [];
  const propositions = [];
  for (const item of rawProps) {
    const p = item ?? {};
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : `p${propositions.length + 1}`;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const statement = typeof p.statement === "string" ? p.statement.trim() : "";
    if (!name || !statement) continue;
    propositions.push({
      id,
      name,
      statement,
      kind: normalizeKind(p.kind),
      aliases: stringList(p.aliases)
    });
  }
  const relations = [];
  for (const item of rawRelations) {
    const r = item ?? {};
    if (typeof r.from !== "string" || typeof r.to !== "string") continue;
    relations.push({
      from: r.from,
      to: r.to,
      type: r.type === "related" ? "related" : "requires"
    });
  }
  return { propositions, relations };
}

// src/engine.ts
var MAX_STEPS = 10;
function safeJson(value) {
  return JSON.stringify(value);
}
function parseArgs(call) {
  try {
    const parsed = JSON.parse(call.function.arguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return {};
}
function slug(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "node";
}
function validatePlan(raw) {
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawNodes.length < 1 || rawNodes.length > 20) {
    return { error: "plan_init needs between 1 and 20 nodes." };
  }
  const nodes = rawNodes.map((item) => {
    const n = item ?? {};
    const id = slug(typeof n.id === "string" ? n.id : "");
    const title = typeof n.title === "string" ? n.title.trim() : id;
    const statement = typeof n.statement === "string" ? n.statement.trim() : title;
    const kindValue = typeof n.kind === "string" ? n.kind : "definition";
    const kinds = ["definition", "assumption", "theorem", "empirical", "heuristic", "procedure", "analogy", "application"];
    const kind = kinds.includes(kindValue) ? kindValue : "definition";
    const domain = typeof n.domain === "string" ? n.domain.trim() : void 0;
    return { id, title, statement, kind, domain };
  });
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) return { error: "plan_init has duplicate node ids." };
  const edges = [];
  for (const item of rawEdges) {
    const e = item ?? {};
    const from = typeof e.from === "string" ? slug(e.from) : "";
    const to = typeof e.to === "string" ? slug(e.to) : "";
    if (!ids.has(from) || !ids.has(to)) return { error: `plan_init edge ${from} -> ${to} references an unknown node.` };
    if (from === to) return { error: "plan_init has a self-loop edge." };
    if (!edges.some((x) => x.from === from && x.to === to)) edges.push({ from, to });
  }
  const adj = /* @__PURE__ */ new Map();
  for (const e of edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const hasCycle = (id) => {
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
function normalizeCorrect(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}
function gradeAnswer(input, answer) {
  if (!input.options || input.options.length === 0) return void 0;
  const correct = normalizeCorrect(input.correctAnswer);
  if (correct.length === 0) return void 0;
  const selected = Array.isArray(answer.answer) ? answer.answer : answer.answer ? [answer.answer] : [];
  if (selected.length === 0) return false;
  if (input.multiSelect) {
    const a = [...new Set(selected)].sort();
    const b = [...new Set(correct)].sort();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return selected.length === 1 && selected[0] === correct[0];
}
var HarnessEngine = class {
  host;
  llm = new LlmClient();
  running = /* @__PURE__ */ new Set();
  aborts = /* @__PURE__ */ new Map();
  live = /* @__PURE__ */ new Map();
  constructor(host) {
    this.host = host;
  }
  isRunning(sessionId) {
    return this.running.has(sessionId);
  }
  liveText(sessionId) {
    return this.live.get(sessionId) ?? { text: "", reasoning: "" };
  }
  async startSession(sessionId) {
    const session = this.host.store.getSession(sessionId);
    if (!session || session.messages.length > 0) return;
    this.host.store.addUserMessage(session, newSessionKickoff(session));
    await this.runLoop(session);
  }
  async sendMessage(sessionId, text) {
    const session = this.host.store.getSession(sessionId);
    if (!session || !text.trim()) return;
    if (session.pendingQuestion) return;
    this.host.store.addUserMessage(session, text.trim());
    await this.runLoop(session);
  }
  async submitAnswer(sessionId, answer) {
    const session = this.host.store.getSession(sessionId);
    if (!session?.pendingQuestion) return;
    const pending = session.pendingQuestion;
    const input = pending.input;
    const correct = answer.dontKnow ? void 0 : gradeAnswer(input, answer);
    const evidenceType = input.type === "explain" ? "explain" : input.type;
    if (input.nodeId) {
      const result = answer.dontKnow ? "unknown" : correct === void 0 ? null : correct ? "correct" : "incorrect";
      if (result) {
        this.host.store.addEvidence({
          nodeId: input.nodeId,
          sessionId: session.id,
          type: evidenceType,
          result,
          confidence: answer.confidence,
          note: answer.thinking?.slice(0, 240)
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
      explanation: input.explanation ?? null
    };
    this.host.store.addToolMessage(session, pending.toolCallId, "ask_learner", safeJson(payload));
    this.host.store.setPending(session, void 0);
    session.status = "idle";
    this.host.store.touchSession(session);
    this.host.notify();
    await this.runLoop(session);
  }
  stop(sessionId) {
    this.aborts.get(sessionId)?.abort();
  }
  stopAll() {
    for (const id of this.running) this.aborts.get(id)?.abort();
  }
  async generateFlashcards(sessionId) {
    const session = this.host.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add an API key in Study Harness settings first.");
    const result = await this.llm.complete(
      [
        { role: "system", content: "You are a precise flashcard author. Return JSON only, no prose." },
        { role: "user", content: flashcardPrompt(session, this.host.store) }
      ],
      void 0,
      settings
    );
    const parsed = extractJson(result.text);
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error("The model did not return a valid flashcard deck.");
    }
    const cards = parsed.cards.map((c) => ({ front: (c.front ?? "").trim(), back: (c.back ?? "").trim() })).filter((c) => c.front && c.back).slice(0, 20);
    if (cards.length === 0) throw new Error("The model returned empty cards.");
    return this.host.writeFlashcardDeck({
      session,
      title: (parsed.title ?? `${session.topic} \u2014 key facts`).trim(),
      cards,
      sourceNodeIds: session.plan?.nodes.map((n) => n.id)
    });
  }
  async extractSessionGraph(sessionId, force = false) {
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
        existing: this.host.store.nodes()
      });
      const stats = this.host.store.mergeExtracted({
        sourceId: session.id,
        sessionId: session.id,
        domain: session.topic,
        propositions: result.propositions,
        relations: result.relations
      });
      session.graphExtraction = {
        status: "done",
        at: nowIso(),
        nodes: stats.nodesCreated + stats.nodesLinked,
        links: stats.linksCreated
      };
      this.host.store.touchSession(session);
      this.host.notify();
      return { nodes: stats.nodesCreated + stats.nodesLinked, links: stats.linksCreated };
    } catch (err) {
      session.graphExtraction = {
        status: "error",
        at: nowIso(),
        error: err instanceof Error ? err.message : String(err)
      };
      this.host.store.touchSession(session);
      this.host.notify();
      throw err;
    }
  }
  async importNotes(notes, domain, onProgress) {
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add an API key in Study Harness settings first.");
    const out = [];
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const source = this.host.store.addNoteSource(note.path);
      onProgress?.(`Extracting ${i + 1}/${notes.length}: ${note.path}`);
      try {
        if (!note.text.trim()) throw new Error("Note is empty.");
        const result = await extractKnowledge(this.llm, settings, {
          text: note.text.slice(0, 28e3),
          topic: domain,
          sourceLabel: note.path,
          existing: this.host.store.nodes()
        });
        const stats = this.host.store.mergeExtracted({
          sourceId: source.id,
          sourcePath: note.path,
          domain,
          propositions: result.propositions,
          relations: result.relations
        });
        this.host.store.updateNoteSource(source.id, {
          status: "done",
          nodes: stats.nodesCreated + stats.nodesLinked,
          links: stats.linksCreated,
          importedAt: nowIso()
        });
        out.push({ path: note.path, ok: true, nodes: stats.nodesCreated + stats.nodesLinked, links: stats.linksCreated });
      } catch (err) {
        this.host.store.updateNoteSource(source.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          importedAt: nowIso()
        });
        out.push({ path: note.path, ok: false, nodes: 0, links: 0, error: err instanceof Error ? err.message : String(err) });
      }
      this.host.notify();
    }
    return out;
  }
  async runLoop(session) {
    if (this.running.has(session.id)) return;
    const settings = this.host.getSettings();
    if (!settings.apiKey.trim()) {
      this.host.store.failTurn(session, "No API key configured. Open Settings \u2192 Study Harness.");
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
        const messages = [
          { role: "system", content: buildSystemPrompt(session, this.host.store, settings) },
          ...session.messages
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
            }
          },
          controller.signal
        );
        const toolCalls = result.toolCalls.map((call, index) => ({
          ...call,
          id: call.id || `call_${Date.now().toString(36)}_${index}`
        }));
        const assistant = {
          role: "assistant",
          content: result.text.trim() ? result.text : null,
          ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
          ...result.reasoning.trim() ? { reasoning: result.reasoning } : {}
        };
        if (assistant.content || assistant.tool_calls?.length) {
          this.host.store.addAssistantMessage(session, assistant);
        }
        this.live.set(session.id, { text: "", reasoning: "" });
        if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
          session.status = "idle";
          break;
        }
        let pending;
        let executed = 0;
        for (const call of assistant.tool_calls) {
          const execution = await this.executeTool(session, call);
          if (execution.stopForQuestion) {
            if (pending) {
              this.host.store.addToolMessage(
                session,
                call.id,
                call.function.name,
                safeJson({ ok: false, error: "only one ask_learner call is allowed per turn; this question was not posed" })
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
          session.phase = session.plan ? session.mode === "practice" ? "practice" : "teach" : session.phase;
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
  async executeTool(session, call) {
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
      const nodeId = typeof args.nodeId === "string" ? args.nodeId : void 0;
      if (session.plan && !nodeId) {
        return { content: safeJson({ ok: false, error: "nodeId is required when a plan exists" }) };
      }
      if (nodeId && session.plan && !session.plan.nodes.some((n) => n.id === nodeId)) {
        return { content: safeJson({ ok: false, error: `unknown nodeId ${nodeId}; use an exact node id` }) };
      }
      const options = Array.isArray(args.options) ? args.options.map((o) => {
        const item = o ?? {};
        const label = typeof item.label === "string" ? item.label.trim() : "";
        const value = typeof item.value === "string" ? item.value.trim() : label;
        return label ? { label, value } : null;
      }).filter((o) => o !== null) : void 0;
      if (options && options.length > 0 && options.length < 2) {
        return { content: safeJson({ ok: false, error: "an option question needs at least 2 options" }) };
      }
      const correctAnswer = args.correctAnswer;
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
      const input = {
        question,
        type,
        nodeId,
        options,
        multiSelect: args.multiSelect === true,
        correctAnswer,
        referenceAnswer: typeof args.referenceAnswer === "string" ? args.referenceAnswer : void 0,
        explanation: typeof args.explanation === "string" ? args.explanation : void 0,
        details: typeof args.details === "string" ? args.details : void 0
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
          note: "Plan saved. Every later ask_learner must include one of these nodeIds."
        })
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
        result,
        confidence: typeof args.confidence === "number" ? args.confidence : void 0,
        note: typeof args.note === "string" ? args.note : void 0
      });
      return { content: safeJson({ ok: true }) };
    }
    if (name === "create_flashcards") {
      const cards = Array.isArray(args.cards) ? args.cards.map((c) => {
        const item = c ?? {};
        return {
          front: typeof item.front === "string" ? item.front.trim() : "",
          back: typeof item.back === "string" ? item.back.trim() : ""
        };
      }).filter((c) => c.front && c.back) : [];
      if (cards.length === 0) return { content: safeJson({ ok: false, error: "cards is empty" }) };
      const title = typeof args.title === "string" ? args.title.trim() : `${session.topic} \u2014 key facts`;
      try {
        const path = await this.host.writeFlashcardDeck({
          session,
          title,
          cards,
          sourceNodeIds: session.plan?.nodes.map((n) => n.id)
        });
        this.host.notify();
        return { content: safeJson({ ok: true, path, note: `Deck written to ${path}.` }) };
      } catch (err) {
        return { content: safeJson({ ok: false, error: `could not write deck: ${err instanceof Error ? err.message : String(err)}` }) };
      }
    }
    if (name === "finish_session") {
      session.summary = typeof args.summary === "string" ? args.summary : "";
      session.keyPoints = Array.isArray(args.keyPoints) ? args.keyPoints.filter((v) => typeof v === "string") : [];
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
};

// src/graph-view.ts
var import_obsidian = require("obsidian");
var VIEW_TYPE_GRAPH = "study-harness-graph";
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function layout(nodes, edges) {
  if (nodes.length === 0) return [];
  const n = nodes.length;
  const degree = /* @__PURE__ */ new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const positions = /* @__PURE__ */ new Map();
  const radius = Math.max(160, n * 28);
  nodes.forEach((node, i) => {
    const angle = i / n * Math.PI * 2;
    positions.set(node.id, {
      x: Math.cos(angle) * radius + hash(node.id) % 20 - 10,
      y: Math.sin(angle) * radius + hash(node.id + "y") % 20 - 10
    });
  });
  const k = Math.max(70, Math.sqrt(900 * 900 / Math.max(1, n)));
  for (let iteration = 0; iteration < 180; iteration++) {
    const forces = /* @__PURE__ */ new Map();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = positions.get(nodes[i].id);
        const b = positions.get(nodes[j].id);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        if (dist < 0.01) {
          dx = hash(nodes[i].id) % 100 / 100 - 0.5;
          dy = hash(nodes[j].id) % 100 / 100 - 0.5;
          dist = 0.1;
        }
        const force = k * k / dist;
        const fx = dx / dist * force;
        const fy = dy / dist * force;
        const fa = forces.get(nodes[i].id);
        const fb = forces.get(nodes[j].id);
        fa.x += fx;
        fa.y += fy;
        fb.x -= fx;
        fb.y -= fy;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = dist * dist / k;
      const fx = dx / dist * force;
      const fy = dy / dist * force;
      const fa = forces.get(edge.from);
      const fb = forces.get(edge.to);
      fa.x += fx;
      fa.y += fy;
      fb.x -= fx;
      fb.y -= fy;
    }
    for (const node of nodes) {
      const p = positions.get(node.id);
      const f = forces.get(node.id);
      const cooling = 1 - iteration / 220;
      p.x += f.x * 1e-3 * cooling;
      p.y += f.y * 1e-3 * cooling;
      p.x += (0 - p.x) * 8e-4;
      p.y += (0 - p.y) * 8e-4;
    }
  }
  return nodes.map((node) => {
    const p = positions.get(node.id);
    const d = degree.get(node.id) ?? 0;
    return {
      ...p,
      node,
      degree: d,
      radius: 7 + Math.min(16, Math.sqrt(d) * 4)
    };
  });
}
function resolveColor(value, fallback) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = trimmed;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
}
var GraphView = class extends import_obsidian.ItemView {
  plugin;
  canvasEl;
  wrapEl;
  detailEl;
  searchEl;
  statsEl;
  nodes = [];
  edges = [];
  selectedId = null;
  transform = { x: 0, y: 0, k: 1 };
  fitOnce = true;
  dragging = false;
  dragStart = null;
  dragOrigin = null;
  resizeObserver = null;
  query = "";
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_GRAPH;
  }
  getDisplayText() {
    return "Knowledge graph";
  }
  getIcon() {
    return "network";
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("sh-graph-view");
    this.build();
    this.fitOnce = true;
    this.refresh();
    this.resizeObserver = new ResizeObserver(() => {
      this.fitOnce = true;
      this.draw();
    });
    this.resizeObserver.observe(this.wrapEl);
  }
  async onClose() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }
  build() {
    const header = this.contentEl.createDiv({ cls: "sh-graph-header" });
    const titleWrap = header.createDiv({ cls: "sh-graph-title-wrap" });
    titleWrap.createDiv({ cls: "sh-graph-title", text: "Knowledge graph" });
    this.statsEl = titleWrap.createDiv({ cls: "sh-graph-stats" });
    const searchWrap = header.createDiv({ cls: "sh-graph-search" });
    (0, import_obsidian.setIcon)(searchWrap.createSpan({ cls: "sh-search-icon" }), "search");
    this.searchEl = searchWrap.createEl("input", {
      attr: { type: "search", placeholder: "Search nodes\u2026", "aria-label": "Search knowledge nodes" }
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.draw();
    });
    const importBtn = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Import notes into knowledge graph" }
    });
    (0, import_obsidian.setIcon)(importBtn, "upload");
    importBtn.addEventListener("click", () => this.plugin.openNotesImport());
    const fit = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Fit graph to view" }
    });
    (0, import_obsidian.setIcon)(fit, "maximize");
    fit.addEventListener("click", () => {
      this.fitOnce = true;
      this.draw();
    });
    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Refresh graph" }
    });
    (0, import_obsidian.setIcon)(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.refresh());
    const body = this.contentEl.createDiv({ cls: "sh-graph-body" });
    this.wrapEl = body.createDiv({ cls: "sh-graph-canvas-wrap" });
    this.canvasEl = this.wrapEl.createEl("canvas", { cls: "sh-graph-canvas" });
    this.detailEl = body.createDiv({ cls: "sh-graph-detail" });
    this.canvasEl.addEventListener("mousedown", (event) => {
      this.dragging = true;
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragOrigin = { ...this.transform };
      this.canvasEl.addClass("is-dragging");
    });
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvasEl.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvasEl.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const old = this.transform;
      const worldX = (mx - old.x) / old.k;
      const worldY = (my - old.y) / old.k;
      const nextK = Math.min(3.2, Math.max(0.2, old.k * (event.deltaY < 0 ? 1.12 : 0.89)));
      this.transform = { k: nextK, x: mx - worldX * nextK, y: my - worldY * nextK };
      this.draw();
    }, { passive: false });
    this.canvasEl.addEventListener("click", (event) => {
      if (this.dragStart && (Math.abs(event.clientX - this.dragStart.x) > 4 || Math.abs(event.clientY - this.dragStart.y) > 4)) return;
      const hit = this.hitTest(event);
      this.selectedId = hit?.node.id ?? null;
      this.renderDetail();
      this.draw();
    });
    this.registerDomEvent(this.canvasEl, "dblclick", () => {
      this.fitOnce = true;
      this.draw();
    });
  }
  onMouseMove = (event) => {
    if (!this.dragging || !this.dragStart || !this.dragOrigin) return;
    this.transform = {
      k: this.dragOrigin.k,
      x: this.dragOrigin.x + (event.clientX - this.dragStart.x),
      y: this.dragOrigin.y + (event.clientY - this.dragStart.y)
    };
    this.draw();
  };
  onMouseUp = () => {
    this.dragging = false;
    this.canvasEl.removeClass("is-dragging");
    window.setTimeout(() => {
      this.dragStart = null;
      this.dragOrigin = null;
    }, 0);
  };
  selectNode(nodeId) {
    this.selectedId = nodeId;
    this.renderDetail();
    this.draw();
  }
  refresh() {
    const nodes = this.plugin.store.nodes();
    const edges = this.plugin.store.edges();
    this.nodes = layout(nodes, edges);
    this.edges = edges;
    this.statsEl.setText(`${nodes.length} propositions \xB7 ${edges.length} links \xB7 ${this.plugin.store.data.evidence.length} evidence \xB7 ${this.plugin.store.data.noteSources.length} note imports`);
    if (!this.selectedId && nodes.length > 0) this.selectedId = nodes[0].id;
    this.renderDetail();
    this.draw();
  }
  resizeCanvas() {
    const rect = this.wrapEl.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (this.canvasEl.width !== targetW || this.canvasEl.height !== targetH) {
      this.canvasEl.width = targetW;
      this.canvasEl.height = targetH;
      this.canvasEl.style.width = `${width}px`;
      this.canvasEl.style.height = `${height}px`;
    }
    return { width, height, dpr };
  }
  fit(width, height) {
    if (this.nodes.length === 0) {
      this.transform = { x: width / 2, y: height / 2, k: 1 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.radius - 50);
      minY = Math.min(minY, n.y - n.radius - 30);
      maxX = Math.max(maxX, n.x + n.radius + 50);
      maxY = Math.max(maxY, n.y + n.radius + 30);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = Math.min(1.6, Math.max(0.2, Math.min((width - 60) / w, (height - 60) / h)));
    this.transform = {
      k,
      x: width / 2 - (minX + maxX) / 2 * k,
      y: height / 2 - (minY + maxY) / 2 * k
    };
  }
  draw() {
    if (!this.canvasEl) return;
    const { width, height, dpr } = this.resizeCanvas();
    if (this.fitOnce) {
      this.fit(width, height);
      this.fitOnce = false;
    }
    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = resolveColor(getComputedStyle(document.body).getPropertyValue("--background-primary"), "#1e1e1e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.k, this.transform.k);
    const edgeColor = resolveColor(getComputedStyle(document.body).getPropertyValue("--background-modifier-border"), "#444");
    const textColor = resolveColor(getComputedStyle(document.body).getPropertyValue("--text-normal"), "#ddd");
    const accent = resolveColor(getComputedStyle(document.body).getPropertyValue("--interactive-accent"), "#7c9cff");
    const nodeById = new Map(this.nodes.map((n) => [n.node.id, n]));
    for (const edge of this.edges) {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.strokeStyle = edgeColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2 / this.transform.k;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const ex = b.x - Math.cos(angle) * (b.radius + 2);
      const ey = b.y - Math.sin(angle) * (b.radius + 2);
      const size = 5 / this.transform.k;
      ctx.beginPath();
      ctx.fillStyle = edgeColor;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(angle - 0.45) * size, ey - Math.sin(angle - 0.45) * size);
      ctx.lineTo(ex - Math.cos(angle + 0.45) * size, ey - Math.sin(angle + 0.45) * size);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const item of this.nodes) {
      const { node } = item;
      const strength = this.plugin.store.strength(node.id);
      const hue = hash(node.domain) % 360;
      const lightness = 38 + strength.overall * 28;
      const matches = !this.query || node.name.toLowerCase().includes(this.query) || node.statement.toLowerCase().includes(this.query);
      ctx.globalAlpha = matches ? 1 : 0.16;
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue} 55% ${lightness}%)`;
      ctx.fill();
      if (this.selectedId === node.id) {
        ctx.lineWidth = 3 / this.transform.k;
        ctx.strokeStyle = accent;
        ctx.stroke();
      } else {
        ctx.lineWidth = 1.2 / this.transform.k;
        ctx.strokeStyle = bg;
        ctx.stroke();
      }
      const label = node.name.length > 34 ? `${node.name.slice(0, 32)}\u2026` : node.name;
      ctx.font = `${Math.max(9, 11 / this.transform.k)}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = textColor;
      ctx.fillText(label, item.x, item.y + item.radius + 5 / this.transform.k);
    }
    ctx.restore();
  }
  hitTest(event) {
    const rect = this.canvasEl.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const wx = (mx - this.transform.x) / this.transform.k;
    const wy = (my - this.transform.y) / this.transform.k;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= (n.radius + 5) * (n.radius + 5)) return n;
    }
    return null;
  }
  renderDetail() {
    this.detailEl.empty();
    const node = this.selectedId ? this.plugin.store.data.nodes[this.selectedId] : void 0;
    if (!node) {
      this.detailEl.createDiv({ cls: "sh-empty", text: "Select a node to inspect it." });
      return;
    }
    const strength = this.plugin.store.strength(node.id);
    const header = this.detailEl.createDiv({ cls: "sh-detail-header" });
    header.createDiv({ cls: "sh-detail-title", text: node.name });
    header.createDiv({ cls: "sh-detail-kind", text: kindLabel(node.kind) });
    this.detailEl.createEl("p", { cls: "sh-detail-statement", text: node.statement });
    const bars = this.detailEl.createDiv({ cls: "sh-strength-bars" });
    for (const [label, value] of [
      ["Overall", strength.overall],
      ["Recall", strength.recall],
      ["Explanation", strength.explanation],
      ["Application", strength.application]
    ]) {
      const row = bars.createDiv({ cls: "sh-strength-row" });
      row.createSpan({ cls: "sh-strength-label", text: label });
      const track = row.createDiv({ cls: "sh-strength-track" });
      const fill = track.createDiv({ cls: "sh-strength-fill" });
      fill.style.width = `${Math.round(value * 100)}%`;
      row.createSpan({ cls: "sh-strength-value", text: `${Math.round(value * 100)}%` });
    }
    if (strength.calibration !== null) {
      const row = bars.createDiv({ cls: "sh-strength-row" });
      row.createSpan({ cls: "sh-strength-label", text: "Calibration" });
      const track = row.createDiv({ cls: "sh-strength-track" });
      const fill = track.createDiv({ cls: "sh-strength-fill sh-calibration" });
      fill.style.width = `${Math.round(strength.calibration * 100)}%`;
      row.createSpan({ cls: "sh-strength-value", text: `${Math.round(strength.calibration * 100)}%` });
    }
    const meta = this.detailEl.createDiv({ cls: "sh-detail-meta" });
    meta.createDiv({ text: `Evidence: ${strength.count}` });
    meta.createDiv({ text: `Domain: ${node.domain}` });
    meta.createDiv({ text: `Sessions: ${node.sessionIds.length}` });
    if (strength.lastAt) meta.createDiv({ text: `Last tested: ${new Date(strength.lastAt).toLocaleDateString()}` });
    const actions = this.detailEl.createDiv({ cls: "sh-detail-actions" });
    const study = actions.createEl("button", { cls: "mod-cta", text: "Study this", attr: { type: "button" } });
    study.addEventListener("click", () => {
      void this.plugin.startSessionForNode(node.id, "conceptual", "study");
    });
    const practice = actions.createEl("button", { text: "Practice this", attr: { type: "button" } });
    practice.addEventListener("click", () => {
      void this.plugin.startSessionForNode(node.id, "application", "practice");
    });
    const evidence = this.plugin.store.evidenceFor(node.id).slice(0, 8);
    if (evidence.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Recent evidence" });
      const list = this.detailEl.createDiv({ cls: "sh-evidence-list" });
      for (const e of evidence) {
        const row = list.createDiv({ cls: "sh-evidence-row" });
        row.createSpan({ cls: `sh-evidence-result is-${e.result}`, text: e.result });
        row.createSpan({ cls: "sh-evidence-type", text: e.type });
        if (typeof e.confidence === "number") row.createSpan({ cls: "sh-evidence-confidence", text: `${e.confidence}%` });
        if (e.note) row.createSpan({ cls: "sh-evidence-note", text: e.note });
        row.createSpan({ cls: "sh-evidence-date", text: new Date(e.at).toLocaleDateString() });
      }
    }
    const sources = node.sessionIds.map((id) => this.plugin.store.getSession(id)).filter((s) => s !== null).slice(0, 5);
    if (sources.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Source sessions" });
      const list = this.detailEl.createDiv({ cls: "sh-source-list" });
      for (const s of sources) {
        const link = list.createEl("a", { cls: "sh-source-link", text: s.title });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void this.plugin.openSession(s.id);
        });
      }
    }
    const sourcePaths = node.sourcePaths ?? [];
    if (sourcePaths.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Source notes" });
      const list = this.detailEl.createDiv({ cls: "sh-source-list" });
      for (const path of sourcePaths.slice(0, 8)) {
        const link = list.createEl("a", { cls: "sh-source-link", text: path });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void this.app.workspace.openLinkText(path, "", false);
        });
      }
    }
  }
};

// src/session-view.ts
var import_obsidian2 = require("obsidian");
var VIEW_TYPE_SESSION = "study-harness-session";
var INTENTS = ["conceptual", "exam", "research", "application", "memorisation", "maintenance"];
var MODES = ["study", "practice"];
function parseToolArgs(call) {
  try {
    const parsed = JSON.parse(call.function.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseAsk(call) {
  const args = parseToolArgs(call);
  if (typeof args.question !== "string") return null;
  const options = Array.isArray(args.options) ? args.options.map((o) => {
    const item = o ?? {};
    const label = typeof item.label === "string" ? item.label : "";
    const value = typeof item.value === "string" ? item.value : label;
    return label ? { label, value } : null;
  }).filter((o) => o !== null) : void 0;
  return {
    question: args.question,
    type: typeof args.type === "string" ? args.type : "check",
    nodeId: typeof args.nodeId === "string" ? args.nodeId : void 0,
    options,
    multiSelect: args.multiSelect === true,
    correctAnswer: args.correctAnswer,
    referenceAnswer: typeof args.referenceAnswer === "string" ? args.referenceAnswer : void 0,
    explanation: typeof args.explanation === "string" ? args.explanation : void 0,
    details: typeof args.details === "string" ? args.details : void 0
  };
}
function answerFrom(session, callId) {
  const message = session.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  if (!message?.content) return null;
  try {
    const raw = JSON.parse(message.content);
    return {
      raw,
      answer: raw.answer,
      text: typeof raw.text === "string" ? raw.text : void 0,
      confidence: typeof raw.confidence === "number" ? raw.confidence : void 0,
      thinking: typeof raw.thinking === "string" ? raw.thinking : void 0,
      correct: typeof raw.correct === "boolean" ? raw.correct : void 0,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch {
    return null;
  }
}
var SessionView = class extends import_obsidian2.ItemView {
  plugin;
  rootEl;
  transcriptEl;
  liveEl = null;
  planEl;
  composerEl;
  sendEl;
  lastKey = "";
  renderChain = Promise.resolve();
  renderQueued = false;
  draftComposer = "";
  draftTopic = "";
  draftIntent;
  draftMode = "study";
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.draftIntent = plugin.config.defaultIntent;
  }
  getViewType() {
    return VIEW_TYPE_SESSION;
  }
  getDisplayText() {
    const session = this.plugin.activeSessionId ? this.plugin.store.getSession(this.plugin.activeSessionId) : null;
    return session?.title || "Study session";
  }
  getIcon() {
    return "graduation-cap";
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("sh-session-view");
    this.addAction("history", "Open sessions panel", () => void this.plugin.openSessionsPanel());
    this.addAction("network", "Open knowledge graph", () => void this.plugin.openGraph());
    this.addAction("layers", "Generate flashcards", () => {
      if (this.plugin.activeSessionId) void this.plugin.generateFlashcards(this.plugin.activeSessionId);
      else new import_obsidian2.Notice("Open a session first.");
    });
    this.addAction("plus", "New session", () => {
      this.plugin.activeSessionId = null;
      this.lastKey = "";
      void this.refresh();
    });
    this.addAction("upload", "Import notes into knowledge graph", () => this.plugin.openNotesImport());
    await this.refresh();
  }
  async refresh() {
    this.renderQueued = true;
    this.renderChain = this.renderChain.then(async () => {
      if (!this.renderQueued) return;
      this.renderQueued = false;
      await this.renderOnce();
    }).catch((err) => console.error("Study Harness: session render failed", err));
    return this.renderChain;
  }
  async renderOnce() {
    const session = this.plugin.activeSessionId ? this.plugin.store.getSession(this.plugin.activeSessionId) : null;
    const key = session ? [
      session.id,
      session.title,
      session.messages.length,
      session.status,
      session.pendingQuestion?.toolCallId ?? "",
      session.plan?.version ?? 0,
      session.lastError ?? "",
      session.phase,
      session.summary ?? ""
    ].join("|") : "new";
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
  renderNewSession() {
    const wrap = this.rootEl.createDiv({ cls: "sh-new-session" });
    const card = wrap.createDiv({ cls: "sh-new-card" });
    card.createEl("h2", { text: "Start a study session" });
    card.createEl("p", {
      cls: "sh-muted",
      text: "Choose what you want to learn and why. The harness will probe your boundary, plan a path, and teach one step at a time."
    });
    const topic = card.createEl("input", {
      cls: "sh-topic-input",
      attr: { type: "text", placeholder: "What do you want to learn?", "aria-label": "Topic" }
    });
    topic.value = this.draftTopic;
    topic.addEventListener("input", () => {
      this.draftTopic = topic.value;
    });
    const intentRow = card.createDiv({ cls: "sh-choice-row" });
    intentRow.createDiv({ cls: "sh-choice-label", text: "Intent" });
    const intentSelect = intentRow.createEl("select", { cls: "dropdown" });
    for (const intent of INTENTS) {
      const option = intentSelect.createEl("option", { text: intentLabel(intent) });
      option.value = intent;
      if (intent === this.draftIntent) option.selected = true;
    }
    intentSelect.addEventListener("change", () => {
      this.draftIntent = intentSelect.value;
    });
    const modeRow = card.createDiv({ cls: "sh-choice-row" });
    modeRow.createDiv({ cls: "sh-choice-label", text: "Mode" });
    const modeSelect = modeRow.createEl("select", { cls: "dropdown" });
    for (const mode of MODES) {
      const option = modeSelect.createEl("option", { text: mode === "study" ? "Study / teach" : "Practice" });
      option.value = mode;
      if (mode === this.draftMode) option.selected = true;
    }
    modeSelect.addEventListener("change", () => {
      this.draftMode = modeSelect.value;
    });
    const recent = this.plugin.store.listSessions().slice(0, 5);
    if (recent.length > 0) {
      card.createDiv({ cls: "sh-section-label", text: "Continue a session" });
      const list = card.createDiv({ cls: "sh-recent-list" });
      for (const session of recent) {
        const row = list.createDiv({ cls: "sh-recent-row" });
        row.createDiv({ cls: "sh-recent-title", text: session.title });
        row.createDiv({ cls: "sh-recent-meta", text: `${session.phase} \xB7 ${new Date(session.updatedAt).toLocaleDateString()}` });
        row.addEventListener("click", () => void this.plugin.openSession(session.id));
      }
    }
    const footer = card.createDiv({ cls: "sh-new-actions" });
    const start = footer.createEl("button", { cls: "mod-cta", text: "Start", attr: { type: "button" } });
    start.addEventListener("click", () => {
      const value = this.draftTopic.trim();
      if (!value) {
        new import_obsidian2.Notice("Give the session a topic first.");
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
  async renderPlan(session) {
    this.planEl.empty();
    const summary = this.planEl.createDiv({ cls: "sh-session-summary" });
    const intent = summary.createDiv({ cls: "sh-pill", text: intentLabel(session.intent) });
    intent.addClass(`is-${session.intent}`);
    if (session.mode === "practice") summary.createDiv({ cls: "sh-pill is-practice", text: "Practice" });
    summary.createDiv({ cls: "sh-session-summary-meta", text: `${session.phase} \xB7 ${session.status}` });
    this.planEl.createDiv({ cls: "sh-panel-title", text: "Plan" });
    if (!session.plan) {
      this.planEl.createDiv({ cls: "sh-empty-small", text: session.mode === "practice" ? "Practice session \u2014 no plan yet." : "The plan appears after probing." });
      return;
    }
    const status = this.plugin.store.planStatus(session);
    const nodes = this.planEl.createDiv({ cls: "sh-plan-nodes" });
    for (const node of session.plan.nodes) {
      const row = nodes.createDiv({ cls: "sh-plan-node" });
      if (status.current === node.id) row.addClass("is-current");
      else if (status.visited.has(node.id)) row.addClass("is-visited");
      const dot = row.createSpan({ cls: "sh-plan-dot" });
      dot.setText(status.current === node.id ? "\u25CF" : status.visited.has(node.id) ? "\u2713" : "\u25CB");
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
  async renderTranscript(session) {
    this.transcriptEl.empty();
    this.liveEl = null;
    for (const message of session.messages) {
      if (message.role === "user") {
        const block = this.transcriptEl.createDiv({ cls: "sh-learner-block" });
        block.createDiv({ cls: "sh-block-kicker", text: "You" });
        const body = block.createDiv({ cls: "sh-markdown" });
        await import_obsidian2.MarkdownRenderer.render(this.app, message.content ?? "", body, "", this);
        continue;
      }
      if (message.role === "assistant") {
        if (message.content) {
          const block = this.transcriptEl.createDiv({ cls: "sh-teacher-block" });
          block.createDiv({ cls: "sh-block-kicker", text: "Teacher" });
          const body = block.createDiv({ cls: "sh-markdown" });
          await import_obsidian2.MarkdownRenderer.render(this.app, message.content, body, "", this);
        }
        for (const call of message.tool_calls ?? []) {
          await this.renderToolCall(session, call);
        }
      }
    }
    if (session.status === "running") {
      this.liveEl = this.transcriptEl.createDiv({ cls: "sh-teacher-block sh-live-block" });
      this.liveEl.createDiv({ cls: "sh-block-kicker", text: "Teacher" });
      this.liveEl.createDiv({ cls: "sh-markdown sh-live-text", text: "Thinking\u2026" });
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
        block.createEl("p", { cls: "sh-muted", text: "Updating the knowledge graph in the background\u2026" });
      } else if (session.graphExtraction?.status === "done") {
        block.createEl("p", {
          cls: "sh-muted",
          text: `Graph updated: ${session.graphExtraction.nodes ?? 0} nodes, ${session.graphExtraction.links ?? 0} links.`
        });
      } else if (session.graphExtraction?.status === "error") {
        block.createEl("p", {
          cls: "sh-error-text",
          text: `Graph extraction failed: ${session.graphExtraction.error ?? "unknown error"}`
        });
      } else {
        block.createEl("p", { cls: "sh-muted", text: "Open the knowledge graph to see what was added." });
      }
      if (session.graphExtraction?.status !== "running") {
        const extract = block.createEl("button", {
          cls: "sh-ghost",
          text: session.graphExtraction?.status === "done" ? "Re-extract graph" : "Extract graph now",
          attr: { type: "button" }
        });
        extract.addEventListener("click", () => void this.plugin.extractCurrentSession());
      }
    }
    if (this.transcriptEl.childElementCount === 0) {
      this.transcriptEl.createDiv({ cls: "sh-empty", text: "The teacher will begin shortly." });
    }
  }
  updateLive(session) {
    if (!this.liveEl) return;
    const live = this.plugin.engine.liveText(session.id);
    const body = this.liveEl.querySelector(".sh-live-text");
    if (!(body instanceof HTMLElement)) return;
    if (live.text.trim()) {
      body.setText(live.text);
      body.removeClass("is-thinking");
    } else {
      body.setText("Thinking\u2026");
      body.addClass("is-thinking");
    }
  }
  async renderToolCall(session, call) {
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
      (0, import_obsidian2.setIcon)(block.createSpan({ cls: "sh-chip-icon" }), "map");
      block.createSpan({ cls: "sh-chip-title", text: "Plan updated" });
      block.createSpan({ cls: "sh-chip-meta", text: `${nodes.length} landmarks` });
      return;
    }
    if (call.function.name === "record_evidence") {
      const args = parseToolArgs(call);
      const result = typeof args.result === "string" ? args.result : "unknown";
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip" });
      (0, import_obsidian2.setIcon)(block.createSpan({ cls: "sh-chip-icon" }), "check-circle");
      block.createSpan({ cls: "sh-chip-title", text: "Evidence recorded" });
      block.createSpan({ cls: `sh-chip-meta is-${result}`, text: result });
      return;
    }
    if (call.function.name === "create_flashcards") {
      const args = parseToolArgs(call);
      const title = typeof args.title === "string" ? args.title : "Flashcard deck";
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip" });
      (0, import_obsidian2.setIcon)(block.createSpan({ cls: "sh-chip-icon" }), "layers");
      block.createSpan({ cls: "sh-chip-title", text: title });
      block.createSpan({ cls: "sh-chip-meta", text: "deck written" });
      return;
    }
    if (call.function.name === "finish_session") {
      const args = parseToolArgs(call);
      const block = this.transcriptEl.createDiv({ cls: "sh-tool-chip sh-finish-chip" });
      (0, import_obsidian2.setIcon)(block.createSpan({ cls: "sh-chip-icon" }), "flag");
      block.createSpan({ cls: "sh-chip-title", text: "Session finished" });
      if (typeof args.summary === "string") block.createSpan({ cls: "sh-chip-meta", text: args.summary });
    }
  }
  async renderQuestionCard(input, callId, session) {
    const card = this.transcriptEl.createDiv({ cls: "sh-question-card" });
    const kicker = card.createDiv({ cls: "sh-question-kicker" });
    kicker.createSpan({ text: input.type === "probe" ? "Probe" : input.type === "predict" ? "Predict" : input.type === "practice" ? "Practice" : "Check your understanding" });
    if (input.nodeId) kicker.createSpan({ cls: "sh-question-node", text: input.nodeId });
    const qBody = card.createDiv({ cls: "sh-markdown sh-question-text" });
    await import_obsidian2.MarkdownRenderer.render(this.app, input.question, qBody, "", this);
    if (input.details) {
      const detail = card.createDiv({ cls: "sh-question-details" });
      await import_obsidian2.MarkdownRenderer.render(this.app, input.details, detail, "", this);
    }
    const selected = /* @__PURE__ */ new Set();
    let textAnswer = "";
    if (input.options && input.options.length > 0) {
      const options = card.createDiv({ cls: "sh-options" });
      for (const option of input.options) {
        const row = options.createEl("label", { cls: "sh-option" });
        const radio = row.createEl("input", {
          attr: { type: input.multiSelect ? "checkbox" : "radio", name: `q-${callId}` }
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
        await import_obsidian2.MarkdownRenderer.render(this.app, option.label, label, "", this);
      }
    } else {
      const answer = card.createEl("textarea", {
        cls: "sh-free-answer",
        attr: { rows: "4", placeholder: "Explain in your own words\u2026" }
      });
      answer.addEventListener("input", () => {
        textAnswer = answer.value;
      });
    }
    const controls = card.createDiv({ cls: "sh-answer-controls" });
    const confidenceWrap = controls.createDiv({ cls: "sh-confidence" });
    confidenceWrap.createSpan({ cls: "sh-confidence-label", text: "Confidence" });
    const slider = confidenceWrap.createEl("input", {
      attr: { type: "range", min: "0", max: "100", value: "50", step: "1" }
    });
    const confidenceValue = confidenceWrap.createSpan({ cls: "sh-confidence-value", text: "50%" });
    slider.addEventListener("input", () => {
      confidenceValue.setText(`${slider.value}%`);
    });
    const thinking = card.createEl("textarea", {
      cls: "sh-thinking",
      attr: { rows: "3", placeholder: "Think out loud: your reasoning, uncertainty, or questions\u2026" }
    });
    thinking.addEventListener("input", () => {
    });
    const submit = controls.createEl("button", { cls: "mod-cta", text: "Answer", attr: { type: "button" } });
    submit.addEventListener("click", () => {
      submit.disabled = true;
      const answer = {
        answer: input.options ? [...selected] : void 0,
        text: input.options ? void 0 : textAnswer.trim(),
        confidence: Number(slider.value),
        thinking: thinking.value.trim() || void 0,
        at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (input.options && answer.answer?.length === 0) {
        new import_obsidian2.Notice("Select an option first.");
        submit.disabled = false;
        return;
      }
      if (!input.options && !answer.text) {
        new import_obsidian2.Notice("Write an answer first.");
        submit.disabled = false;
        return;
      }
      void this.plugin.engine.submitAnswer(session.id, answer);
    });
    const dontKnow = controls.createEl("button", { cls: "sh-ghost", text: "I don't know", attr: { type: "button" } });
    dontKnow.addEventListener("click", () => {
      void this.plugin.engine.submitAnswer(session.id, {
        answer: input.options ? [] : void 0,
        text: input.options ? void 0 : "I don't know.",
        confidence: Number(slider.value),
        thinking: thinking.value.trim() || void 0,
        dontKnow: true,
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
  }
  async renderAnsweredCard(input, raw) {
    const card = this.transcriptEl.createDiv({ cls: "sh-question-card is-answered" });
    const kicker = card.createDiv({ cls: "sh-question-kicker" });
    kicker.createSpan({ text: input.type === "probe" ? "Probe" : input.type === "practice" ? "Practice" : "Check" });
    if (typeof raw.correct === "boolean") {
      kicker.createSpan({ cls: raw.correct ? "sh-correct" : "sh-incorrect", text: raw.correct ? "Correct" : "Incorrect" });
    }
    const qBody = card.createDiv({ cls: "sh-markdown sh-question-text" });
    await import_obsidian2.MarkdownRenderer.render(this.app, input.question, qBody, "", this);
    const answerText = raw.dontKnow === true ? "I don't know" : Array.isArray(raw.answer) ? raw.answer.join(", ") : typeof raw.answer === "string" ? raw.answer : typeof raw.text === "string" ? raw.text : "(no answer)";
    const answerLine = card.createDiv({ cls: "sh-answer-line" });
    answerLine.createSpan({ cls: "sh-answer-label", text: "Your answer: " });
    answerLine.createSpan({ text: answerText || "(empty)" });
    if (typeof raw.confidence === "number") {
      answerLine.createSpan({ cls: "sh-answer-confidence", text: ` \xB7 ${raw.confidence}% confident` });
    }
    if (typeof raw.thinking === "string" && raw.thinking.trim()) {
      const think = card.createDiv({ cls: "sh-answer-thinking" });
      think.createSpan({ cls: "sh-answer-label", text: "Your thinking: " });
      think.createSpan({ text: raw.thinking });
    }
    if (input.explanation) {
      const exp = card.createDiv({ cls: "sh-explanation" });
      await import_obsidian2.MarkdownRenderer.render(this.app, input.explanation, exp, "", this);
    }
  }
  renderComposer(session) {
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
      attr: { rows: "2", placeholder: "Ask, answer, or think out loud\u2026" }
    });
    this.composerEl.value = this.draftComposer;
    this.composerEl.addEventListener("input", () => {
      this.draftComposer = this.composerEl.value;
    });
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.sendComposer(session);
      }
    });
    this.sendEl = shell.createEl("button", {
      cls: "sh-send-button",
      attr: { type: "button", "aria-label": session.status === "running" ? "Stop" : "Send" }
    });
    (0, import_obsidian2.setIcon)(this.sendEl, session.status === "running" ? "square" : "corner-down-left");
    this.sendEl.addEventListener("click", () => {
      if (session.status === "running") this.plugin.stopSession(session.id);
      else this.sendComposer(session);
    });
    const hint = composer.createDiv({ cls: "sh-composer-hint", text: "Enter to send \xB7 Shift+Enter for a new line \xB7 thinking out loud is encouraged" });
    void hint;
  }
  sendComposer(session) {
    const text = this.composerEl?.value.trim() ?? "";
    if (!text) return;
    this.draftComposer = "";
    if (this.composerEl) this.composerEl.value = "";
    void this.plugin.engine.sendMessage(session.id, text);
  }
};

// src/session-list-view.ts
var import_obsidian3 = require("obsidian");
var VIEW_TYPE_SESSIONS = "study-harness-sessions";
var SessionListView = class extends import_obsidian3.ItemView {
  plugin;
  listEl;
  searchEl;
  filterEl;
  query = "";
  filter = "all";
  lastKey = "";
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_SESSIONS;
  }
  getDisplayText() {
    return "Study sessions";
  }
  getIcon() {
    return "list";
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("sh-session-list-view");
    this.build();
    this.refresh();
  }
  refresh() {
    if (!this.listEl) return;
    const key = this.plugin.store.listSessions().map((s) => `${s.id}:${s.title}:${s.messages.length}:${s.status}:${s.phase}:${s.updatedAt}:${s.pendingQuestion?.toolCallId ?? ""}:${s.graphExtraction?.status ?? ""}`).join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.renderList();
  }
  build() {
    const header = this.contentEl.createDiv({ cls: "sh-list-header" });
    const titleRow = header.createDiv({ cls: "sh-list-title-row" });
    titleRow.createDiv({ cls: "sh-list-title", text: "Sessions" });
    const actions = titleRow.createDiv({ cls: "sh-list-actions" });
    const add = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "New session" } });
    (0, import_obsidian3.setIcon)(add, "plus");
    add.addEventListener("click", () => {
      this.plugin.activeSessionId = null;
      void this.plugin.openSessionView();
    });
    const refresh = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Refresh sessions" } });
    (0, import_obsidian3.setIcon)(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.refresh());
    this.searchEl = header.createEl("input", {
      cls: "sh-list-search",
      attr: { type: "search", placeholder: "Search sessions\u2026", "aria-label": "Search sessions" }
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
      ["empty", "Empty"]
    ]) {
      const option = this.filterEl.createEl("option", { text: label });
      option.value = value;
    }
    this.filterEl.addEventListener("change", () => {
      this.filter = this.filterEl.value;
      this.renderList();
    });
    const clean = filterRow.createEl("button", { cls: "sh-list-clean", text: "Delete empty", attr: { type: "button" } });
    clean.addEventListener("click", () => void this.plugin.confirmDeleteEmptySessions());
    this.listEl = this.contentEl.createDiv({ cls: "sh-session-list" });
  }
  renderList() {
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
  renderRow(session) {
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
    meta.createSpan({ text: `\xB7 ${session.mode} \xB7 ${session.phase}` });
    meta.createSpan({ cls: "sh-session-row-count", text: `\xB7 ${session.messages.length} msgs` });
    if (session.messages.length === 0) meta.createSpan({ cls: "sh-session-row-empty", text: "\xB7 empty" });
    const actions = row.createDiv({ cls: "sh-session-row-actions" });
    const rename = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Rename session" } });
    (0, import_obsidian3.setIcon)(rename, "pencil");
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      this.plugin.openRenameSession(session.id);
    });
    const del = actions.createEl("button", { cls: "clickable-icon sh-delete-icon", attr: { type: "button", "aria-label": "Delete session" } });
    (0, import_obsidian3.setIcon)(del, "trash-2");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.plugin.confirmDeleteSession(session.id);
    });
    main.addEventListener("click", () => void this.plugin.openSession(session.id));
  }
};

// src/notes-import.ts
var import_obsidian4 = require("obsidian");
var NotesImportModal = class extends import_obsidian4.Modal {
  plugin;
  searchEl;
  listEl;
  domainEl;
  selected = /* @__PURE__ */ new Set();
  query = "";
  files = [];
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    this.modalEl.addClass("sh-notes-modal");
    this.titleEl.setText("Import notes into the knowledge graph");
    this.contentEl.empty();
    const intro = this.contentEl.createEl("p", {
      cls: "sh-muted",
      text: "Choose Markdown notes. The model will extract propositions and prerequisite links into the knowledge bank. Nothing is written back to your notes."
    });
    void intro;
    const searchRow = this.contentEl.createDiv({ cls: "sh-notes-search-row" });
    this.searchEl = searchRow.createEl("input", {
      cls: "sh-list-search",
      attr: { type: "search", placeholder: "Search notes\u2026", "aria-label": "Search notes" }
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
    this.files = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith("StudyHarness/") && !f.path.startsWith(".trash/")).sort((a, b) => a.path.localeCompare(b.path));
    const domainRow = this.contentEl.createDiv({ cls: "sh-notes-domain-row" });
    domainRow.createSpan({ text: "Domain" });
    this.domainEl = domainRow.createEl("input", {
      cls: "sh-notes-domain",
      attr: { type: "text", value: "Imported notes", "aria-label": "Knowledge domain" }
    });
    const footer = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = footer.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const importBtn = footer.createEl("button", { cls: "mod-cta", text: "Import selected", attr: { type: "button" } });
    importBtn.addEventListener("click", () => {
      if (this.selected.size === 0) {
        new import_obsidian4.Notice("Select at least one note.");
        return;
      }
      const paths = [...this.selected];
      const domain = this.domainEl.value.trim() || "Imported notes";
      this.close();
      void this.plugin.importNotes(paths, domain);
    });
    this.renderList();
  }
  onClose() {
    this.contentEl.empty();
  }
  visibleFiles() {
    const q = this.query;
    return this.files.filter((f) => !q || f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q));
  }
  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const files = this.visibleFiles();
    const summary = this.listEl.createDiv({ cls: "sh-notes-summary" });
    summary.setText(`${files.length} notes shown \xB7 ${this.selected.size} selected`);
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
        summary.setText(`${files.length} notes shown \xB7 ${this.selected.size} selected`);
      });
      const text = row.createDiv({ cls: "sh-note-row-text" });
      text.createDiv({ cls: "sh-note-row-title", text: file.basename });
      text.createDiv({ cls: "sh-note-row-path", text: file.path });
    }
    if (files.length > 500) {
      this.listEl.createDiv({ cls: "sh-list-empty-text", text: "Showing the first 500 matches. Narrow the search to select more." });
    }
  }
};

// src/modals.ts
var import_obsidian5 = require("obsidian");
var ConfirmModal = class extends import_obsidian5.Modal {
  titleText;
  message;
  confirmLabel;
  onConfirm;
  danger;
  constructor(app, options) {
    super(app);
    this.titleText = options.title;
    this.message = options.message;
    this.confirmLabel = options.confirmLabel ?? "Confirm";
    this.onConfirm = options.onConfirm;
    this.danger = options.danger ?? false;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    const body = this.contentEl.createDiv({ cls: "sh-confirm-body" });
    body.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: this.danger ? "mod-warning" : "mod-cta",
      text: this.confirmLabel,
      attr: { type: "button" }
    });
    confirm.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var RenameSessionModal = class extends import_obsidian5.Modal {
  initial;
  onSave;
  input;
  constructor(app, initial, onSave) {
    super(app);
    this.initial = initial;
    this.onSave = onSave;
  }
  onOpen() {
    this.titleEl.setText("Rename session");
    const body = this.contentEl.createDiv({ cls: "sh-rename-body" });
    this.input = body.createEl("input", {
      cls: "sh-topic-input",
      attr: { type: "text", value: this.initial, "aria-label": "Session title" }
    });
    const actions = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } });
    save.addEventListener("click", () => {
      this.close();
      this.onSave(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save.click();
      }
    });
    window.setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 20);
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/store.ts
function resultScore(result) {
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
function evidenceArea(type) {
  if (type === "explain") return "explanation";
  if (type === "practice") return "application";
  return "recall";
}
function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
var HarnessStore = class {
  data;
  graphRevision = 0;
  save;
  constructor(data, save) {
    this.data = data ?? emptyData();
    this.data.settings = { ...emptyData().settings, ...this.data.settings ?? {} };
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
          error: "Interrupted by a plugin reload. Run extraction again."
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
  persist() {
    this.save();
  }
  bumpGraph() {
    this.graphRevision++;
  }
  createSession(input) {
    const topic = input.topic.trim() || "Untitled topic";
    const session = {
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
      focusNodeId: input.focusNodeId
    };
    this.data.sessions[session.id] = session;
    this.persist();
    return session;
  }
  getSession(id) {
    return this.data.sessions[id] ?? null;
  }
  listSessions() {
    return Object.values(this.data.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  touchSession(session) {
    session.updatedAt = nowIso();
    this.data.sessions[session.id] = session;
    this.persist();
  }
  deleteSession(id) {
    delete this.data.sessions[id];
    this.persist();
  }
  renameSession(id, title) {
    const session = this.data.sessions[id];
    if (!session) return;
    session.title = title.trim() || session.topic;
    this.persist();
  }
  emptySessions() {
    return this.listSessions().filter((s) => s.messages.length === 0);
  }
  noteId(path) {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `note_${(h >>> 0).toString(36)}`;
  }
  addNoteSource(path) {
    const id = this.noteId(path);
    const existing = this.data.noteSources.find((n) => n.id === id);
    if (existing) {
      existing.status = "running";
      existing.error = void 0;
      existing.importedAt = nowIso();
      this.persist();
      return existing;
    }
    const source = { id, path, importedAt: nowIso(), status: "running" };
    this.data.noteSources.unshift(source);
    this.persist();
    return source;
  }
  updateNoteSource(id, patch) {
    const source = this.data.noteSources.find((n) => n.id === id);
    if (!source) return;
    Object.assign(source, patch);
    this.persist();
  }
  listNoteSources() {
    return this.data.noteSources.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }
  startTurn(session) {
    session.status = "running";
    session.lastError = void 0;
    this.touchSession(session);
  }
  finishTurn(session) {
    if (session.status === "running") session.status = "idle";
    this.touchSession(session);
  }
  failTurn(session, message) {
    session.status = "error";
    session.lastError = message;
    this.touchSession(session);
  }
  setPending(session, pending) {
    session.pendingQuestion = pending;
    if (pending) session.status = "waiting";
    this.touchSession(session);
  }
  addUserMessage(session, content) {
    session.messages.push({ role: "user", content });
    this.touchSession(session);
  }
  addAssistantMessage(session, message) {
    session.messages.push(message);
    this.touchSession(session);
  }
  addToolMessage(session, toolCallId, name, content) {
    session.messages.push({ role: "tool", tool_call_id: toolCallId, name, content });
    this.touchSession(session);
  }
  upsertPlan(session, plan) {
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
        sessionId: session.id
      });
    }
    for (const edge of plan.edges) {
      this.addEdge({ from: edge.from, to: edge.to, type: "requires", sessionId: session.id });
    }
    this.touchSession(session);
  }
  upsertNode(input) {
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
    const node = {
      id: input.id,
      name: input.name,
      statement: input.statement,
      kind: input.kind,
      domain: input.domain,
      aliases: input.aliases ? [...input.aliases] : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sessionIds: input.sessionId ? [input.sessionId] : [],
      sourcePaths: input.sourcePath ? [input.sourcePath] : []
    };
    this.data.nodes[input.id] = node;
    this.bumpGraph();
    return node;
  }
  addEdge(input) {
    if (input.from === input.to) return null;
    const exists = this.data.edges.some(
      (edge2) => edge2.from === input.from && edge2.to === input.to && edge2.type === input.type
    );
    if (exists) return null;
    const edge = { ...input, createdAt: nowIso() };
    this.data.edges.push(edge);
    this.bumpGraph();
    return edge;
  }
  addEvidence(input) {
    if (!this.data.nodes[input.nodeId]) {
      this.upsertNode({
        id: input.nodeId,
        name: input.nodeId,
        statement: input.nodeId,
        kind: "definition",
        domain: this.data.sessions[input.sessionId]?.topic ?? "Unknown",
        sessionId: input.sessionId
      });
    }
    const evidence = {
      id: uid("e"),
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      type: input.type,
      result: input.result,
      confidence: input.confidence,
      note: input.note,
      at: nowIso()
    };
    this.data.evidence.push(evidence);
    this.bumpGraph();
    this.persist();
    return evidence;
  }
  evidenceFor(nodeId) {
    return this.data.evidence.filter((e) => e.nodeId === nodeId).sort((a, b) => b.at.localeCompare(a.at));
  }
  strength(nodeId) {
    const evidence = this.evidenceFor(nodeId);
    if (evidence.length === 0) {
      return { overall: 0.12, recall: 0.12, explanation: 0.12, application: 0.12, calibration: null, count: 0, lastAt: null };
    }
    const groups = {
      recall: [],
      explanation: [],
      application: []
    };
    const all = [];
    const calibration = [];
    for (const item of evidence) {
      const score = resultScore(item.result);
      all.push(score);
      groups[evidenceArea(item.type)].push(score);
      if (typeof item.confidence === "number" && item.result !== "unknown") {
        calibration.push(1 - Math.abs(item.confidence / 100 - score));
      }
    }
    const lastAt = evidence[0]?.at ?? null;
    const ageDays = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 864e5 : 0;
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
      lastAt
    };
  }
  mergeExtracted(input) {
    const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const byStatement = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    for (const node of Object.values(this.data.nodes)) {
      byStatement.set(normalize(node.statement), node.id);
      byName.set(normalize(node.name), node.id);
    }
    const uniqueId = (base) => {
      let candidate = slugify(base);
      let counter = 2;
      while (this.data.nodes[candidate]) {
        candidate = `${slugify(base)}-${counter}`;
        counter++;
      }
      return candidate;
    };
    const local = /* @__PURE__ */ new Map();
    let nodesCreated = 0;
    let nodesLinked = 0;
    for (const prop of input.propositions) {
      const name = (prop.name || prop.statement || "").trim();
      const statement = (prop.statement || name).trim();
      if (!name || !statement) continue;
      const kindValue = prop.kind;
      const kinds = ["definition", "assumption", "theorem", "empirical", "heuristic", "procedure", "analogy", "application"];
      const kind = kinds.includes(kindValue) ? kindValue : "definition";
      const existingId = this.data.nodes[prop.id]?.id ?? byStatement.get(normalize(statement)) ?? byName.get(normalize(name));
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
        sourcePaths: input.sourcePath ? [input.sourcePath] : []
      };
      byStatement.set(normalize(statement), id);
      byName.set(normalize(name), id);
      local.set(prop.id, id);
      nodesCreated++;
    }
    let linksCreated = 0;
    for (const relation of input.relations) {
      const from = local.get(relation.from) ?? (this.data.nodes[relation.from] ? relation.from : void 0);
      const to = local.get(relation.to) ?? (this.data.nodes[relation.to] ? relation.to : void 0);
      if (!from || !to || from === to) continue;
      const type = relation.type === "related" ? "related" : "requires";
      const edge = this.addEdge({
        from,
        to,
        type,
        sessionId: input.sessionId ?? input.sourceId,
        sourceId: input.sourceId
      });
      if (edge) linksCreated++;
    }
    if (nodesCreated > 0 || nodesLinked > 0 || linksCreated > 0) {
      this.bumpGraph();
      this.persist();
    }
    return { nodesCreated, nodesLinked, linksCreated };
  }
  nodes() {
    return Object.values(this.data.nodes).sort((a, b) => a.name.localeCompare(b.name));
  }
  edges() {
    return this.data.edges.filter((e) => this.data.nodes[e.from] && this.data.nodes[e.to]);
  }
  planStatus(session) {
    const ids = new Set((session.plan?.nodes ?? []).map((n) => n.id));
    const runs = [];
    for (const message of session.messages) {
      if (message.role !== "assistant" || !message.tool_calls) continue;
      for (const call of message.tool_calls) {
        if (call.function.name !== "ask_learner") continue;
        try {
          const input = JSON.parse(call.function.arguments);
          if (input.nodeId && ids.has(input.nodeId) && runs.at(-1) !== input.nodeId) {
            runs.push(input.nodeId);
          }
        } catch {
        }
      }
    }
    return {
      current: runs.at(-1) ?? null,
      visited: new Set(runs.slice(0, -1))
    };
  }
  answerFor(session, toolCallId) {
    const result = session.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === toolCallId
    );
    return result?.content ?? null;
  }
};

// src/main.ts
var StudyHarnessPlugin = class extends import_obsidian6.Plugin {
  store;
  engine;
  activeSessionId = null;
  saveTimer = null;
  lastGraphRevision = -1;
  get config() {
    return this.store.data.settings;
  }
  async onload() {
    const raw = await this.loadData();
    this.store = new HarnessStore(raw, () => this.scheduleSave());
    this.engine = new HarnessEngine(this);
    this.registerView(VIEW_TYPE_SESSION, (leaf) => new SessionView(leaf, this));
    this.registerView(VIEW_TYPE_GRAPH, (leaf) => new GraphView(leaf, this));
    this.registerView(VIEW_TYPE_SESSIONS, (leaf) => new SessionListView(leaf, this));
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
      }
    });
    this.addCommand({
      id: "open-sessions-panel",
      name: "Open sessions panel",
      callback: () => void this.openSessionsPanel()
    });
    this.addCommand({
      id: "import-notes",
      name: "Import notes into knowledge graph",
      callback: () => this.openNotesImport()
    });
    this.addCommand({
      id: "extract-session-graph",
      name: "Extract knowledge graph from current session",
      checkCallback: (checking) => {
        const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
        if (!session) return false;
        if (!checking) void this.extractCurrentSession();
        return true;
      }
    });
    this.addCommand({
      id: "delete-empty-sessions",
      name: "Delete empty sessions",
      callback: () => void this.confirmDeleteEmptySessions()
    });
    this.addCommand({
      id: "generate-flashcards",
      name: "Generate flashcards for current session",
      checkCallback: (checking) => {
        const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
        if (!session) return false;
        if (!checking) void this.generateFlashcards(session.id);
        return true;
      }
    });
    this.addCommand({
      id: "open-settings",
      name: "Open Study Harness settings",
      callback: () => this.openSettings()
    });
    this.addCommand({
      id: "reload-study-harness",
      name: "Reload Study Harness (dev)",
      callback: async () => {
        const plugins = this.app.plugins;
        if (!plugins) return;
        await plugins.disablePlugin(this.manifest.id);
        await plugins.enablePlugin(this.manifest.id);
      }
    });
    this.addSettingTab(new StudyHarnessSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.lastGraphRevision = this.store.graphRevision;
    });
  }
  onunload() {
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
  getSettings() {
    return this.config;
  }
  scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.store.data);
    }, 250);
  }
  notify() {
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
  onStreamEnd() {
    this.notify();
  }
  getSessionView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)[0];
    const view = leaf?.view;
    return view instanceof SessionView ? view : null;
  }
  getGraphView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH)[0];
    const view = leaf?.view;
    return view instanceof GraphView ? view : null;
  }
  getSessionListView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS)[0];
    const view = leaf?.view;
    return view instanceof SessionListView ? view : null;
  }
  async activateView(type) {
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
  async openSessionView() {
    const leaf = await this.activateView(VIEW_TYPE_SESSION);
    if (!leaf) return;
    const view = leaf.view;
    if (view instanceof SessionView) await view.refresh();
  }
  async openSession(id) {
    const session = this.store.getSession(id);
    if (!session) {
      new import_obsidian6.Notice("Session not found.");
      return;
    }
    this.activeSessionId = id;
    await this.openSessionView();
    this.notify();
  }
  async createAndStartSession(topic, intent, mode, focusNodeId) {
    const session = this.store.createSession({ topic, intent, mode, focusNodeId });
    this.activeSessionId = session.id;
    await this.openSessionView();
    this.notify();
    void this.engine.startSession(session.id);
  }
  async startSessionForNode(nodeId, intent, mode) {
    const node = this.store.data.nodes[nodeId];
    if (!node) return;
    await this.createAndStartSession(node.name, intent, mode, nodeId);
  }
  async openSessionsPanel() {
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
  openRenameSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    new RenameSessionModal(this.app, session.title, (value) => {
      this.store.renameSession(sessionId, value);
      this.notify();
    }).open();
  }
  async confirmDeleteSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (this.engine.isRunning(sessionId)) {
      new import_obsidian6.Notice("Stop the session before deleting it.");
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
        new import_obsidian6.Notice("Session deleted.");
      }
    }).open();
  }
  async confirmDeleteEmptySessions() {
    const empty = this.store.emptySessions();
    if (empty.length === 0) {
      new import_obsidian6.Notice("No empty sessions to delete.");
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
        new import_obsidian6.Notice(`Deleted ${empty.length} empty session${empty.length === 1 ? "" : "s"}.`);
      }
    }).open();
  }
  openNotesImport() {
    new NotesImportModal(this.app, this).open();
  }
  async importNotes(paths, domain) {
    const notes = [];
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof import_obsidian6.TFile)) continue;
      try {
        notes.push({ path, text: await this.app.vault.cachedRead(file) });
      } catch (err) {
        new import_obsidian6.Notice(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (notes.length === 0) {
      new import_obsidian6.Notice("No readable notes selected.");
      return;
    }
    const progress = new import_obsidian6.Notice(`Importing 0/${notes.length} notes\u2026`, 0);
    try {
      const results = await this.engine.importNotes(notes, domain, (message) => {
        progress.setMessage(message);
      });
      progress.hide();
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      const nodes = results.reduce((sum, r) => sum + (r.ok ? r.nodes : 0), 0);
      const links = results.reduce((sum, r) => sum + (r.ok ? r.links : 0), 0);
      new import_obsidian6.Notice(`Notes import finished: ${ok} ok, ${failed} failed \xB7 ${nodes} nodes, ${links} links`);
      this.notify();
    } catch (err) {
      progress.hide();
      new import_obsidian6.Notice(`Notes import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async extractCurrentSession() {
    const session = this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
    if (!session) {
      new import_obsidian6.Notice("Open a session first.");
      return;
    }
    if (session.graphExtraction?.status === "running") {
      new import_obsidian6.Notice("Graph extraction is already running for this session.");
      return;
    }
    new import_obsidian6.Notice("Extracting knowledge graph\u2026");
    try {
      const result = await this.engine.extractSessionGraph(session.id, true);
      new import_obsidian6.Notice(`Graph extraction finished: ${result.nodes} nodes, ${result.links} links.`);
      this.notify();
    } catch (err) {
      new import_obsidian6.Notice(`Graph extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  stopSession(sessionId) {
    this.engine.stop(sessionId);
  }
  async openGraph(nodeId) {
    const leaf = await this.activateView(VIEW_TYPE_GRAPH);
    const view = leaf?.view;
    if (view instanceof GraphView) {
      view.refresh();
      if (nodeId) view.selectNode(nodeId);
      await this.app.workspace.revealLeaf(leaf);
    }
  }
  openSettings() {
    const setting = this.app.setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
    }
  }
  async generateFlashcards(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    new import_obsidian6.Notice("Generating flashcards\u2026");
    try {
      const path = await this.engine.generateFlashcards(sessionId);
      new import_obsidian6.Notice(`Flashcards written to ${path}`);
      this.notify();
    } catch (err) {
      new import_obsidian6.Notice(`Flashcards failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async writeFlashcardDeck(input) {
    const folder = "StudyHarness/Flashcards";
    await this.ensureFolder(folder);
    const base = this.safeName(input.title || `${input.session.topic} \u2014 key facts`);
    let path = (0, import_obsidian6.normalizePath)(`${folder}/${base}.md`);
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = (0, import_obsidian6.normalizePath)(`${folder}/${base} ${counter}.md`);
      counter++;
    }
    const lines = [
      "---",
      "flashcard: true",
      `lh-source: ${this.yaml(input.session.id)}`,
      `lh-topic: ${this.yaml(input.session.topic)}`,
      `lh-created: ${(/* @__PURE__ */ new Date()).toISOString()}`,
      "tags:",
      "  - study-harness/flashcards",
      "---",
      "",
      `# ${input.title}`,
      "",
      `> Generated from study session: **${input.session.title}**`,
      ""
    ];
    for (const card of input.cards) {
      lines.push(`## ${card.front.replace(/\s*\n\s*/g, " ").replace(/^#+\s*/, "")}`, "", card.back.trim(), "");
    }
    await this.app.vault.create(path, lines.join("\n"));
    return path;
  }
  async ensureFolder(path) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
        }
      }
    }
  }
  safeName(value) {
    const name = value.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
    return name || "Study Harness";
  }
  yaml(value) {
    return JSON.stringify(value);
  }
};
var StudyHarnessSettingTab = class extends import_obsidian6.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Study Harness" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "The harness calls an OpenAI-compatible chat completions API. OpenRouter is a convenient default because it exposes many models through one key."
    });
    new import_obsidian6.Setting(containerEl).setName("API key").setDesc("Stored in this plugin's data.json. Do not put secrets in synced notes.").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("sk-or-\u2026").setValue(this.plugin.config.apiKey).onChange((value) => {
        this.plugin.config.apiKey = value.trim();
        this.plugin.scheduleSave();
      });
    });
    new import_obsidian6.Setting(containerEl).setName("Base URL").setDesc("OpenAI-compatible base URL, without /chat/completions.").addText(
      (text) => text.setPlaceholder("https://openrouter.ai/api/v1").setValue(this.plugin.config.baseUrl).onChange((value) => {
        this.plugin.config.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
        this.plugin.scheduleSave();
      })
    );
    new import_obsidian6.Setting(containerEl).setName("Model").setDesc("Model id, e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet.").addText(
      (text) => text.setPlaceholder("openai/gpt-4o-mini").setValue(this.plugin.config.model).onChange((value) => {
        this.plugin.config.model = value.trim() || DEFAULT_SETTINGS.model;
        this.plugin.scheduleSave();
      })
    );
    new import_obsidian6.Setting(containerEl).setName("Max output tokens").setDesc("Upper bound for a single model response.").addText(
      (text) => text.setPlaceholder("2400").setValue(String(this.plugin.config.maxTokens)).onChange((value) => {
        const parsed = Number(value);
        this.plugin.config.maxTokens = Number.isFinite(parsed) ? Math.max(256, Math.min(16e3, Math.round(parsed))) : DEFAULT_SETTINGS.maxTokens;
        this.plugin.scheduleSave();
      })
    );
    new import_obsidian6.Setting(containerEl).setName("Temperature").setDesc("Lower is more consistent; higher is more exploratory.").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(this.plugin.config.temperature).setDynamicTooltip().onChange((value) => {
        this.plugin.config.temperature = value;
        this.plugin.scheduleSave();
      })
    );
    new import_obsidian6.Setting(containerEl).setName("Default intent").setDesc("Used when starting a new session.").addDropdown((dropdown) => {
      for (const intent of ["conceptual", "exam", "research", "application", "memorisation", "maintenance"]) {
        dropdown.addOption(intent, intentLabel(intent));
      }
      dropdown.setValue(this.plugin.config.defaultIntent).onChange((value) => {
        this.plugin.config.defaultIntent = value;
        this.plugin.scheduleSave();
      });
    });
    new import_obsidian6.Setting(containerEl).setName("Auto-suggest cards").setDesc("Adds a prompt instruction to generate cards at the end of memorisation sessions.").addToggle(
      (toggle) => toggle.setValue(this.plugin.config.autoCards).onChange((value) => {
        this.plugin.config.autoCards = value;
        this.plugin.scheduleSave();
      })
    );
    const buttons = containerEl.createDiv({ cls: "sh-settings-actions" });
    const graph = buttons.createEl("button", { text: "Open knowledge graph", attr: { type: "button" } });
    graph.addEventListener("click", () => void this.plugin.openGraph());
    const session = buttons.createEl("button", { text: "Open study workspace", attr: { type: "button" } });
    session.addEventListener("click", () => void this.plugin.openSessionView());
  }
};
