// ── AI Abstraction Layer ─────────────────────────────────────────────
// Adapted from Toonflow's utils/ai.ts — provides a unified interface
// for text/image/video/audio generation across multiple providers.

import { z } from "zod";

// ── Configuration ───────────────────────────────────────────────────

export interface AIProviderConfig {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "google" | "custom";
  baseUrl: string;
  apiKey: string;
  models: AIModelConfig[];
}

export interface AIModelConfig {
  id: string;
  name: string;
  type: "chat" | "image" | "video" | "tts" | "embedding";
  maxTokens?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}

// ── Fetch with retry (transient provider/network errors) ───────────
// AI providers (and the network to them) occasionally drop a connection
// or return 5xx/429. Retrying these — but never 4xx client errors — keeps
// the agent pipeline from aborting on a single flaky call.

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`AI provider responded ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("AI fetch failed");
}

// ── Request timeout ─────────────────────────────────────────────────
// Without a deadline a stalled provider (connected but silent) would keep
// a chat turn pending forever — the assistant message stays "streaming"
// and the agent loop never advances.

const GENERATE_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 300_000;

function withTimeout(abortSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

// ── AI Text Generation ──────────────────────────────────────────────

export interface AITextRequest {
  /** System prompt */
  system?: string;
  /** Messages array (for multi-turn) */
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Single user prompt (shortcut, creates messages array) */
  prompt?: string;
  /** Model ID (vendor:model format) */
  model?: string;
  /** Temperature 0-1 */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Enable thinking/reasoning */
  think?: boolean;
  /** Thinking depth 0-3 */
  thinkLevel?: 0 | 1 | 2 | 3;
  /** Tools the model can call */
  tools?: Record<string, AIToolDefinition>;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

export interface AIToolDefinition {
  description: string;
  parameters: z.ZodType<unknown>;
}

export interface AITextResponse {
  text: string;
  thinking?: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface AIStreamChunk {
  type: "text-delta" | "thinking-start" | "thinking-delta" | "thinking-end" |
    "tool-call" | "tool-result" | "error" | "done";
  text?: string;
  thinking?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  error?: string;
  thinkDurationMs?: number;
}

// ── OpenAI-compatible stream accumulator ────────────────────────────
// Tool-call arguments arrive fragmented across many SSE chunks (each
// carries a partial `arguments` string keyed by `index`). Accumulating
// them by index and assembling at stream end is the only correct way —
// parsing each chunk independently throws away every call. Extracted as
// a pure class so the fragmentation logic is unit-testable.

interface PendingToolCall {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

export class OpenAiStreamAccumulator {
  private pending = new Map<number, PendingToolCall>();
  private thinkingStart = 0;

  /** Process one streamed choice; returns immediate text/thinking chunks. */
  feedChoice(choice: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<Record<string, unknown>>;
    };
    finish_reason?: string | null;
  }): AIStreamChunk[] {
    const out: AIStreamChunk[] = [];
    const delta = choice.delta;

    if (delta?.reasoning_content) {
      if (!this.thinkingStart) {
        this.thinkingStart = Date.now();
        out.push({ type: "thinking-start" });
      }
      out.push({ type: "thinking-delta", thinking: delta.reasoning_content });
    }
    if (delta?.content) {
      out.push({ type: "text-delta", text: delta.content });
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;
        let entry = this.pending.get(idx);
        if (!entry) {
          entry = { index: idx, args: "" };
          this.pending.set(idx, entry);
        }
        if (fn?.name) entry.name = fn.name as string;
        if (tc.id) entry.id = tc.id as string;
        if (typeof fn?.arguments === "string") entry.args += fn.arguments;
      }
    }
    if (choice.finish_reason && this.thinkingStart) {
      out.push({ type: "thinking-end", thinkDurationMs: Date.now() - this.thinkingStart });
      this.thinkingStart = 0;
    }
    return out;
  }

  /** Assemble accumulated tool calls (call at stream end / [DONE]). */
  flush(): AIStreamChunk[] {
    const out: AIStreamChunk[] = [];
    const entries = [...this.pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, entry] of entries) {
      if (!entry.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = entry.args.trim() ? JSON.parse(entry.args) : {};
      } catch {
        // Malformed accumulated arguments — best-effort empty payload.
      }
      out.push({ type: "tool-call", toolName: entry.name, toolArgs: args });
    }
    this.pending.clear();
    return out;
  }
}

// ── AI Service ──────────────────────────────────────────────────────

/**
 * Generate text using the configured AI provider.
 * Currently supports OpenAI-compatible APIs (Doubao, DeepSeek, etc.)
 */
export async function generateText(request: AITextRequest): Promise<AITextResponse> {
  const config = await resolveProviderConfig(request.model);
  if (!config) {
    throw new Error(`No provider configured for model: ${request.model ?? "default"}`);
  }

  const messages = buildMessages(request);
  const body = buildRequestBody(request, messages, false, config);

  const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(request.abortSignal, GENERATE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI API error (${response.status}): ${error}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  return {
    text: (message?.content as string) ?? "",
    thinking: message?.reasoning_content as string | undefined,
    usage: data.usage
      ? {
          promptTokens: (data.usage as Record<string, number>).prompt_tokens ?? 0,
          completionTokens: (data.usage as Record<string, number>).completion_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Stream text generation using the configured AI provider.
 * Returns an async generator that yields chunks.
 */
export async function* streamText(
  request: AITextRequest,
): AsyncGenerator<AIStreamChunk> {
  const config = await resolveProviderConfig(request.model);
  if (!config) {
    throw new Error(`No provider configured for model: ${request.model ?? "default"}`);
  }

  const messages = buildMessages(request);
  const body = buildRequestBody(request, messages, true, config);

  const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(request.abortSignal, STREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = await response.text();
    yield { type: "error", error: `AI API error (${response.status}): ${error}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: "No response body for streaming" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const acc = new OpenAiStreamAccumulator();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          for (const chunk of acc.flush()) yield chunk;
          yield { type: "done" };
          return;
        }

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const choice = (parsed.choices as Array<Record<string, unknown>>)?.[0];
          if (!choice) continue;
          for (const chunk of acc.feedChoice(choice)) yield chunk;
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
    // Stream ended without an explicit [DONE] — flush anyway.
    for (const chunk of acc.flush()) yield chunk;
  } finally {
    reader.releaseLock();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildMessages(request: AITextRequest): Array<{ role: string; content: string }> {
  if (request.messages) return request.messages;
  const msgs: Array<{ role: string; content: string }> = [];
  if (request.system) msgs.push({ role: "system", content: request.system });
  if (request.prompt) msgs.push({ role: "user", content: request.prompt });
  return msgs;
}

function buildRequestBody(
  request: AITextRequest,
  messages: Array<{ role: string; content: string }>,
  stream: boolean,
  config: AIProviderConfig | null,
): Record<string, unknown> {
  const modelId = request.model?.includes(":")
    ? request.model!.split(":").slice(1).join(":")
    : config?.models[0]?.id ?? request.model ?? "default";

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 4096,
  };

  // Tool definitions (OpenAI function calling format)
  if (request.tools && Object.keys(request.tools).length > 0) {
    body.tools = Object.entries(request.tools).map(([name, tool]) => ({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.parameters),
      },
    }));
  }

  return body;
}

