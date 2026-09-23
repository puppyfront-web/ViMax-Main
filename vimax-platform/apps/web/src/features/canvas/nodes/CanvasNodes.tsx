"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { CanvasNodeType } from "@vimax/contracts";
import { ModelSelect } from "@/features/models/ModelSelect";

// ── Toonflow-style constants ────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  idle: "#555",
  running: "#f59e0b",
  done: "#22c55e",
  dirty: "#ef4444",
  failed: "#ef4444",
};

const TYPE_LABELS: Record<CanvasNodeType, string> = {
  script: "剧本",
  character: "角色",
  storyboard_cell: "分镜格",
  shot: "镜头",
  image: "首帧",
  video: "视频",
  concat: "合成",
};

const TYPE_ICONS: Record<CanvasNodeType, string> = {
  script: "📜",
  character: "👤",
  storyboard_cell: "🎬",
  shot: "🎥",
  image: "🖼️",
  video: "▶️",
  concat: "🔗",
};

const TYPE_COLORS: Record<CanvasNodeType, string> = {
  script: "#f59e0b",
  character: "#ec4899",
  storyboard_cell: "#06b6d4",
  shot: "#3b82f6",
  image: "#6366f1",
  video: "#22c55e",
  concat: "#a855f7",
};

// ── Toonflow-style Canvas Node Shell ────────────────────────────────
// Replicates Toonflow's node design:
// - Black title badge (5px 10px padding, border-radius 8px 0, 16px font)
// - .dragHandle on title bar (cursor: grab)
// - Side handles (Left=source, Right=target) with offset
// - Status indicators (4 states: idle/running/done/dirty/failed)
// - Connection handles on left/right (matching Toonflow's LR flow)

export interface CanvasNodeShellProps {
  type: CanvasNodeType;
  status?: string;
  selected?: boolean;
  children: React.ReactNode;
}

export function CanvasNodeShell({
  type,
  status = "idle",
  selected = false,
  children,
}: CanvasNodeShellProps) {
  const color = TYPE_COLORS[type];
  const dotColor = STATUS_COLORS[status] ?? STATUS_COLORS.idle;
  const isRunning = status === "running";
  const isDirty = status === "dirty";
  const isFailed = status === "failed";
  const isDone = status === "done";

  const borderColor = isDirty || isFailed
    ? "#ef4444"
    : selected
      ? color
      : "var(--color-border)";

  const shadow = selected
    ? `0 0 16px ${color}33`
    : isRunning
      ? `0 0 12px ${color}66, 0 0 24px ${color}22`
    : isDirty
      ? "0 0 8px #ef444444, 0 0 16px #ef444422"
    : isFailed
      ? "0 0 8px #ef444444"
    : "0 2px 8px rgba(0,0,0,0.3)";

  const anim = isRunning
    ? "nodePulse 1.5s ease-in-out infinite"
    : isDirty
      ? "nodeDirtyPulse 2s ease-in-out infinite"
    : undefined;

  // Status badge text (Toonflow-style: "生成中"/"已完成"/"生成失败")
  const statusText: Record<string, string> = {
    idle: "",
    running: "⏳ 生成中",
    done: "✅ 已完成",
    dirty: "⚠️ 已过期",
    failed: "❌ 失败",
  };

  return (
    <div
      className="node-shell"
      style={{
        minWidth: 220,
        maxWidth: 320,
        borderRadius: 10,
        border: `2px solid ${borderColor}`,
        backgroundColor: "var(--color-surface)",
        boxShadow: shadow,
        transition: "border-color 0.2s, box-shadow 0.2s",
        animation: anim,
        position: "relative",
        overflow: "visible",
      }}
    >
      {/* Left target handle (Toonflow-style: offset for LR flow) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: isDirty ? "#ef4444" : color,
          border: `2px solid var(--color-surface)`,
          width: 10,
          height: 10,
          left: -5,
        }}
      />

      {/* ── Title bar with drag handle (Toonflow pattern) ── */}
      <div
        className="dragHandle"
        style={{
          cursor: "grab",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px 6px",
        }}
      >
        {/* Toonflow-style title badge: black bg, white text */}
        <div
          style={{
            backgroundColor: isDirty || isFailed ? "#ef4444" : "#000",
            padding: "4px 10px",
            color: "#fff",
            borderRadius: "8px 0",
            fontSize: 13,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 14 }}>{TYPE_ICONS[type]}</span>
          {TYPE_LABELS[type]}
        </div>

        {/* Status dot */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: dotColor,
            marginLeft: "auto",
            flexShrink: 0,
          }}
          title={status}
        />
      </div>

      {/* Status bar (Toonflow-style: shows generation status) */}
      {statusText[status] && (
        <div
          style={{
            padding: "0 12px 4px",
            fontSize: 10,
            color: isRunning ? "#f59e0b" : isDone ? "#22c55e" : isFailed ? "#ef4444" : "#ef4444",
          }}
        >
          {statusText[status]}
        </div>
      )}

      {/* Divider line */}
      <div
        style={{
          height: 1,
          backgroundColor: isDirty ? "#ef444433" : "var(--color-border)",
          margin: "0 12px",
        }}
      />

      {/* Body content */}
      <div style={{ padding: "8px 12px", fontSize: 12, lineHeight: 1.5 }}>
        {children}
      </div>

      {/* Right source handle (Toonflow-style: offset for LR flow) */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: color,
          border: "2px solid var(--color-surface)",
          width: 10,
          height: 10,
          right: -5,
        }}
      />

      {/* Done indicator: subtle green top border glow */}
      {isDone && (
        <div
          style={{
            position: "absolute",
            top: -2,
            left: 10,
            right: 10,
            height: 2,
            backgroundColor: "#22c55e",
            borderRadius: 1,
          }}
        />
      )}
    </div>
  );
}

