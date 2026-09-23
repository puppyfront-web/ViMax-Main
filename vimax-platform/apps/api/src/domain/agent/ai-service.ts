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

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.abortSignal,
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

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.abortSignal,
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
  let thinkingStartTime = 0;

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
          yield { type: "done" };
          return;
        }

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const choice = (parsed.choices as Array<Record<string, unknown>>)?.[0];
          if (!choice) continue;

          const delta = choice.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Thinking/reasoning content
          if (delta.reasoning_content) {
            if (!thinkingStartTime) {
              thinkingStartTime = Date.now();
              yield { type: "thinking-start" };
            }
            yield { type: "thinking-delta", thinking: delta.reasoning_content as string };
          }

          // Finish reason
          if (choice.finish_reason) {
            if (thinkingStartTime) {
              yield {
                type: "thinking-end",
                thinkDurationMs: Date.now() - thinkingStartTime,
              };
            }
          }

          // Text content
          if (delta.content) {
            yield { type: "text-delta", text: delta.content as string };
          }

          // Tool calls
          if (delta.tool_calls) {
            const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
            for (const tc of toolCalls) {
              const fn = tc.function as Record<string, unknown> | undefined;
              if (fn) {
                try {
                  yield {
                    type: "tool-call",
                    toolName: fn.name as string,
                    toolArgs: JSON.parse((fn.arguments as string) ?? "{}"),
                  };
                } catch {
                  // Partial JSON in streaming, skip
                }
              }
            }
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
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
    : request.model ?? config?.models[0]?.id ?? "default";

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
