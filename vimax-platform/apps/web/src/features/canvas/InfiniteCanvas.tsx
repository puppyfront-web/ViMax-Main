"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type Node,
  type Connection,
  type NodeChange,
  addEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ScriptNode,
  CharacterNode,
  StoryboardCellNode,
  ShotNode,
  ImageNode,
  VideoNode,
  ConcatNode,
} from "./nodes/CanvasNodes";
import { NodeInspector } from "./panels/NodeInspector";
import { useCanvasSnapshot, useCanvasSave } from "./hooks/useCanvasSnapshot";
import { useNodeRun } from "./hooks/useNodeRun";
import { trpc } from "@/lib/trpc/client";
import type { CanvasNodeType } from "@vimax/contracts";

// ── React Flow node type registry ──────────────────────────────────

const nodeTypes = {
  script: ScriptNode,
  character: CharacterNode,
  storyboard_cell: StoryboardCellNode,
  shot: ShotNode,
  image: ImageNode,
  video: VideoNode,
  concat: ConcatNode,
};

// ── Zone layout (LibTV-style spatial organization) ─────────────────

const ZONE_LAYOUT: Record<CanvasNodeType, { x: number; y: number }> = {
  script: { x: 40, y: 60 },
  character: { x: 40, y: 300 },
  storyboard_cell: { x: 360, y: 60 },
  shot: { x: 680, y: 160 },
  image: { x: 1020, y: 60 },
  video: { x: 1360, y: 160 },
  concat: { x: 1020, y: 420 },
};

const ZONE_OFFSET = 280; // vertical offset for stacking multiple nodes of same type

// ── Props ──────────────────────────────────────────────────────────

interface InfiniteCanvasProps {
  canvasId: string;
}

// ── Component ──────────────────────────────────────────────────────

