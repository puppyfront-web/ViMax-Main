"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasMutation, AgentMessage } from "@vimax/contracts";
import { useChatMessages } from "./hooks/useChatMessages";
import { Markdown } from "./Markdown";
import { ModelSelect } from "@/features/models/ModelSelect";

// ── Chat Panel Props ────────────────────────────────────────────────

interface ChatPanelProps {
  canvasId: string;
  /** Called when agent sends a canvas mutation */
  onCanvasMutation?: (mutation: CanvasMutation) => void;
  /** Whether the panel is visible */
  visible: boolean;
  /** Default text model ID (from home page or canvas context) */
  defaultTextModelId?: string;
  /** Initial prompt to auto-send when conversation is ready (from home page) */
  initialPrompt?: string;
  /** Initial creation mode (e.g. "idea" or "script") */
  initialMode?: string;
}

// ── Chat Panel Component ────────────────────────────────────────────
// Right-side panel that provides an AI chat interface for the canvas.
// Replicates Toonflow's right-side chat box (rightChatBox) pattern.

export function ChatPanel({ canvasId, onCanvasMutation, visible, defaultTextModelId, initialPrompt, initialMode }: ChatPanelProps) {
  const [modelId, setModelId] = useState(defaultTextModelId ?? "");

  const {
    messages,
    conversationId,
    isStreaming,
    streamingContent,
    thinkingContent,
    wsStatus,
    sendMessage,
    createConversation,
    stopStreaming,
    conversations,
  } = useChatMessages({
    canvasId,
    onCanvasMutation,
    modelId,
  });

  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showConvList, setShowConvList] = useState(false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, thinkingContent]);

  // Auto-send initial prompt from home page (once only)
  const initialSentRef = useRef(false);
  useEffect(() => {
    if (initialSentRef.current) return;
    if (!initialPrompt || !conversationId) return;
    initialSentRef.current = true;

    // Prefix with mode context if available
    const prefix = initialMode === "idea"
      ? "【灵感模式】请根据以下创意想法，自动完成编剧、分镜、生成视频的准备：\n\n"
      : initialMode === "script"
        ? "【剧本模式】请根据以下剧本内容，自动完成分镜和视频生成的准备：\n\n"
        : "";
    sendMessage(prefix + initialPrompt);
  }, [conversationId, initialPrompt, initialMode, sendMessage]);

  // Handle send
  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || (!conversationId && !isStreaming)) return;

    if (!conversationId) {
      // Will create conversation first, then send
      createConversation().then(() => sendMessage(text));
    } else {
      sendMessage(text);
    }
    setInputValue("");

    // Refocus input
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [inputValue, conversationId, isStreaming, sendMessage, createConversation]);

  // Handle Enter key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!visible) return null;

  return (
    <div
      style={{
        width: 380,
        flexShrink: 0,
        borderLeft: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          flexShrink: 0,
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
          💬 AI 助手
        </span>

        {/* Model selector */}
        <div style={{ flexShrink: 0 }}>
          <ModelSelect
            type="text"
            value={modelId}
            onChange={setModelId}
            compact
            placeholder="模型"
          />
        </div>

        {/* Connection status indicator */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10,
            color:
              wsStatus === "connected"
                ? "#22c55e"
                : wsStatus === "connecting"
                  ? "#f59e0b"
                  : "#ef4444",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor:
                wsStatus === "connected"
                  ? "#22c55e"
                  : wsStatus === "connecting"
                    ? "#f59e0b"
                    : "#ef4444",
            }}
          />
          {wsStatus === "connected"
            ? "已连接"
            : wsStatus === "connecting"
              ? "连接中…"
              : "未连接"}
        </div>

        {/* New conversation button */}
        <button
          onClick={async () => {
            await createConversation();
          }}
          title="新建会话"
          style={{
            padding: "3px 8px",
            borderRadius: 5,
            border: "1px solid var(--color-border)",
            backgroundColor: "transparent",
            color: "var(--color-text-muted)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ✨ 新会话
        </button>
      </div>

      {/* ── Conversation list (collapsible) ── */}
      {conversations.length > 1 && (
        <div
          style={{
            flexShrink: 0,
            borderBottom: showConvList ? "1px solid var(--color-border)" : "none",
          }}
        >
          <button
            onClick={() => setShowConvList(!showConvList)}
            style={{
              width: "100%",
              padding: "6px 14px",
              border: "none",
              backgroundColor: "transparent",
              color: "var(--color-text-muted)",
              fontSize: 10,
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            📋 历史会话 ({conversations.length}){" "}
            {showConvList ? "▲" : "▼"}
          </button>

          {showConvList && (
            <div style={{ maxHeight: 120, overflowY: "auto" }}>
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => {
                    // useChatMessages.switchConversation(conv.id);
                    setShowConvList(false);
                  }}
                  style={{
                    padding: "5px 14px",
                    fontSize: 11,
                    color:
                      conv.id === conversationId
                        ? "var(--color-accent)"
                        : "var(--color-text-muted)",
                    backgroundColor:
                      conv.id === conversationId
                        ? "var(--color-bg)"
                        : "transparent",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  {conv.title ?? `会话 ${conv.id.slice(0, 8)}…`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Messages area ── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {/* Empty state */}
        {messages.length === 0 && !isStreaming && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              opacity: 0.5,
            }}
          >
            <span style={{ fontSize: 32 }}>🤖</span>
            <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              AI 助手准备就绪
            </span>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
              输入指令开始创作
            </span>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 10,
                color: "var(--color-text-muted)",
                opacity: 0.7,
              }}
            >
              <span>💡 "写一个关于…的剧本"</span>
              <span>💡 "生成角色肖像"</span>
              <span>💡 "使用动漫风格"</span>
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <ChatMessageBubble key={msg.id} message={msg} />
        ))}

        {/* Thinking block */}
        {thinkingContent && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              backgroundColor: "#6366f110",
              border: "1px solid #6366f130",
              fontSize: 11,
              color: "#818cf8",
              lineHeight: 1.5,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginBottom: 4,
                fontSize: 10,
                fontWeight: 600,
              }}
            >
              🧠 思考中…
            </div>
            <div style={{ whiteSpace: "pre-wrap", opacity: 0.8 }}>
              {thinkingContent}
            </div>
          </div>
        )}

        {/* Streaming message */}
        {isStreaming && streamingContent && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              backgroundColor: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              fontSize: 12,
              color: "var(--color-text)",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {streamingContent}
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 14,
                backgroundColor: "var(--color-accent)",
                marginLeft: 2,
                verticalAlign: "text-bottom",
                animation: "blink 1s infinite",
              }}
            />
          </div>
        )}

        {/* Streaming indicator (no content yet) */}
        {isStreaming && !streamingContent && !thinkingContent && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              backgroundColor: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              display: "flex",
              gap: 4,
              alignItems: "center",
            }}
          >
            <div className="chat-typing-dots">
              <span /><span /><span />
            </div>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
              AI 正在思考…
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input area ── */}
      <div
        style={{
          flexShrink: 0,
          padding: "10px 14px",
          borderTop: "1px solid var(--color-border)",
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            conversationId ? "输入指令… (Enter 发送, Shift+Enter 换行)" : "点击「新会话」开始…"
          }
          disabled={!conversationId && !isStreaming}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            backgroundColor: "var(--color-bg)",
            color: "var(--color-text)",
            fontSize: 12,
            lineHeight: 1.5,
            outline: "none",
            maxHeight: 120,
            fontFamily: "inherit",
          }}
          onFocus={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor =
              "var(--color-accent)";
          }}
          onBlur={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor =
              "var(--color-border)";
          }}
        />
        {isStreaming ? (
          <button
            onClick={stopStreaming}
            title="停止生成"
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ef4444",
              backgroundColor: "#ef444422",
              color: "#ef4444",
              fontSize: 12,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            ⏹
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || !conversationId}
            title="发送消息 (Enter)"
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-accent)",
              backgroundColor:
                inputValue.trim() && conversationId
                  ? "var(--color-accent)"
                  : "transparent",
              color:
                inputValue.trim() && conversationId ? "#fff" : "var(--color-text-muted)",
              fontSize: 12,
              cursor:
                inputValue.trim() && conversationId ? "pointer" : "not-allowed",
              fontWeight: 600,
              transition: "all 0.15s",
            }}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}

