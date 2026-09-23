import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentMessage,
  ClientWsMessage,
  CanvasMutation,
} from "@vimax/contracts";
import {
  addConnection,
  removeConnection,
  joinRoom,
  subscribeConversation,
  sendToConnection,
} from "./connection-manager.js";

// ── WebSocket Upgrade Handler ───────────────────────────────────────
// Creates a WebSocket server that shares the HTTP server's port.
// Clients connect at /ws and send subscribe/join messages to
// associate themselves with canvas rooms.

let wss: WebSocketServer | null = null;

export function createWebSocketServer(): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    console.log("[ws] Client connected. Total:", wss?.clients.size ?? 0);

    addConnection(ws);

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientWsMessage;
        handleClientMessage(ws, msg);
      } catch (err) {
        console.error("[ws] Failed to parse message:", err);
        sendToConnection(ws, {
          type: "chat.error",
          conversationId: "",
          error: "Invalid message format",
        });
      }
    });

    ws.on("close", () => {
      console.log("[ws] Client disconnected.");
      removeConnection(ws);
    });

    ws.on("error", (err) => {
      console.error("[ws] Connection error:", err);
      removeConnection(ws);
    });
  });

  return wss;
}

/**
 * Handle the HTTP upgrade to WebSocket.
 * Call this from the server's "upgrade" event.
 */
export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  if (!wss) {
    socket.destroy();
    return;
  }

  // Only upgrade requests to /ws
  const url = req.url ?? "/";
  if (!url.startsWith("/ws")) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss!.emit("connection", ws, req);
  });
}

// ── Client Message Router ───────────────────────────────────────────

function handleClientMessage(ws: WebSocket, msg: ClientWsMessage): void {
  switch (msg.type) {
    case "chat.subscribe": {
      // Client joins a canvas room to receive all chat events for that canvas
      joinRoom(ws, msg.canvasId);
      console.log(`[ws] Client joined room: ${msg.canvasId}`);
      break;
    }

    case "chat.send": {
      // Handle incoming chat message
      // The actual agent processing will be handled by the chat service
      // For now, just subscribe the connection to this conversation's events
      subscribeConversation(ws, msg.conversationId);

      // Emit to let the chat service pick this up
      handleChatSend(ws, msg.conversationId, msg.content, msg.modelId);
      break;
    }

    case "chat.stop": {
      // TODO: Cancel ongoing agent processing for this conversation
      console.log(`[ws] Stop requested for conversation: ${msg.conversationId}`);
      break;
    }

    default: {
      console.warn("[ws] Unknown message type:", (msg as Record<string, unknown>).type);
    }
  }
}

// ── Chat send handler — real Agent integration ─────────────────────────

import { getDb } from "../infrastructure/db/client.js";
import {
  agentConversations,
  agentMessages,
  type AgentMessageRow,
} from "../infrastructure/db/schema.js";
import { eq } from "drizzle-orm";
import { broadcastToConversation, broadcastToRoom } from "./connection-manager.js";
import { runDecisionAgent, executeToolCall, buildCanvasContext } from "../domain/agent/decision-layer.js";
import type { AIStreamChunk } from "../domain/agent/ai-service.js";

function toAgentMessage(message: AgentMessageRow): AgentMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    metadata: (message.metadata as AgentMessage["metadata"]) ?? {},
    status: message.status,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Handle a chat.send message from a client.
 * Persists the user message and triggers the real DecisionAgent.
 */