// ── Individual Node Components ─────────────────────────────────────

export function ScriptNode({ data, selected }: NodeProps) {
  const content = (data.content as string) ?? "";
  return (
    <CanvasNodeShell type="script" status={data.status as string} selected={selected}>
      <p style={{ color: "var(--color-text)", wordBreak: "break-word", margin: 0 }}>
        {content.slice(0, 150)}
        {content.length > 150 ? "…" : ""}
      </p>
    </CanvasNodeShell>
  );
}

export function CharacterNode({ id, data, selected }: NodeProps) {
  const name = (data.name as string) ?? "新角色";
  const desc = (data.description as string) ?? "";
  const modelId = (data.modelId as string) ?? "";
  const { updateNodeData } = useReactFlow();

  const handleModelChange = (newModelId: string) => {
    updateNodeData(id, { ...data, modelId: newModelId });
  };

  return (
    <CanvasNodeShell type="character" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 20 }}>👤</span>
        <span style={{ fontWeight: 600, color: "var(--color-text)" }}>{name}</span>
      </div>
      {desc && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, margin: "4px 0 0", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {desc}
        </p>
      )}
      <div style={{ marginTop: 6, borderTop: "1px solid var(--color-border)", paddingTop: 6 }}>
        <ModelSelect
          type="image"
          value={modelId}
          onChange={handleModelChange}
          compact
          placeholder="图像模型"
        />
      </div>
    </CanvasNodeShell>
  );
}

export function StoryboardCellNode({ data, selected }: NodeProps) {
  const brief = (data.shotBrief as string) ?? "";
  return (
    <CanvasNodeShell type="storyboard_cell" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "#06b6d4" }}>机位 #{(data.cameraIdx as number) ?? 0}</span>
      </div>
      {brief && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, margin: 0, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {brief}
        </p>
      )}
    </CanvasNodeShell>
  );
}

export function ShotNode({ id, data, selected }: NodeProps) {
  const ffDesc = (data.ffDesc as string) ?? "";
  const motion = (data.motionDesc as string) ?? "";
  const modelId = (data.modelId as string) ?? "";
  const { updateNodeData } = useReactFlow();

  const handleModelChange = (newModelId: string) => {
    updateNodeData(id, { ...data, modelId: newModelId });
  };

  return (
    <CanvasNodeShell type="shot" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {ffDesc && (
          <div style={{ fontSize: 11 }}>
            <span style={{ color: "#3b82f6", fontWeight: 600 }}>首帧:</span>{" "}
            <span style={{ color: "var(--color-text-muted)" }}>{ffDesc.slice(0, 80)}{ffDesc.length > 80 ? "…" : ""}</span>
          </div>
        )}
        {motion && (
          <div style={{ fontSize: 11 }}>
            <span style={{ color: "#f59e0b", fontWeight: 600 }}>运动:</span>{" "}
            <span style={{ color: "var(--color-text-muted)" }}>{motion}</span>
          </div>
        )}
      </div>
      <div style={{ marginTop: 6, borderTop: "1px solid var(--color-border)", paddingTop: 6 }}>
        <ModelSelect
          type="image"
          value={modelId}
          onChange={handleModelChange}
          compact
          placeholder="图像模型"
        />
      </div>
    </CanvasNodeShell>
  );
}

export function ImageNode({ id, data, selected }: NodeProps) {
  const prompt = (data.prompt as string) ?? "";
  const size = (data.size as string) ?? "1024x1024";
  const modelId = (data.modelId as string) ?? "";
  const { updateNodeData } = useReactFlow();

  const handleModelChange = (newModelId: string) => {
    updateNodeData(id, { ...data, modelId: newModelId });
  };

  return (
    <CanvasNodeShell type="image" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, backgroundColor: "#6366f122", color: "#6366f1" }}>
          {size}
        </span>
        <ModelSelect
          type="image"
          value={modelId}
          onChange={handleModelChange}
          compact
          placeholder="模型"
        />
      </div>
      {prompt && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {prompt}
        </p>
      )}
    </CanvasNodeShell>
  );
}

export function VideoNode({ id, data, selected }: NodeProps) {
  const motion = (data.motionPreset as string) ?? "";
  const duration = (data.durationSec as number) ?? 4;
  const modelId = (data.modelId as string) ?? "";
  const { updateNodeData } = useReactFlow();

  const handleModelChange = (newModelId: string) => {
    updateNodeData(id, { ...data, modelId: newModelId });
  };

  return (
    <CanvasNodeShell type="video" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, backgroundColor: "#22c55e22", color: "#22c55e" }}>
          {duration}s
        </span>
        {motion && (
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {motion}
          </span>
        )}
      </div>
      <ModelSelect
        type="video"
        value={modelId}
        onChange={handleModelChange}
        compact
        placeholder="视频模型"
      />
    </CanvasNodeShell>
  );
}

export function ConcatNode({ data, selected }: NodeProps) {
  const transition = (data.transition as string) ?? "dissolve";
  return (
    <CanvasNodeShell type="concat" status={data.status as string} selected={selected}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          转场: {transition}
        </span>
      </div>
    </CanvasNodeShell>
  );
}