// ── Chat Message Bubble ─────────────────────────────────────────────

function ChatMessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);

  // Extract tool calls and thinking from metadata
  const metadata = message.metadata as Record<string, unknown>;
  const toolCalls = (metadata?.toolCalls ?? []) as Array<{
    name: string;
    status: string;
  }>;
  const thinking = metadata?.thinking as string | undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      {/* Role label */}
      <span
        style={{
          fontSize: 9,
          color: "var(--color-text-muted)",
          fontWeight: 600,
          padding: "0 4px",
        }}
      >
        {isUser ? "👤 你" : "🤖 AI"}
      </span>

      {/* Message bubble */}
      <div
        style={{
          maxWidth: "90%",
          padding: "8px 12px",
          borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
          backgroundColor: isUser ? "var(--color-accent)" : "var(--color-bg)",
          color: isUser ? "#fff" : "var(--color-text)",
          fontSize: 12,
          lineHeight: 1.6,
          wordBreak: "break-word",
          border: isUser ? "none" : "1px solid var(--color-border)",
        }}
      >
        {isUser ? (
          <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
        ) : (
          <Markdown content={message.content} />
        )}
      </div>

      {/* Thinking (collapsible) */}
      {thinking && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid #6366f130",
            backgroundColor: "#6366f108",
            color: "#818cf8",
            fontSize: 9,
            cursor: "pointer",
          }}
        >
          🧠 {expanded ? "隐藏" : "显示"}推理过程
        </button>
      )}
      {thinking && expanded && (
        <div
          style={{
            maxWidth: "90%",
            padding: "6px 10px",
            borderRadius: 6,
            backgroundColor: "#6366f108",
            border: "1px solid #6366f120",
            fontSize: 10,
            color: "#818cf8",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            opacity: 0.8,
          }}
        >
          {thinking}
        </div>
      )}

      {/* Tool calls */}
      {toolCalls.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {toolCalls.map((tc, i) => {
            const statusColor =
              tc.status === "completed" ? "var(--color-ai-generating)" :
              tc.status === "running" ? "var(--color-ai-reading)" :
              tc.status === "failed" ? "var(--color-ai-error)" :
              "var(--color-ink-subtle)";
            return (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[var(--tracking-eyebrow)]"
              style={{
                color: "#ffffff",
                backgroundColor: statusColor,
              }}
            >
              {tc.name}
            </span>
          )})}
        </div>
      )}

      {/* Timestamp */}
      <span
        style={{
          fontSize: 9,
          color: "var(--color-text-muted)",
          opacity: 0.5,
          padding: "0 4px",
        }}
      >
        {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </div>
  );
}
