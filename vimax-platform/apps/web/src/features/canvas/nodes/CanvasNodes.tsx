"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNodeType } from "@vimax/contracts";
import { VIDEO_MOTION_PRESETS } from "@vimax/contracts";

// ── Shared Node Shell ──────────────────────────────────────────────

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

  return (
    <div
      className="node-shell"
      style={{
        minWidth: 220,
        maxWidth: 280,
        borderRadius: 10,
        border: `2px solid ${borderColor}`,
        backgroundColor: "var(--color-surface)",
        boxShadow: shadow,
        transition: "border-color 0.2s, box-shadow 0.2s",
        animation: anim,
      }}
    >
      {/* Input handle */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: isDirty ? "#ef4444" : color,
          border: `2px solid ${isDirty ? "#ef4444" : "var(--color-surface)"}`,
          width: 10,
          height: 10,
        }}
      />

      {/* Header */}
      <div
        className="node-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${isDirty ? "#ef444433" : "var(--color-border)"}`,
        }}
      >
        <span style={{ fontSize: 16 }}>{isDirty ? "⚠️" : TYPE_ICONS[type]}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: isDirty ? "#ef4444" : "var(--color-text)",
          }}
        >
          {isDirty ? `${TYPE_LABELS[type]} · 已过期` : TYPE_LABELS[type]}
        </span>
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
          title={status === "dirty" ? "上游已变更，需重新生成" : status}
        />
      </div>

      {/* Body */}
      <div style={{ padding: "8px 12px", fontSize: 12, lineHeight: 1.5 }}>
        {children}
      </div>

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: color,
          border: "2px solid var(--color-surface)",
          width: 10,
          height: 10,
        }}
      />
    </div>
  );
}

// ── Individual Node Components ─────────────────────────────────────

export function ScriptNode({ data, selected }: NodeProps) {
  const content = (data.content as string) ?? "";
  return (
    <CanvasNodeShell type="script" status={data.status as string} selected={selected}>
      <p style={{ color: "var(--color-text)", wordBreak: "break-word" }}>
        {content.slice(0, 120)}
        {content.length > 120 ? "…" : ""}
      </p>
    </CanvasNodeShell>
  );
}

export function CharacterNode({ data, selected }: NodeProps) {
  const name = (data.name as string) ?? "";
  const desc = (data.description as string) ?? "";
  const frontAssetId = (data.frontAssetId as string) ?? "";
  const sideAssetId = (data.sideAssetId as string) ?? "";
  const backAssetId = (data.backAssetId as string) ?? "";
  return (
    <CanvasNodeShell type="character" status={data.status as string} selected={selected}>
      <p style={{ color: "var(--color-text)", fontWeight: 600 }}>{name || "未命名角色"}</p>
      {desc && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, marginTop: 2 }}>
          {desc.slice(0, 80)}
          {desc.length > 80 ? "…" : ""}
        </p>
      )}
      {(frontAssetId || sideAssetId || backAssetId) && (
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <div style={{ width: 32, height: 32, borderRadius: 4, border: `1px solid ${frontAssetId ? "#22c55e" : "var(--color-border)"}`, backgroundColor: frontAssetId ? "#22c55e22" : "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }} title="正视图">正</div>
          <div style={{ width: 32, height: 32, borderRadius: 4, border: `1px solid ${sideAssetId ? "#22c55e" : "var(--color-border)"}`, backgroundColor: sideAssetId ? "#22c55e22" : "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }} title="侧视图">侧</div>
          <div style={{ width: 32, height: 32, borderRadius: 4, border: `1px solid ${backAssetId ? "#22c55e" : "var(--color-border)"}`, backgroundColor: backAssetId ? "#22c55e22" : "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }} title="背视图">背</div>
        </div>
      )}
    </CanvasNodeShell>
  );
}

export function StoryboardCellNode({ data, selected }: NodeProps) {
  const brief = (data.shotBrief as string) ?? "";
  const camIdx = data.cameraIdx as number | undefined;
  return (
    <CanvasNodeShell type="storyboard_cell" status={data.status as string} selected={selected}>
      <p style={{ color: "var(--color-text)", wordBreak: "break-word" }}>
        {brief.slice(0, 100)}
        {brief.length > 100 ? "…" : ""}
      </p>
      {camIdx != null && (
        <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>
          机位 #{camIdx}
        </span>
      )}
    </CanvasNodeShell>
  );
}

export function ShotNode({ data, selected }: NodeProps) {
  const ffDesc = (data.ffDesc as string) ?? "";
  const motionDesc = (data.motionDesc as string) ?? "";
  return (
    <CanvasNodeShell type="shot" status={data.status as string} selected={selected}>
      {ffDesc && (
        <p style={{ color: "var(--color-text)", wordBreak: "break-word", marginBottom: 4 }}>
          {ffDesc.slice(0, 100)}
          {ffDesc.length > 100 ? "…" : ""}
        </p>
      )}
      {motionDesc && (
        <p style={{ color: "var(--color-text-muted)", fontSize: 11 }}>
          🎬 {motionDesc.slice(0, 60)}
          {motionDesc.length > 60 ? "…" : ""}
        </p>
      )}
    </CanvasNodeShell>
  );
}

export function ImageNode({ data, selected }: NodeProps) {
  const prompt = (data.prompt as string) ?? "";
  const size = (data.size as string) ?? "1024x1024";
  const status = (data.status as string) ?? "idle";
  return (
    <CanvasNodeShell type="image" status={status} selected={selected}>
      <p style={{ color: "var(--color-text)", wordBreak: "break-word" }}>
        {prompt.slice(0, 100)}
        {prompt.length > 100 ? "…" : ""}
      </p>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 4,
          fontSize: 10,
          color: "var(--color-text-muted)",
        }}
      >
        <span>{size}</span>
        <span>{status === "done" ? "✅" : status === "running" ? "⏳" : status === "dirty" ? "⚠️" : "○"}</span>
      </div>
    </CanvasNodeShell>
  );
}

export function VideoNode({ data, selected }: NodeProps) {
  const preset = (data.motionPreset as string) ?? "zoom_in";
  const duration = (data.durationSec as number) ?? 4;
  const status = (data.status as string) ?? "idle";
  const presetInfo = VIDEO_MOTION_PRESETS.find(p => p.id === preset);
  return (
    <CanvasNodeShell type="video" status={status} selected={selected}>
      <p style={{ color: "var(--color-text)" }}>
        运镜: {presetInfo?.label ?? preset}
      </p>
      <p style={{ color: "var(--color-text-muted)", fontSize: 11, marginTop: 2 }}>
        时长: {duration}s
      </p>
    </CanvasNodeShell>
  );
}

export function ConcatNode({ data, selected }: NodeProps) {
  const transition = (data.transition as string) ?? "dissolve";
  return (
    <CanvasNodeShell type="concat" status={data.status as string} selected={selected}>
      <p style={{ color: "var(--color-text)" }}>
        转场: {transition}
      </p>
      <p style={{ color: "var(--color-text-muted)", fontSize: 10, marginTop: 2 }}>
        连接上游视频片段
      </p>
    </CanvasNodeShell>
  );
}