export function InfiniteCanvas({ canvasId }: InfiniteCanvasProps) {
  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    canvasName,
    viewport: initialViewport,
    isLoading,
    isError,
    error,
    refetch,
  } = useCanvasSnapshot(canvasId);

  const { save } = useCanvasSave(canvasId);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const { runNode, isRunning, runningNodeId, progress, error: runError } = useNodeRun({
    canvasId,
    setNodes,
    edges,
  });

  // ── Node stats ───────────────────────────────────────────────────

  const stats = useMemo(() => {
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const n of nodes) {
      const t = n.type ?? "unknown";
      byType[t] = (byType[t] ?? 0) + 1;
      const s = (n.data as Record<string, unknown> | undefined)
        ?.status as string ?? "idle";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return { byType, byStatus, total: nodes.length };
  }, [nodes]);

  // ── Auto-arrange ─────────────────────────────────────────────────

  const handleAutoArrange = useCallback(() => {
    const typeCounts: Record<string, number> = {};
    setNodes((nds) => {
      const arranged = nds.map((n) => {
        const type = (n.type ?? "image") as CanvasNodeType;
        const zone = ZONE_LAYOUT[type] ?? { x: 100, y: 100 };
        const idx = typeCounts[type] ?? 0;
        typeCounts[type] = idx + 1;
        return {
          ...n,
          position: {
            x: zone.x + (idx % 3) * 20,
            y: zone.y + Math.floor(idx / 3) * ZONE_OFFSET,
          },
        };
      });
      save(arranged, edges);
      return arranged;
    });
  }, [edges, save, setNodes]);

  // ── Batch generate with DAG topological ordering ──────────────────

  const runnableCount = useMemo(
    () => nodes.filter((n) => RUNNABLE_TYPES.has(n.type ?? "")).length,
    [nodes],
  );

  const handleBatchGenerate = useCallback(async () => {
    // Topological sort: upstream nodes run first
    const runnable = new Set(
      nodes.filter((n) => RUNNABLE_TYPES.has(n.type ?? "")).map((n) => n.id),
    );
    // Build adjacency (source → targets)
    const incoming = new Map<string, string[]>(); // node → upstream nodes
    for (const n of nodes) incoming.set(n.id, []);
    for (const e of edges) {
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target)!.push(e.source);
    }

    // Kahn's algorithm for topo sort
    const queue: string[] = [];
    const inDegree = new Map<string, number>();
    for (const n of nodes) {
      const deg = (incoming.get(n.id) ?? []).filter((src) => runnable.has(src)).length;
      inDegree.set(n.id, deg);
      if (deg === 0 && runnable.has(n.id)) queue.push(n.id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const e of edges) {
        if (e.source === id && runnable.has(e.target)) {
          const deg = (inDegree.get(e.target) ?? 1) - 1;
          inDegree.set(e.target, deg);
          if (deg === 0) queue.push(e.target);
        }
      }
    }

    // Add any remaining runnable nodes (shouldn't happen in a DAG)
    for (const n of nodes) {
      if (runnable.has(n.id) && !order.includes(n.id)) order.push(n.id);
    }

    // Run in order
    let idx = 0;
    for (const nodeId of order) {
      idx++;
      console.log(`[batch] ${idx}/${order.length}: ${nodeId.slice(0, 8)}…`);
      try {
        await runNode(nodeId);
      } catch {
        // Continue to next node on failure
      }
    }
  }, [nodes, edges, runNode]);

  // ── Delete node ───────────────────────────────────────────────────

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) =>
        eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      save(
        nodes.filter((n) => n.id !== nodeId),
        edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setSelectedNode(null);
    },
    [nodes, edges, save, setNodes, setEdges],
  );

  // ── Update node data (from inspector editing) ─────────────────────

  const handleUpdateNodeData = useCallback(
    (nodeId: string, key: string, value: unknown) => {
      setNodes((nds) => {
        const updated = nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, [key]: value } }
            : n,
        );
        save(updated, edges);
        return updated;
      });
      // Update selectedNode reference too
      setSelectedNode((prev) =>
        prev?.id === nodeId
          ? { ...prev, data: { ...prev.data, [key]: value } }
          : prev,
      );
    },
    [edges, save, setNodes],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Delete / Backspace → remove selected node
      if ((event.key === "Delete" || event.key === "Backspace") && selectedNode) {
        // Don't delete if user is typing in an input
        const tag = (event.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        event.preventDefault();
        handleDeleteNode(selectedNode.id);
      }
      // Escape → deselect
      if (event.key === "Escape") {
        setSelectedNode(null);
      }
      // Ctrl+S → force save
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        save(nodes, edges);
      }
    },
    [selectedNode, handleDeleteNode, nodes, edges, save],
  );

  // ── Handlers ─────────────────────────────────────────────────────

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChange(changes);
      const hasPositionChange = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (hasPositionChange) {
        save(nodes, edges);
      }
    },
    [onNodesChange, nodes, edges, save],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const newEdges = addEdge(connection, edges);
      setEdges(newEdges);
      save(nodes, newEdges);
    },
    [edges, nodes, save, setEdges],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedNode(node);
    },
    [],
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // ── Drop handler ─────────────────────────────────────────────────

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // File upload hooks
  const requestUpload = trpc.asset.requestUpload.useMutation();
  const confirmUpload = trpc.asset.confirmUpload.useMutation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleDrop = useCallback(
    async (event: DragEvent) => {
      event.preventDefault();

      // 1. Check for node type drag
      const nodeType = event.dataTransfer.getData("application/reactflow-type") as
        | CanvasNodeType
        | "";
      if (nodeType && nodeTypes[nodeType]) {
        const position = {
          x: event.clientX - 100,
          y: event.clientY - 40,
        };
        const newNode: Node = {
          id: crypto.randomUUID(),
          type: nodeType,
          position,
          data: getDefaultData(nodeType),
        };
        setNodes((nds) => {
          const updated = [...nds, newNode];
          save(updated, edges);
          return updated;
        });
        return;
      }

      // 2. Check for image file drop
      const files = event.dataTransfer.files;
      if (files.length > 0) {
        await handleFileDrop(files[0], event.clientX, event.clientY);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, save, setNodes],
  );

  async function handleFileDrop(file: File, clientX: number, clientY: number) {
    if (!file.type.startsWith("image/")) return;
    setUploading(true);
    try {
      // 1. Request presigned URL
      const req = await requestUpload.mutateAsync({
        mime_type: file.type as "image/png" | "image/jpeg" | "image/webp",
        size_bytes: file.size,
      });

      // 2. Upload directly to MinIO
      await fetch(req.upload_url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      // 3. Compute SHA256 + dimensions
      const buf = await file.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", buf);
      const sha256 = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = URL.createObjectURL(file);
      });

      await confirmUpload.mutateAsync({
        asset_id: req.asset_id,
        sha256,
        width: dims.w,
        height: dims.h,
      });

      // 4. Create an image node with the uploaded asset as reference
      const position = { x: clientX - 100, y: clientY - 40 };
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: "image",
        position,
        data: {
          prompt: `参考图: ${file.name}`,
          modelId: "doubao-seedream-4-0",
          size: "1024x1024",
          referenceAssetIds: [req.asset_id],
          status: "idle",
        },
      };
      setNodes((nds) => {
        const updated = [...nds, newNode];
        save(updated, edges);
        return updated;
      });
    } catch (err) {
      console.error("[canvas] File upload failed:", err);
    } finally {
      setUploading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p style={{ color: "var(--color-text-muted)" }}>加载画布…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p style={{ color: "#ef4444" }}>加载失败: {error}</p>
        <button
          onClick={refetch}
          className="px-4 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:border-[var(--color-accent)]"
        >
          重试
        </button>
      </div>
    );
  }

  const isDemo = canvasName.includes("离线模式");

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", flexDirection: "column" }}>
      {/* Demo banner */}
      {isDemo && (
        <div
          style={{
            flexShrink: 0,
            padding: "6px 16px",
            backgroundColor: "#f59e0b22",
            borderBottom: "1px solid #f59e0b44",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 12 }}>⚠️</span>
          <span style={{ fontSize: 12, color: "#f59e0b" }}>
            离线 Demo 模式 — 后端服务未启动，展示示例画布。可拖拽节点、连线、选中查看属性。
          </span>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ── Left: Categorized Node Palette ── */}
        <NodePalette />

        {/* ── Center: Flow Canvas ── */}
        <div
          style={{ flex: 1, height: "100%", position: "relative", outline: "none" }}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            defaultViewport={initialViewport}
            fitView
            style={{ backgroundColor: "var(--color-bg)" }}
          >
            {/* Grid background */}
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#333"
            />

            {/* Zone labels — subtle background guides */}
            <ZoneLabels />

            <Controls
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
              }}
            />
            <MiniMap
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
              }}
              maskColor="rgba(0,0,0,0.6)"
              nodeColor={(n) => {
                const colors: Record<string, string> = {
                  script: "#f59e0b",
                  character: "#ec4899",
                  storyboard_cell: "#06b6d4",
                  shot: "#3b82f6",
                  image: "#6366f1",
                  video: "#22c55e",
                  concat: "#a855f7",
                };
                return colors[n.type ?? ""] ?? "#6366f1";
              }}
            />
          </ReactFlow>
        </div>

        {/* ── Right: Inspector ── */}
        <NodeInspector
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
          onRunNode={runNode}
          onDeleteNode={handleDeleteNode}
          onUpdateNodeData={handleUpdateNodeData}
          isRunning={isRunning}
          runningNodeId={runningNodeId}
          progress={progress}
          runError={runError}
          edges={edges}
          nodes={nodes}
          canvasId={canvasId}
        />
      </div>

      {/* ── Bottom Toolbar (LibTV-style) ── */}
      <BottomToolbar
        stats={stats}
        canvasName={canvasName}
        onAutoArrange={handleAutoArrange}
        onBatchGenerate={handleBatchGenerate}
        isRunning={isRunning}
        runnableCount={runnableCount}
        uploading={uploading}
        nodes={nodes}
        runNode={runNode}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Categorized Node Palette (LibTV-style groups)
