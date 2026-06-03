"use client";

import { useParams } from "next/navigation";
import { InfiniteCanvas } from "@/features/canvas/InfiniteCanvas";

export default function CanvasPage() {
  const params = useParams<{ id: string }>();
  const canvasId = params.id;

  return (
    <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface)",
          gap: 16,
        }}
      >
        <a
          href="/"
          style={{
            fontSize: 13,
            color: "var(--color-text-muted)",
            textDecoration: "none",
          }}
        >
          ← 首页
        </a>
        <h1
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text)",
          }}
        >
          ViMax 画布工作台
        </h1>
        <span
          style={{
            fontSize: 11,
            color: "var(--color-text-muted)",
            fontFamily: "monospace",
          }}
        >
          {canvasId.slice(0, 8)}…
        </span>
      </header>

      {/* Canvas */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <InfiniteCanvas canvasId={canvasId} />
      </div>
    </div>
  );
}
