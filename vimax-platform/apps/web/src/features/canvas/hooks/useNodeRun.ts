"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { trpc } from "@/lib/trpc/client";

const API_BASE =
  (typeof window !== "undefined" &&
    (process.env.NEXT_PUBLIC_API_URL?.replace("/trpc", "") ??
      "http://localhost:3001")) ??
  "http://localhost:3001";

interface UseNodeRunOptions {
  canvasId: string;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  edges: Edge[];
}

interface RunState {
  nodeId: string;
  jobId: string;
  progress: number;
  error: string | null;
}

export function useNodeRun({ canvasId, setNodes, edges }: UseNodeRunOptions) {
  const runMutation = trpc.canvas.runNode.useMutation();
  const [runState, setRunState] = useState<RunState | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      sseRef.current?.close();
    };
  }, []);

  // Update node data helper
  const patchNode = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, ...patch } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  // SSE subscription
  const subscribeSSE = useCallback(
    (nodeId: string, jobId: string) => {
      sseRef.current?.close();

      const es = new EventSource(`${API_BASE}/sse/jobs/${jobId}`);
      sseRef.current = es;

      es.addEventListener("started", () => {
        patchNode(nodeId, { status: "running" });
        setRunState((s) => (s ? { ...s, progress: 5 } : null));
      });

      es.addEventListener("progress", (e) => {
        try {
          const d = JSON.parse(e.data);
          const pct = d.percent ?? 0;
          setRunState((s) => (s ? { ...s, progress: pct } : null));
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener("completed", (e) => {
        try {
          const d = JSON.parse(e.data);
          patchNode(nodeId, {
            status: "done",
            outputAssetId: d.output?.storage_key
              ? d.output.storage_key.split("/").pop()?.slice(0, 8)
              : undefined,
          });
        } catch {
          patchNode(nodeId, { status: "done" });
        }
        // Mark downstream nodes dirty in frontend state
        markDownstreamDirty(nodeId, setNodes, edges);
        setRunState((s) => (s ? { ...s, progress: 100, error: null } : null));
        es.close();
      });

      es.addEventListener("failed", (e) => {
        try {
          const d = JSON.parse(e.data);
          const msg = d.error_message ?? "生成失败";
          patchNode(nodeId, { status: "failed" });
          setRunState((s) => (s ? { ...s, error: msg } : null));
        } catch {
          patchNode(nodeId, { status: "failed" });
          setRunState((s) =>
            s ? { ...s, error: "未知错误" } : null,
          );
        }
        es.close();
      });

      es.onerror = () => {
        es.close();
      };
    },
    [patchNode],
  );

  // Main run function
  const runNode = useCallback(
    async (nodeId: string) => {
      // Reset state
      setRunState({ nodeId, jobId: "", progress: 0, error: null });
      patchNode(nodeId, { status: "running" });

      try {
        const result = await runMutation.mutateAsync({
          canvas_id: canvasId,
          node_id: nodeId,
        });

        setRunState({
          nodeId,
          jobId: result.job_id,
          progress: 0,
          error: null,
        });

        subscribeSSE(nodeId, result.job_id);

        return result;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "启动失败";
        patchNode(nodeId, { status: "failed" });
        setRunState({ nodeId, jobId: "", progress: 0, error: msg });
        throw err;
      }
    },
    [canvasId, runMutation, subscribeSSE, patchNode],
  );

  // Reset state
  const clearRunState = useCallback(() => {
    setRunState(null);
    sseRef.current?.close();
  }, []);

  return {
    runNode,
    isRunning: runMutation.isPending || (runState !== null && runState.progress < 100),
    runningNodeId: runState?.nodeId ?? null,
    progress: runState?.progress ?? 0,
    error: runState?.error ?? null,
    jobId: runState?.jobId ?? null,
    clearRunState,
  };
}

// ── BFS helper: mark all downstream nodes dirty ────────────────────

function markDownstreamDirty(
  sourceNodeId: string,
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>,
  edges: Edge[],
) {
  // Build adjacency list (source → target[])
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const targets = adjacency.get(e.source) ?? [];
    targets.push(e.target);
    adjacency.set(e.source, targets);
  }

  // BFS
  const visited = new Set<string>();
  const queue = [sourceNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const targets = adjacency.get(current) ?? [];
    for (const t of targets) {
      if (!visited.has(t)) queue.push(t);
    }
  }

  // Mark all downstream (excluding the source) as dirty
  visited.delete(sourceNodeId);
  if (visited.size === 0) return;

  setNodes((nds) =>
    nds.map((n) =>
      visited.has(n.id)
        ? {
            ...n,
            data: {
              ...n.data,
              status: (n.data as Record<string, unknown>)?.status === "done"
                ? "dirty"
                : (n.data as Record<string, unknown>)?.status ?? "dirty",
            },
          }
        : n,
    ),
  );
}