// ══════════════════════════════════════════════════════════════════════

const PALETTE_GROUPS: {
  label: string;
  icon: string;
  color: string;
  items: { type: CanvasNodeType; label: string; icon: string }[];
}[] = [
  {
    label: "叙事",
    icon: "📝",
    color: "#f59e0b",
    items: [
      { type: "script", label: "剧本", icon: "📜" },
      { type: "storyboard_cell", label: "分镜格", icon: "🎬" },
    ],
  },
  {
    label: "资产",
    icon: "🎨",
    color: "#ec4899",
    items: [
      { type: "character", label: "角色", icon: "👤" },
      { type: "image", label: "首帧/末帧", icon: "🖼️" },
    ],
  },
  {
    label: "制作",
    icon: "🎬",
    color: "#3b82f6",
    items: [
      { type: "shot", label: "镜头", icon: "🎥" },
      { type: "video", label: "视频片段", icon: "▶️" },
    ],
  },
  {
    label: "后期",
    icon: "🔧",
    color: "#a855f7",
    items: [
      { type: "concat", label: "合成导出", icon: "🔗" },
    ],
  },
];

function NodePalette() {
  const onDragStart = (event: DragEvent, nodeType: CanvasNodeType) => {
    event.dataTransfer.setData("application/reactflow-type", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      style={{
        width: 152,
        flexShrink: 0,
        borderRight: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "10px 10px 6px",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--color-text-muted)",
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        节点面板
      </div>

      {PALETTE_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 2 }}>
          {/* Group header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "6px 10px 2px",
              fontSize: 10,
              fontWeight: 600,
              color: group.color,
              opacity: 0.8,
            }}
          >
            <span>{group.icon}</span>
            <span>{group.label}</span>
          </div>

          {/* Group items */}
          {group.items.map((item) => (
            <div
              key={item.type}
              draggable
              onDragStart={(e) => onDragStart(e, item.type)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "2px 8px",
                padding: "7px 10px",
                borderRadius: 7,
                border: "1px solid transparent",
                backgroundColor: "transparent",
                cursor: "grab",
                fontSize: 12,
                color: "var(--color-text)",
                userSelect: "none",
                transition: "all 0.15s",
              }}
              onMouseOver={(e) => {
                const el = e.currentTarget as HTMLDivElement;
                el.style.backgroundColor = "var(--color-bg)";
                el.style.borderColor = group.color;
              }}
              onMouseOut={(e) => {
                const el = e.currentTarget as HTMLDivElement;
                el.style.backgroundColor = "transparent";
                el.style.borderColor = "transparent";
              }}
            >
              <span style={{ fontSize: 14, width: 18, textAlign: "center" }}>
                {item.icon}
              </span>
              <span style={{ fontSize: 11 }}>{item.label}</span>
            </div>
          ))}
        </div>
      ))}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Hint at bottom */}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 9,
          color: "var(--color-text-muted)",
          borderTop: "1px solid var(--color-border)",
          lineHeight: 1.5,
        }}
      >
        💡 拖入画布摆放
        <br />
        左=叙事 中=资产
        <br />
        右=制作 下=后期
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Zone Labels — subtle background guides on the canvas
// ══════════════════════════════════════════════════════════════════════

