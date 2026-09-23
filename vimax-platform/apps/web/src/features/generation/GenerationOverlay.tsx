"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasMutation } from "@vimax/contracts";
import { useChatMessages } from "../chat/hooks/useChatMessages";
import { Markdown } from "../chat/Markdown";
import { Button } from "@vimax/ui";

// ── Props ──────────────────────────────────────────────────────────

interface GenerationOverlayProps {
  open: boolean;
  canvasId: string;
  conversationId: string;
  prompt: string;
  mode: "idea" | "script";
  modelId?: string;
  onClose: () => void;
  onNavigate: (canvasId: string) => void;
}

// ── Generation Overlay ─────────────────────────────────────────────
// Full-screen overlay shown on the home page after clicking "generate".
// Displays the AI streaming response, tool calls, and canvas mutations
// in real time. User can navigate to the canvas when done.

export function GenerationOverlay({
  open,
  canvasId,
  conversationId,
  prompt,
  mode,
  modelId,
  onClose,
  onNavigate,
}: GenerationOverlayProps) {
  // Track canvas mutations to show a summary
  const [mutations, setMutations] = useState<CanvasMutation[]>([]);
  const [toolCalls, setToolCalls] = useState<
    Array<{ name: string; status: string }>
  >([]);
  const [isComplete, setIsComplete] = useState(false);

  const handleCanvasMutation = useCallback(
    (mutation: CanvasMutation) => {
      setMutations((prev) => [...prev, mutation]);
    },
    [],
  );

  const {
    messages,
    isStreaming,
    streamingContent,
    thinkingContent,
    wsStatus,
    sendMessage,
    stopStreaming,
  } = useChatMessages({
    canvasId,
    onCanvasMutation: handleCanvasMutation,
    modelId,
  });

  // Auto-send the prompt when conversation is ready
  const sentRef = useRef(false);
  useEffect(() => {
    if (sentRef.current) return;
    if (!conversationId) return;
    sentRef.current = true;

    const prefix =
      mode === "idea"
        ? "【灵感模式】请根据以下创意想法，自动完成编剧、分镜、生成视频的准备：\n\n"
        : mode === "script"
          ? "【剧本模式】请根据以下剧本内容，自动完成分镜和视频生成的准备：\n\n"
          : "";
    sendMessage(prefix + prompt);
  }, [conversationId, prompt, mode, sendMessage]);

  // Track completion
  useEffect(() => {
    if (!isStreaming && messages.length > 1 && sentRef.current) {
      // There's at least a user message + assistant response, and streaming stopped
      const hasAssistant = messages.some((m) => m.role === "assistant");
      if (hasAssistant) setIsComplete(true);
    }
  }, [isStreaming, messages]);

  // Track tool calls from messages metadata
  useEffect(() => {
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    if (assistantMsgs.length === 0) return;
    const last = assistantMsgs[assistantMsgs.length - 1];
    const metadata = last.metadata as Record<string, unknown> | undefined;
    const tc = (metadata?.toolCalls ?? []) as Array<{
      name: string;
      status: string;
    }>;
    if (tc.length > 0) setToolCalls(tc);
  }, [messages]);

  // Auto-scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [streamingContent, thinkingContent, messages]);

  if (!open) return null;

  // Collect node types from mutations
  const createdNodeTypes = mutations
    .filter((m) => m.type === "nodes.add")
    .flatMap((m) =>
      "nodes" in m ? m.nodes.map((n: { type: string }) => n.type) : [],
    );

  const NODE_LABELS: Record<string, string> = {
    script: "剧本",
    character: "角色",
    storyboard_cell: "分镜",
    shot: "镜头",
    image: "图片",
    video: "视频",
    concat: "合成",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          height: "85vh",
          backgroundColor: "var(--color-canvas, #1a1a2e)",
          borderRadius: 16,
          border: "1px solid var(--color-hairline, #2a2a3e)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            flexShrink: 0,
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-hairline, #2a2a3e)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>
              {isComplete ? "✅" : isStreaming ? "✨" : "⏳"}
            </span>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--color-ink, #e0e0e0)",
              }}
            >
              {isComplete
                ? "创作完成"
                : isStreaming
                  ? "AI 正在创作…"
                  : "准备中…"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Connection indicator */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
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
            <button
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--color-hairline, #2a2a3e)",
                backgroundColor: "transparent",
                color: "var(--color-ink-subtle, #888)",
                fontSize: 14,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Content area ── */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* User message */}
          <div
            style={{
              alignSelf: "flex-end",
              maxWidth: "85%",
              padding: "10px 16px",
              borderRadius: "14px 14px 4px 14px",
              backgroundColor: "var(--color-accent, #6366f1)",
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt}
          </div>

          {/* Thinking block */}
          {thinkingContent && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                backgroundColor: "#6366f110",
                border: "1px solid #6366f130",
                fontSize: 12,
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

          {/* Streaming / completed assistant message */}
          {(streamingContent || messages.some((m) => m.role === "assistant")) && (
            <div
              style={{
                alignSelf: "flex-start",
                maxWidth: "90%",
                padding: "12px 16px",
                borderRadius: "14px 14px 14px 4px",
                backgroundColor: "var(--color-surface-1, #24243a)",
                border: "1px solid var(--color-hairline, #2a2a3e)",
                fontSize: 13,
                lineHeight: 1.7,
                color: "var(--color-ink, #e0e0e0)",
              }}
            >
              {streamingContent ? (
                <>
                  <Markdown content={streamingContent} />
                  <span
                    style={{
                      display: "inline-block",
                      width: 2,
                      height: 14,
                      backgroundColor: "var(--color-accent, #6366f1)",
                      marginLeft: 2,
                      verticalAlign: "text-bottom",
                      animation: "blink 1s infinite",
                    }}
                  />
                </>
              ) : (
                messages
                  .filter((m) => m.role === "assistant")
                  .map((m) => <Markdown key={m.id} content={m.content} />)
              )}
            </div>
          )}

          {/* Streaming indicator (no content yet) */}
          {isStreaming && !streamingContent && !thinkingContent && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                backgroundColor: "var(--color-surface-1, #24243a)",
                border: "1px solid var(--color-hairline, #2a2a3e)",
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontSize: 12,
                color: "var(--color-ink-subtle, #888)",
              }}
            >
              <div className="chat-typing-dots">
                <span />
                <span />
                <span />
              </div>
              AI 正在思考…
            </div>
          )}

          {/* Tool calls */}
          {toolCalls.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {toolCalls.map((tc, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#fff",
                    backgroundColor:
                      tc.status === "completed"
                        ? "#22c55e"
                        : tc.status === "running"
                          ? "#f59e0b"
                          : "#6366f1",
                  }}
                >
                  🔧 {tc.name}{" "}
                  {tc.status === "completed"
                    ? "✅"
                    : tc.status === "running"
                      ? "⏳"
                      : ""}
                </span>
              ))}
            </div>
          )}

          {/* Mutation summary */}
          {createdNodeTypes.length > 0 && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                backgroundColor: "#22c55e10",
                border: "1px solid #22c55e30",
                fontSize: 12,
                color: "#4ade80",
                lineHeight: 1.5,
              }}
            >
              📦 画布节点已创建：{" "}
              {createdNodeTypes
                .map((t: string) => NODE_LABELS[t] ?? t)
                .join("、")}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            flexShrink: 0,
            padding: "14px 20px",
            borderTop: "1px solid var(--color-hairline, #2a2a3e)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--color-ink-subtle, #888)" }}>
            {isStreaming
              ? "AI 正在处理中…"
              : isComplete
                ? `生成完成 · ${messages.length} 条消息 · ${mutations.length} 次画布更新`
                : "等待连接…"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isStreaming && (
              <Button
                onClick={stopStreaming}
                size="sm"
                variant="outline"
              >
                ⏹ 停止
              </Button>
            )}
            <Button
              onClick={() => onNavigate(canvasId)}
              disabled={!isComplete && messages.length <= 1}
              size="sm"
            >
              🎬 进入画布
            </Button>
          </div>
        </div>
      </div>

      {/* Blink animation */}
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  );
}
