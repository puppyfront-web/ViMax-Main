"use client";

import { useCallback, useEffect, useState } from "react";
import type { PipelineStage, ServerWsMessage } from "@vimax/contracts";
import { trpc } from "@/lib/trpc/client";
import { sharedCanvasWs } from "@/lib/websocket/shared-ws";

export interface PipelineStageState {
  stage: PipelineStage;
  status: "pending" | "running" | "done" | "failed";
  done: number;
  total: number;
}

export interface AutoPipelineState {
  runId: string | null;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  stages: PipelineStageState[];
  summary: { succeeded: number; failed: number } | null;
}

const STAGE_ORDER: PipelineStage[] = ["storyboard", "shot", "image", "video", "concat"];

function initialStages(): PipelineStageState[] {
  return STAGE_ORDER.map((stage) => ({
    stage,
    status: "pending",
    done: 0,
    total: 0,
  }));
}

export function useAutoPipeline(canvasId: string) {
  const [state, setState] = useState<AutoPipelineState>({
    runId: null,
    status: "idle",
    stages: initialStages(),
    summary: null,
  });

  const runMutation = trpc.canvas.runAutoPipeline.useMutation();

  useEffect(() => {
    const unsubscribe = sharedCanvasWs.subscribe(canvasId, (msg: ServerWsMessage) => {
      const type = msg.type as string;
      if (!type.startsWith("pipeline.")) return;
      if ("canvasId" in msg && msg.canvasId !== canvasId) return;

      switch (msg.type) {
        case "pipeline.stage_start":
          setState((prev) => ({
            ...prev,
            status: "running",
            runId: msg.runId,
            stages: prev.stages.map((s) =>
              s.stage === msg.stage
                ? { ...s, status: "running", total: msg.nodeIds.length, done: 0 }
                : s,
            ),
          }));
          break;
        case "pipeline.stage_progress":
          setState((prev) => ({
            ...prev,
            stages: prev.stages.map((s) =>
              s.stage === msg.stage ? { ...s, done: msg.done, total: msg.total } : s,
            ),
          }));
          break;
        case "pipeline.stage_done":
          setState((prev) => ({
            ...prev,
            stages: prev.stages.map((s) =>
              s.stage === msg.stage ? { ...s, status: "done" } : s,
            ),
          }));
          break;
        case "pipeline.node_failed":
          setState((prev) => ({
            ...prev,
            stages: prev.stages.map((s) =>
              s.stage === msg.stage ? { ...s, status: "failed" } : s,
            ),
          }));
          break;
        case "pipeline.finished":
          setState((prev) => ({
            ...prev,
            status: msg.summary.cancelled ? "cancelled" : msg.summary.failed > 0 ? "failed" : "done",
            summary: { succeeded: msg.summary.succeeded, failed: msg.summary.failed },
          }));
          break;
      }
    });
    return unsubscribe;
  }, [canvasId]);

  const start = useCallback(
    async (scriptNodeId?: string, opts?: { regenerate?: boolean }) => {
      setState({
        runId: null,
        status: "running",
        stages: initialStages(),
        summary: null,
      });
      const result = await runMutation.mutateAsync({
        canvas_id: canvasId,
        script_node_id: scriptNodeId,
        concurrency: 2,
        regenerate: opts?.regenerate,
      });
      setState((prev) => ({ ...prev, runId: result.run_id }));
      return result.run_id;
    },
    [canvasId, runMutation],
  );

  const cancel = useCallback(() => {
    if (!state.runId) return;
    sharedCanvasWs.send({
      type: "pipeline.cancel",
      runId: state.runId,
      canvasId,
    });
  }, [canvasId, state.runId]);

  return { state, start, cancel, isStarting: runMutation.isPending };
}
