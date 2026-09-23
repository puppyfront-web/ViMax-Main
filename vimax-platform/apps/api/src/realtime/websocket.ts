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
  getUserId,
  getCanvasId,
  broadcastToRoom,
  broadcastToRoomExcept,
} from "./connection-manager.js";
import { verifyAccessToken } from "../domain/auth/jwt.js";

// ── WebSocket Upgrade Handler ───────────────────────────────────────
// Creates a WebSocket server that shares the HTTP server's port.
// Clients connect at /ws and send subscribe/join messages to
// associate themselves with canvas rooms.

let wss: WebSocketServer | null = null;

export function createWebSocketServer(): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    console.log("[ws] Client connected. Total:", wss?.clients.size ?? 0);

    // userId is already bound at upgrade time via addConnection in handleUpgrade.

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
      const canvasId = getCanvasId(ws);
      const userId = getUserId(ws);
      removeConnection(ws);
      if (canvasId && userId) {
        broadcastToRoom(canvasId, {
          type: "canvas.presence_leave",
          canvasId,
          userId,
        });
      }
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

  // Authenticate via access token in the query string — same level of
  // authorization as tRPC's protectedProcedure (the data model is
  // tenant-scoped, not per-user, so this checks identity, not ownership).
  // Anonymous upgrades are rejected.
  const token = new URL(url, "http://localhost").searchParams.get("token");
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Bind the authenticated user before emitting so every downstream
    // handler sees a connection with a known identity.
    addConnection(ws, payload.sub);
    wss!.emit("connection", ws, req);
  });
}

// ── Client Message Router ───────────────────────────────────────────

const activeChatAbort = new Map<string, AbortController>();

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
      activeChatAbort.get(msg.conversationId)?.abort();
      activeChatAbort.delete(msg.conversationId);
      console.log(`[ws] Stop requested for conversation: ${msg.conversationId}`);
      break;
    }

    case "pipeline.cancel": {
      cancelAutoPipeline(msg.runId);
      break;
    }

    case "canvas.presence": {
      void relayPresence(ws, msg);
      break;
    }

    default: {
      console.warn("[ws] Unknown message type:", (msg as Record<string, unknown>).type);
    }
  }
}

// ── Presence relay ──────────────────────────────────────────────────

