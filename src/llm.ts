import * as http from "node:http";
import * as https from "node:https";
import type { LlmMessage, LlmToolCall, Settings } from "./types";

export interface LlmToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmStreamResult {
  text: string;
  reasoning: string;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  usage?: unknown;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

interface ChatRequest {
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  stream: boolean;
  settings: Settings;
  signal?: AbortSignal;
}

function endpoint(settings: Settings): URL {
  const base = settings.baseUrl.trim().replace(/\/+$/, "");
  return new URL(`${base}/chat/completions`);
}

function requestOptions(url: URL, settings: Settings): http.RequestOptions {
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
      "X-Title": "Study Harness",
    },
  };
}

function jsonBody(req: ChatRequest): string {
  const body: Record<string, unknown> = {
    model: req.settings.model,
    messages: req.messages.map(stripMessage),
    stream: req.stream,
    temperature: req.settings.temperature,
    max_tokens: req.settings.maxTokens,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = "auto";
  }
  return JSON.stringify(body);
}

function stripMessage(message: LlmMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls?.length) out.tool_calls = message.tool_calls;
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.name) out.name = message.name;
  return out;
}

async function readError(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // plain text
  }
  return text.slice(0, 1200) || `HTTP ${res.statusCode ?? 0}`;
}

function parseToolCalls(
  raw: unknown,
  accum: Map<number, LlmToolCall>,
): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw as Array<Record<string, unknown>>) {
    const index = typeof item.index === "number" ? item.index : accum.size;
    const existing = accum.get(index) ?? {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (typeof item.id === "string" && item.id) existing.id = item.id;
    const fn = item.function as { name?: unknown; arguments?: unknown } | undefined;
    if (fn) {
      if (typeof fn.name === "string" && fn.name && !existing.function.name) existing.function.name = fn.name;
      if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
    }
    accum.set(index, existing);
  }
}

function parseContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function streamChat(req: ChatRequest, callbacks: StreamCallbacks): Promise<LlmStreamResult> {
  const url = endpoint(req.settings);
  const transport = url.protocol === "http:" ? http : https;
  const body = jsonBody(req);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(requestOptions(url, req.settings), (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        void readError(res)
          .then((message) => finish(() => reject(new Error(message))))
          .catch((err) => finish(() => reject(err)));
        return;
      }
      let buffer = "";
      let text = "";
      let reasoning = "";
      const toolCalls = new Map<number, LlmToolCall>();
      let finishReason: string | undefined;
      let usage: unknown;
      const handleLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) return false;
        if (!trimmed.startsWith("data:")) return false;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return true;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return false;
        }
        if (parsed.usage) usage = parsed.usage;
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0) return false;
        const choice = choices[0] as Record<string, unknown>;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
        if (!delta) return false;
        const content = parseContent(delta.content);
        if (content) {
          text += content;
          callbacks.onText?.(content);
        }
        const thinking =
          (typeof delta.reasoning === "string" && delta.reasoning) ||
          (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
          (typeof delta.thinking === "string" && delta.thinking) ||
          "";
        if (thinking) {
          reasoning += thinking;
          callbacks.onReasoning?.(thinking);
        }
        parseToolCalls(delta.tool_calls, toolCalls);
        return false;
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
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

function completeChat(req: ChatRequest): Promise<LlmStreamResult> {
  const url = endpoint(req.settings);
  const transport = url.protocol === "http:" ? http : https;
  const body = jsonBody({ ...req, stream: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(requestOptions(url, req.settings), (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        void readError(res)
          .then((message) => finish(() => reject(new Error(message))))
          .catch((err) => finish(() => reject(err)));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            choices?: Array<{
              finish_reason?: string;
              message?: { content?: unknown; reasoning?: unknown; tool_calls?: unknown };
            }>;
            usage?: unknown;
          };
          const choice = parsed.choices?.[0];
          const message = choice?.message;
          const toolCalls = new Map<number, LlmToolCall>();
          parseToolCalls(message?.tool_calls, toolCalls);
          finish(() =>
            resolve({
              text: parseContent(message?.content),
              reasoning: typeof message?.reasoning === "string" ? message.reasoning : "",
              toolCalls: [...toolCalls.values()],
              finishReason: choice?.finish_reason,
              usage: parsed.usage,
            }),
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

export class LlmClient {
  stream(
    messages: LlmMessage[],
    tools: LlmToolSchema[] | undefined,
    settings: Settings,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    return streamChat({ messages, tools, stream: true, settings, signal }, callbacks);
  }

  complete(
    messages: LlmMessage[],
    tools: LlmToolSchema[] | undefined,
    settings: Settings,
    signal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    return completeChat({ messages, tools, stream: false, settings, signal });
  }
}

export function extractJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