async function handleChatSend(
  ws: WebSocket,
  conversationId: string,
  content: string,
  modelId?: string,
): Promise<void> {
  try {
    const db = getDb();

    // Verify conversation exists and get canvas ID
    const convRows = await db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, conversationId))
      .limit(1);

    if (convRows.length === 0) {
      sendToConnection(ws, {
        type: "chat.error",
        conversationId,
        error: "Conversation not found",
      });
      return;
    }

    const conv = convRows[0]!;
    const canvasId = conv.canvasId;

    // Persist user message
    const [userMsg] = await db
      .insert(agentMessages)
      .values({
        conversationId,
        role: "user",
        content,
        status: "complete",
        metadata: {},
      })
      .returning();

    // Broadcast user message arrival to room
    broadcastToRoom(canvasId, {
      type: "chat.message",
      conversationId,
      message: toAgentMessage(userMsg),
    });

    // Create assistant message placeholder (streaming)
    const [assistantMsg] = await db
      .insert(agentMessages)
      .values({
        conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
        metadata: {},
      })
      .returning();

    // ── Run the real Decision Agent ──

    // Check if an AI provider is configured (DB model apiKey or env vars)
    const { getDefaultModel } = await import("../domain/model/model.service.js");
    let defaultTextModel: Awaited<ReturnType<typeof getDefaultModel>> | null = null;
    try { defaultTextModel = await getDefaultModel("default", "text"); } catch {}
    const dbApiKey = defaultTextModel?.apiKey;
    const hasAI = !!dbApiKey ||
      (!!process.env.AI_BASE_URL ?? !!process.env.OPENAI_BASE_URL) &&
      !!(process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ARK_API_KEY);

    if (!hasAI) {
      // Fallback: no AI provider configured, return helpful message
      const ctx = await buildCanvasContext(canvasId);
      const nodeSummary = ctx
        ? `当前画布 "${ctx.canvasName}" 有 ${ctx.nodes.length} 个节点。`
        : "";

      const fallbackResponse = `⚠️ AI Provider 未配置。请在 .env 中设置以下变量后重启 API：\n\n` +
        `\`\`\`\nAI_BASE_URL=https://your-provider.com/v1\nAI_API_KEY=your-api-key\n\`\`\`\n\n` +
        `${nodeSummary}\n\n您的消息: "${content}"`;

      broadcastToConversation(conversationId, {
        type: "chat.delta",
        conversationId,
        content: fallbackResponse,
      });

      const [completedAssistantMessage] = await db
        .update(agentMessages)
        .set({ content: fallbackResponse, status: "complete" })
        .where(eq(agentMessages.id, assistantMsg.id))
        .returning();

      broadcastToConversation(conversationId, {
        type: "chat.complete",
        conversationId,
        message: toAgentMessage(completedAssistantMessage!),
      });
      return;
    }

    // Real agent processing with streaming
    let fullResponse = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    try {
      const result = await runDecisionAgent(
        canvasId,
        content,
        (chunk: AIStreamChunk) => {
          // Stream each chunk to the client in real-time
          switch (chunk.type) {
            case "thinking-start":
              broadcastToConversation(conversationId, {
                type: "chat.thinking",
                conversationId,
                content: "思考中…",
              });
              break;

            case "thinking-delta":
              broadcastToConversation(conversationId, {
                type: "chat.thinking",
                conversationId,
                content: chunk.thinking ?? "",
              });
              break;

            case "thinking-end":
              // Thinking complete, no action needed
              break;

            case "text-delta":
              broadcastToConversation(conversationId, {
                type: "chat.delta",
                conversationId,
                content: chunk.text ?? "",
              });
              break;

            case "tool-call":
              if (chunk.toolName) {
                toolCalls.push({
                  name: chunk.toolName,
                  args: chunk.toolArgs ?? {},
                });
                broadcastToConversation(conversationId, {
                  type: "chat.tool_call",
                  conversationId,
                  tool: {
                    id: `tc_${Date.now()}_${toolCalls.length}`,
                    name: chunk.toolName,
                    args: chunk.toolArgs ?? {},
                    status: "running",
                  },
                });
              }
              break;

            case "error":
              broadcastToConversation(conversationId, {
                type: "chat.error",
                conversationId,
                error: chunk.error ?? "Unknown error",
              });
              break;
          }
        },
        modelId,
      );

      fullResponse = result.text;

      // Build canvas context for node type counts (used by executeToolCall for positioning)
      const canvasCtx = await buildCanvasContext(canvasId);
      const nodeTypeCounts: Record<string, number> = {};
      if (canvasCtx) {
        for (const n of canvasCtx.nodes) {
          nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] ?? 0) + 1;
        }
      }

      // Callback: broadcast canvas mutations to all clients viewing this canvas
      const onCanvasMutation = (mutation: CanvasMutation) => {
        broadcastToRoom(canvasId, {
          type: "chat.canvas_mutation",
          conversationId,
          mutation,
        });
      };

      // Execute any tool calls the agent made
      for (const tc of result.toolCalls) {
        const execResult = await executeToolCall(
          tc.name,
          tc.args,
          canvasId,
          { onCanvasMutation, nodeTypeCounts },
        );

        // Broadcast tool result
        broadcastToConversation(conversationId, {
          type: "chat.tool_result",
          conversationId,
          tool: {
            id: `tc_${Date.now()}`,
            name: tc.name,
            args: tc.args,
            status: execResult.success ? "completed" : "failed",
            result: execResult.result,
          },
        });

        // If a canvas mutation was produced, broadcast it to the room
        if (execResult.canvasMutation) {
          broadcastToRoom(canvasId, {
            type: "chat.canvas_mutation",
            conversationId,
            mutation: execResult.canvasMutation,
          });
        }

        fullResponse += `\n\n🔧 ${tc.name}: ${execResult.message}`;

        // Update node type counts for subsequent tool calls (accumulate)
        if (execResult.success && execResult.canvasMutation?.type === "nodes.add") {
          for (const n of execResult.canvasMutation.nodes) {
            nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] ?? 0) + 1;
          }
        }
      }

      // If no text was generated but tool calls were made, add summary
      if (!fullResponse.trim() && toolCalls.length > 0) {
        fullResponse = `已执行 ${toolCalls.length} 个操作。`;
      }

      // If neither text nor tool calls, provide a fallback
      if (!fullResponse.trim()) {
        fullResponse = "我已收到您的消息，但暂时无法处理。请确保 AI Provider 已正确配置。";
      }
    } catch (agentErr) {
      console.error("[ws] Agent error:", agentErr);
      fullResponse = `处理时出错: ${agentErr instanceof Error ? agentErr.message : "Unknown error"}`;
    }

    // Persist the complete assistant message
    const [completedAssistantMessage] = await db
      .update(agentMessages)
      .set({
        content: fullResponse,
        status: "complete",
        metadata: {
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      })
      .where(eq(agentMessages.id, assistantMsg.id))
      .returning();

    // Broadcast completion
    broadcastToConversation(conversationId, {
      type: "chat.complete",
      conversationId,
      message: toAgentMessage(completedAssistantMessage!),
    });
  } catch (err) {
    console.error("[ws] handleChatSend error:", err);
    sendToConnection(ws, {
      type: "chat.error",
      conversationId,
      error: "Internal server error processing message",
    });
  }
}
