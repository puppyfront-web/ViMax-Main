"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import type { CanvasNodeType } from "@vimax/contracts";
import { trpc } from "@/lib/trpc/client";

export interface UseCanvasSnapshotReturn {
  nodes: Node[];
  setNodes: ReturnType<typeof useNodesState>[1];
  onNodesChange: OnNodesChange<Node>;
  edges: Edge[];
  setEdges: ReturnType<typeof useEdgesState>[1];
  onEdgesChange: OnEdgesChange<Edge>;
  canvasName: string;
  viewport: { x: number; y: number; zoom: number };
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCanvasSnapshot(canvasId: string): UseCanvasSnapshotReturn {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasName, setCanvasName] = useState("");
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  const snapshotQuery = trpc.canvas.snapshot.useQuery(
    { canvas_id: canvasId },
    { enabled: !!canvasId, staleTime: 0 },
  );

  const refetch = useCallback(() => {
    snapshotQuery.refetch();
  }, [snapshotQuery]);

  useEffect(() => {
    if (!snapshotQuery.data) return;

    const { canvas, nodes: apiNodes, edges: apiEdges } = snapshotQuery.data;

    const rfNodes: Node[] = apiNodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data, status: n.status, outputAssetId: n.output_asset_id },
    }));

    const rfEdges: Edge[] = apiEdges.map((e) => ({
      id: e.id,
      source: e.source_node_id,
      target: e.target_node_id,
      sourceHandle: e.source_handle ?? undefined,
      targetHandle: e.target_handle ?? undefined,
    }));

    if (!initialLoadDone.current) {
      setNodes(rfNodes);
      setEdges(rfEdges);
      initialLoadDone.current = true;
    }

    setCanvasName(canvas.name);
    setViewport(canvas.viewport);
    setIsLoading(false);
  }, [snapshotQuery.data, setNodes, setEdges]);

  // Fallback to demo data when API is unavailable
  useEffect(() => {
    if (!snapshotQuery.isError || initialLoadDone.current) return;

    setIsLoading(false);
    // Don't set isError — show demo data instead
    setCanvasName("Demo 画布 (离线模式)");

    const demoNodes: Node[] = [
      {
        id: "demo-script-1",
        type: "script",
        position: { x: 100, y: 100 },
        data: {
          content:
            "场景：清晨的城市公园\n角色：Lila，28岁，晨跑爱好者\n镜头跟随Lila穿过晨雾，阳光透过树叶洒在小径上。",
          status: "done",
        },
      },
      {
        id: "demo-char-1",
        type: "character",
        position: { x: 100, y: 300 },
        data: {
          name: "Lila",
          description: "28岁亚裔女性，短发，运动装，晨跑爱好者",
          status: "done",
        },
      },
      {
        id: "demo-cell-1",
        type: "storyboard_cell",
        position: { x: 450, y: 100 },
        data: { shotBrief: "分镜 1: 广角全景，Lila跑入画面", cameraIdx: 1, status: "done" },
      },
      {
        id: "demo-cell-2",
        type: "storyboard_cell",
        position: { x: 450, y: 260 },
        data: { shotBrief: "分镜 2: 中景跟拍，Lila回头看", cameraIdx: 2, status: "idle" },
      },
      {
        id: "demo-shot-1",
        type: "shot",
        position: { x: 750, y: 100 },
        data: {
          ffDesc: "清晨公园全景，金色晨光，Lila从画面左侧跑入",
          lfDesc: "Lila渐远，阳光从树叶间洒下",
          motionDesc: "缓慢推近，从全景到中景",
          audioDesc: "鸟鸣声 + 轻柔钢琴",
          variationType: "medium",
          status: "idle",
        },
      },
      {
        id: "demo-image-1",
        type: "image",
        position: { x: 1050, y: 80 },
        data: {
          prompt: "清晨城市公园，金色晨光，全景，一位亚裔短发女性晨跑者从左侧跑入画面",
          modelId: "doubao-seedream-4-0",
          size: "1024x1024",
          status: "done",
        },
      },
      {
        id: "demo-image-2",
        type: "image",
        position: { x: 1050, y: 250 },
        data: {
          prompt: "Lila中景跟拍，回头看镜头，运动装，晨光，浅景深",
          modelId: "doubao-seedream-4-0",
          size: "1024x1024",
          status: "running",
        },
      },
      {
        id: "demo-video-1",
        type: "video",
        position: { x: 1300, y: 150 },
        data: {
          motionPreset: "zoom_in",
          durationSec: 4,
          modelId: "doubao-seedream-4-0",
          status: "idle",
        },
      },
    ];

    const demoEdges: Edge[] = [
      {
        id: "demo-edge-1",
        source: "demo-script-1",
        target: "demo-char-1",
      },
      {
        id: "demo-edge-2",
        source: "demo-script-1",
        target: "demo-cell-1",
      },
      {
        id: "demo-edge-3",
        source: "demo-script-1",
        target: "demo-cell-2",
      },
      {
        id: "demo-edge-4",
        source: "demo-char-1",
        target: "demo-shot-1",
        sourceHandle: undefined,
        targetHandle: "reference",
      },
      {
        id: "demo-edge-5",
        source: "demo-cell-1",
        target: "demo-shot-1",
      },
      {
        id: "demo-edge-6",
        source: "demo-shot-1",
        target: "demo-image-1",
        sourceHandle: "first_frame",
        targetHandle: "reference",
      },
      {
        id: "demo-edge-7",
        source: "demo-shot-1",
        target: "demo-image-2",
        sourceHandle: "last_frame",
        targetHandle: "reference",
      },
      {
        id: "demo-edge-8",
        source: "demo-image-1",
        target: "demo-video-1",
        sourceHandle: "output",
        targetHandle: "first_frame",
      },
    ];

    setNodes(demoNodes);
    setEdges(demoEdges);
    initialLoadDone.current = true;
  }, [snapshotQuery.isError, setNodes, setEdges]);

  return {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    canvasName,
    viewport,
    isLoading,
    isError,
    error,
    refetch,
  };
}

// ── Debounced Canvas Save ─────────────────────────────────────────

export function useCanvasSave(canvasId: string) {
  const saveMutation = trpc.canvas.save.useMutation();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);

  const save = useCallback(
    (
      nodes: Node[],
      edges: Edge[],
      viewport?: { x: number; y: number; zoom: number },
    ) => {
      pendingRef.current = { nodes, edges };

      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(async () => {
        const pending = pendingRef.current;
        if (!pending) return;

        try {
          await saveMutation.mutateAsync({
            canvas_id: canvasId,
            nodes: pending.nodes.map((n) => ({
              id: n.id,
              type: (n.type ?? "image") as CanvasNodeType,
              position: n.position,
              data: n.data as Record<string, unknown>,
            })),
            edges: pending.edges.map((e) => ({
              id: e.id,
              source_node_id: e.source,
              target_node_id: e.target,
              source_handle: e.sourceHandle ?? null,
              target_handle: e.targetHandle ?? null,
            })),
            viewport,
          });
        } catch (err) {
          console.error("[canvas save] failed:", err);
        }
      }, 800);
    },
    [canvasId, saveMutation],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { save, isSaving: saveMutation.isPending };
}