function ZoneLabels() {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 20,
          fontSize: 20,
          opacity: 0.06,
          color: "#f59e0b",
          pointerEvents: "none",
          userSelect: "none",
          fontWeight: 700,
        }}
      >
        📜 叙事区 · Storyline
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 260,
          fontSize: 20,
          opacity: 0.06,
          color: "#ec4899",
          pointerEvents: "none",
          userSelect: "none",
          fontWeight: 700,
        }}
      >
        👤 角色资产 · Assets
      </div>
      <div
        style={{
          position: "absolute",
          left: 360,
          top: 20,
          fontSize: 20,
          opacity: 0.06,
          color: "#06b6d4",
          pointerEvents: "none",
          userSelect: "none",
          fontWeight: 700,
        }}
      >
        🎬 分镜 · Storyboard
      </div>
      <div
        style={{
          position: "absolute",
          left: 680,
          top: 100,
          fontSize: 20,
          opacity: 0.06,
          color: "#3b82f6",
          pointerEvents: "none",
          userSelect: "none",
          fontWeight: 700,
        }}
      >
        🎥 制作区 · Production
      </div>
      <div
        style={{
          position: "absolute",
          left: 1020,
          top: 20,
          fontSize: 20,
          opacity: 0.06,
          color: "#6366f1",
          pointerEvents: "none",
          userSelect: "none",
          fontWeight: 700,
        }}
      >
        🖼️ 输出区 · Output
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Bottom Toolbar (LibTV-style status bar + batch actions)
// ══════════════════════════════════════════════════════════════════════

const RUNNABLE_TYPES = new Set(["image", "character", "shot", "video"]);

interface BottomToolbarProps {
  stats: { byType: Record<string, number>; byStatus: Record<string, number>; total: number };
  canvasName: string;
  onAutoArrange: () => void;
  onBatchGenerate: () => void;
  isRunning: boolean;
  runnableCount: number;
  uploading?: boolean;
  nodes?: Node[];
  runNode?: (nodeId: string) => Promise<unknown>;
}