/**
 * Resolve provider config from model string ("vendorId:modelId")
 * Reads API key from DB model config first, falls back to environment variables.
 */
async function resolveProviderConfig(model?: string): Promise<AIProviderConfig | null> {
  // Try DB-backed text model first for apiKey, baseUrl, vendorModelId
  let dbApiKey: string | undefined;
  let dbBaseUrl: string | undefined;
  let dbModelId: string | undefined;
  try {
    const { getDefaultModel } = await import("../model/model.service.js");
    const defaultModel = await getDefaultModel("default", "text");
    dbApiKey = defaultModel.apiKey ?? undefined;
    const cfg = defaultModel.config as Record<string, unknown>;
    dbBaseUrl = (defaultModel.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined;
    dbModelId = defaultModel.vendorModelId ?? undefined;
  } catch {
    // DB not available yet, fall through to env vars
  }

  const baseUrl = dbBaseUrl ?? process.env.AI_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const apiKey = dbApiKey ?? process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ARK_API_KEY;

  if (!baseUrl || !apiKey) {
    return null;
  }

  const resolvedModelId = dbModelId ?? model?.split(":")[1] ?? "default";

  return {
    id: model?.split(":")[0] ?? "default",
    name: "Default Provider",
    type: "openai",
    baseUrl,
    apiKey,
    models: [
      {
        id: resolvedModelId,
        name: resolvedModelId,
        type: "chat",
        supportsStreaming: true,
        supportsThinking: true,
      },
    ],
  };
}

/**
 * Minimal Zod-to-JSON-Schema converter.
 * Only handles the types used in tool parameter definitions.
 */
function zodToJsonSchema(zodType: z.ZodType<unknown>): Record<string, unknown> {
  if (zodType instanceof z.ZodObject) {
    const shape = zodType.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // Check if optional
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  if (zodType instanceof z.ZodString) return { type: "string" };
  if (zodType instanceof z.ZodNumber) return { type: "number" };
  if (zodType instanceof z.ZodBoolean) return { type: "boolean" };
  if (zodType instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(zodType.element) };
  }
  if (zodType instanceof z.ZodEnum) return { type: "string", enum: zodType.options };
  if (zodType instanceof z.ZodOptional) return zodToJsonSchema(zodType.unwrap());
  if (zodType instanceof z.ZodDefault) return zodToJsonSchema(zodType._def.innerType);

  return { type: "string" };
}