const userNameCache = new Map<string, string>();

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 70% 55%)`;
}

async function getDisplayName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const db = getDb();
    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const name = user?.name ?? `用户 ${userId.slice(0, 4)}`;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return `用户 ${userId.slice(0, 4)}`;
  }
}

/** Re-emit the sender's pointer/selection to the rest of the canvas room. */
async function relayPresence(
  ws: WebSocket,
  msg: Extract<ClientWsMessage, { type: "canvas.presence" }>,
): Promise<void> {
  const userId = getUserId(ws);
  if (!userId) return;
  broadcastToRoomExcept(msg.canvasId, ws, {
    type: "canvas.presence",
    canvasId: msg.canvasId,
    userId,
    name: await getDisplayName(userId),
    color: colorForUser(userId),
    cursor: msg.cursor,
    selectedNodeIds: msg.selectedNodeIds,
  });
}

// ── Chat send handler — real Agent integration ─────────────────────────

import { getDb } from "../infrastructure/db/client.js";
import {
  agentConversations,
  agentMessages,
  users,
  type AgentMessageRow,
} from "../infrastructure/db/schema.js";
import { eq } from "drizzle-orm";
import { broadcastToConversation } from "./connection-manager.js";
import { runDecisionAgent, executeToolCall, buildCanvasContext } from "../domain/agent/decision-layer.js";
import { cancelAutoPipeline } from "../domain/canvas/pipeline-orchestrator.js";
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
    const hasAI =
      !!dbApiKey ||
      (!!process.env.AI_BASE_URL || !!process.env.OPENAI_BASE_URL) &&
        !!(process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ARK_API_KEY);

    if (!hasAI) {
      // Fallback: no AI provider configured, return helpful message
      const ctx = await buildCanvasContext(canvasId);
      const nodeSummary = ctx
        ? `当前画布 "${ctx.canvasName}" 有 ${ctx.nodes.length} 个节点。`
        : "";

      const fallbackResponse = `AI Provider 未配置。请在 .env 中设置以下变量后重启 API：\n\n` +
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

    // Real agent processing with streaming + multi-turn tool loop.
    // A single user message drives a full workflow (script → characters →
    // storyboard → shots …): each turn the agent re-reads the canvas and
    // emits the next tool calls until it stops or we hit the turn cap.
    let fullResponse = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; status: "completed" | "failed" }> = [];

    // Callback: broadcast canvas mutations to all clients viewing this canvas
    const onCanvasMutation = (mutation: CanvasMutation) => {
      broadcastToRoom(canvasId, {
        type: "chat.canvas_mutation",
        conversationId,
        mutation,
      });
    };

    // Stream chunks → client (used for every turn)
    const onChunk = (chunk: AIStreamChunk) => {
      switch (chunk.type) {
        case "thinking-start":
          broadcastToConversation(conversationId, {
            type: "chat.thinking", conversationId, content: "思考中…",
          });
          break;
        case "thinking-delta":
          broadcastToConversation(conversationId, {
            type: "chat.thinking", conversationId, content: chunk.thinking ?? "",
          });
          break;
        case "text-delta":
          broadcastToConversation(conversationId, {
            type: "chat.delta", conversationId, content: chunk.text ?? "",
          });
          break;
        case "tool-call":
          if (chunk.toolName) {
            broadcastToConversation(conversationId, {
              type: "chat.tool_call",
              conversationId,
              tool: {
                id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: chunk.toolName,
                args: chunk.toolArgs ?? {},
                status: "running",
              },
            });
          }
          break;
        case "error":
          broadcastToConversation(conversationId, {
            type: "chat.error", conversationId, error: chunk.error ?? "Unknown error",
          });
          break;
      }
    };

    const MAX_AGENT_TURNS = 6;
    const abortController = new AbortController();
    activeChatAbort.set(conversationId, abortController);
    try {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        if (abortController.signal.aborted) break;
        const turnPrompt = turn === 0
          ? content
          : "继续完成创作工作流。先查看当前画布已有节点（见上下文），按需补全，每轮务必至少推进一步：\n" +
            "- 若已有剧本但无角色 → 调用 extract_characters\n" +
            "- 若已有剧本但无分镜 → 调用 generate_storyboard（拆分镜头，含景别与运镜）\n" +
            "- 若分镜已有但无镜头节点 → 调用 create_canvas_nodes 创建 shot 节点（data 用对象，如 {\"ffDesc\": \"画面描述\"}）\n" +
            "- 若镜头已有但无图片节点 → create_canvas_nodes 创建 image 节点（data: {\"prompt\": \"画面描述\", \"size\": \"1024x1024\"}），然后对每个 image 节点调用 run_node 生成图片\n" +
            "- 若图片已有但无视频节点 → create_canvas_nodes 创建 video 节点（data: {\"motionPreset\": \"zoom_in\", \"durationSec\": 4}），然后对每个 video 节点调用 run_node 生成视频\n" +
            "- 若剧本、角色、分镜、镜头、图片、视频都已齐备 → 只回复「完成」并不再调用任何工具。";

        const result = await runDecisionAgent(canvasId, turnPrompt, onChunk, modelId, abortController.signal);
        if (abortController.signal.aborted) break;
        if (result.text.trim()) {
          fullResponse += (fullResponse ? "\n\n" : "") + result.text.trim();
        }

        // Re-read the canvas each turn so new nodes are positioned correctly
        // and the agent's next decision reflects the latest state.
        const canvasCtx = await buildCanvasContext(canvasId);
        const nodeTypeCounts: Record<string, number> = {};
        if (canvasCtx) {
          for (const n of canvasCtx.nodes) {
            nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] ?? 0) + 1;
          }
        }

        if (result.toolCalls.length === 0) break; // agent is done

        for (const tc of result.toolCalls) {
          if (abortController.signal.aborted) break;
          const execResult = await executeToolCall(
            tc.name, tc.args, canvasId,
            { onCanvasMutation, nodeTypeCounts },
          );

          broadcastToConversation(conversationId, {
            type: "chat.tool_result",
            conversationId,
            tool: {
              id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: tc.name, args: tc.args,
              status: execResult.success ? "completed" : "failed",
              result: execResult.result,
            },
          });

          // Canvas mutations are already broadcast inside executeToolCall via
          // the onCanvasMutation callback — rebroadcasting here would deliver
          // each nodes.add twice and duplicate nodes on the client.

          fullResponse += `\n\n${tc.name}: ${execResult.message}`;
          toolCalls.push({ name: tc.name, args: tc.args, status: execResult.success ? "completed" : "failed" });

          if (execResult.success && execResult.canvasMutation?.type === "nodes.add") {
            for (const n of execResult.canvasMutation.nodes) {
              nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] ?? 0) + 1;
            }
          }
        }
      }

      // If no text was generated but tool calls were made, add summary
      if (!fullResponse.trim() && toolCalls.length > 0) {
        fullResponse = `已执行 ${toolCalls.length} 个操作。`;
      }

      // If neither text nor tool calls, provide a fallback
      if (!fullResponse.trim()) {
        fullResponse = abortController.signal.aborted
          ? "已停止生成。"
          : "我已收到您的消息，但暂时无法处理。请确保 AI Provider 已正确配置。";
      }
    } catch (agentErr) {
      if (abortController.signal.aborted) {
        fullResponse = "已停止生成。";
      } else {
        console.error("[ws] Agent error:", agentErr);
        fullResponse = `处理时出错: ${agentErr instanceof Error ? agentErr.message : "Unknown error"}`;
      }
    } finally {
      activeChatAbort.delete(conversationId);
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