function BottomToolbar({
  stats,
  canvasName,
  onAutoArrange,
  onBatchGenerate,
  isRunning,
  runnableCount,
  uploading,
  nodes = [],
  runNode,
}: BottomToolbarProps) {
  const doneCount = stats.byStatus["done"] ?? 0;
  const runningCount = stats.byStatus["running"] ?? 0;
  const dirtyCount = stats.byStatus["dirty"] ?? 0;

  return (
    <div
      style={{
        flexShrink: 0,
        height: 38,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        borderTop: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface)",
        gap: 10,
        fontSize: 11,
      }}
    >
      {/* Left: Canvas info */}
      <span style={{ color: "var(--color-text-muted)", fontWeight: 500 }}>
        {canvasName}
      </span>
      <span style={{ color: "var(--color-border)" }}>|</span>
      <span style={{ color: "var(--color-text-muted)" }}>
        节点: <b style={{ color: "var(--color-text)" }}>{stats.total}</b>
      </span>
      {doneCount > 0 && (
        <span style={{ color: "#22c55e", fontSize: 10 }}>
          ✅ {doneCount}
        </span>
      )}
      {runningCount > 0 && (
        <span style={{ color: "#f59e0b", fontSize: 10 }}>
          ⏳ {runningCount}
        </span>
      )}
      {dirtyCount > 0 && (
        <span style={{ color: "#ef4444", fontSize: 10 }}>
          ⚠️ {dirtyCount}
        </span>
      )}
      {uploading && (
        <span style={{ color: "var(--color-accent)", fontSize: 10 }}>
          ⏳ 上传中…
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right: Action buttons */}
      <button
        onClick={onAutoArrange}
        title="按 LibTV 分区自动排列节点"
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "transparent",
          color: "var(--color-text-muted)",
          fontSize: 11,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
        onMouseOver={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-accent)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text)";
        }}
        onMouseOut={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-border)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-muted)";
        }}
      >
        📐 自动排列
      </button>

      {runnableCount > 0 && (
        <button
          onClick={onBatchGenerate}
          disabled={isRunning}
          title={`逐个运行所有可执行节点 (${runnableCount} 个)`}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--color-accent)",
            backgroundColor: isRunning ? "transparent" : "var(--color-accent)",
            color: isRunning ? "var(--color-text-muted)" : "#fff",
            fontSize: 11,
            fontWeight: 600,
            cursor: isRunning ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            opacity: isRunning ? 0.5 : 1,
          }}
        >
          ▶️ 一键生成 ({runnableCount})
        </button>
      )}

      <button
        title="导出所有合成节点的视频"
        onClick={async () => {
          const concatNodes = nodes.filter((n) => n.type === "concat");
          if (concatNodes.length === 0) {
            alert("请先添加合成节点");
            return;
          }
          if (!runNode) return;
          for (const cn of concatNodes) {
            try {
              await runNode(cn.id);
            } catch {
              // Continue to next concat node on failure
            }
          }
        }}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          backgroundColor: "transparent",
          color: "var(--color-text-muted)",
          fontSize: 11,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
        onMouseOver={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-accent)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text)";
        }}
        onMouseOut={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-border)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-muted)";
        }}
      >
        📦 导出视频
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Default data per node type
// ══════════════════════════════════════════════════════════════════════

function getDefaultData(type: CanvasNodeType): Record<string, unknown> {
  switch (type) {
    case "script":
      return { content: "", status: "idle" };
    case "character":
      return { name: "新角色", description: "", status: "idle" };
    case "storyboard_cell":
      return { shotBrief: "", cameraIdx: 0, status: "idle" };
    case "shot":
      return {
        ffDesc: "",
        lfDesc: "",
        motionDesc: "",
        audioDesc: "",
        variationType: "medium",
        ffVisCharIdxs: [],
        lfVisCharIdxs: [],
        status: "idle",
      };
    case "image":
      return {
        prompt: "",
        modelId: "doubao-seedream-4-0",
        size: "1024x1024",
        status: "idle",
      };
    case "video":
      return {
        motionPreset: "zoom_in",
        durationSec: 4,
        modelId: "doubao-seedream-4-0",
        status: "idle",
      };
    case "concat":
      return { transition: "dissolve", status: "idle" };
    default:
      return { status: "idle" };
  }
}
