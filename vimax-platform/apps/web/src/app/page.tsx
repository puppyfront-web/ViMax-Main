"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";

export default function HomePage() {
  const router = useRouter();
  const [newCanvasName, setNewCanvasName] = useState("");
  const createCanvas = trpc.canvas.create.useMutation();
  const deleteCanvas = trpc.canvas.delete.useMutation();
  const listCanvases = trpc.canvas.list.useQuery({ limit: 10 });
  const utils = trpc.useUtils();

  const handleCreateCanvas = async () => {
    if (!newCanvasName.trim()) return;
    try {
      const res = await createCanvas.mutateAsync({ name: newCanvasName.trim() });
      router.push(`/canvas/${res.canvas_id}`);
    } catch (err) {
      console.error("Failed to create canvas:", err);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 80,
        gap: 24,
      }}
    >
      <h1
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: "var(--color-text)",
          letterSpacing: -0.5,
        }}
      >
        ViMax Studio
      </h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 14 }}>
        AI 视频生成工作台
      </p>

      {/* Quick links */}
      <div style={{ display: "flex", gap: 12 }}>
        <a
          href="/studio/image"
          style={{
            padding: "10px 24px",
            borderRadius: 10,
            backgroundColor: "var(--color-accent)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 14,
            textDecoration: "none",
          }}
        >
          🖼️ 生图工坊
        </a>
      </div>

      {/* Create Canvas */}
      <div
        style={{
          width: 400,
          maxWidth: "90vw",
          padding: 24,
          borderRadius: 12,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <p style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
          新建画布
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newCanvasName}
            onChange={(e) => setNewCanvasName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateCanvas()}
            placeholder="画布名称，如：健身教程短片"
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              backgroundColor: "var(--color-bg)",
              color: "var(--color-text)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            onClick={handleCreateCanvas}
            disabled={!newCanvasName.trim() || createCanvas.isPending}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              backgroundColor: "var(--color-accent)",
              color: "#fff",
              fontWeight: 600,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              opacity: !newCanvasName.trim() || createCanvas.isPending ? 0.4 : 1,
            }}
          >
            {createCanvas.isPending ? "创建中…" : "创建"}
          </button>
        </div>
      </div>

      {/* Existing canvases */}
      {listCanvases.data?.items && listCanvases.data.items.length > 0 && (
        <div
          style={{
            width: 400,
            maxWidth: "90vw",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
            已有画布
          </p>
          {listCanvases.data.items.map((c) => (
            <div
              key={c.canvas_id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <a
                href={`/canvas/${c.canvas_id}`}
                style={{
                  flex: 1,
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  backgroundColor: "var(--color-surface)",
                  color: "var(--color-text)",
                  fontSize: 13,
                  textDecoration: "none",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{c.name}</span>
                <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>
                  {c.node_count} 节点 ·{" "}
                  {new Date(c.updated_at).toLocaleDateString("zh-CN")}
                </span>
              </a>
              <button
                onClick={async () => {
                  if (!confirm(`删除 "${c.name}"？此操作不可撤销。`)) return;
                  try {
                    await deleteCanvas.mutateAsync({ canvas_id: c.canvas_id });
                    utils.canvas.list.invalidate();
                  } catch (err) {
                    console.error("Delete failed:", err);
                  }
                }}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid #ef444444",
                  backgroundColor: "transparent",
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  opacity: 0.5,
                  transition: "opacity 0.15s",
                }}
                onMouseOver={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                }}
                onMouseOut={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "0.5";
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
