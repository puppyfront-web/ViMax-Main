import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PipelineStage } from "@vimax/contracts";
import { getDb } from "../../infrastructure/db/client.js";
import { canvasEdges, canvasNodes, jobs } from "../../infrastructure/db/schema.js";
import { broadcastToRoom } from "../../realtime/connection-manager.js";
import { inferAutoEdges, subtractEdges } from "./canvas-graph.js";
import {
  runNode,
  runScript2Storyboard,
  runStoryboard2Shot,
} from "./node-executor.service.js";
import { getDefaultModel } from "../model/model.service.js";

export interface AutoPipelineInput {
  canvas_id: string;
  script_node_id?: string;
  concurrency?: number;
  /** Rebuild from scratch: delete every non-script node before running. */
  regenerate?: boolean;
}

export interface AutoPipelineResult {
  run_id: string;
  succeeded: number;
  failed: number;
  errors: Array<{ stage: PipelineStage; nodeId?: string; error: string }>;
}

const activeRuns = new Map<string, AbortController>();

export function cancelAutoPipeline(runId: string): void {
  activeRuns.get(runId)?.abort();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("pipeline.cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("pipeline.cancelled"));
      },
      { once: true },
    );
  });
}

async function waitForJob(
  jobId: string,
  signal?: AbortSignal,
  timeoutMs = 600_000,
): Promise<"succeeded" | "failed"> {
  const db = getDb();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error("pipeline.cancelled");
    const [job] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (job?.status === "succeeded") return "succeeded";
    if (job?.status === "failed") return "failed";
    await sleep(2000, signal);
  }
  throw new Error("pipeline.timeout");
}

function emit(
  canvasId: string,
  runId: string,
  msg: Record<string, unknown>,
): void {
  broadcastToRoom(canvasId, msg as never);
}

async function loadNodes(canvasId: string) {
  const db = getDb();
  return db
    .select()
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId));
}

async function loadEdges(canvasId: string) {
  const db = getDb();
  return db
    .select()
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvasId));
}

async function ensureProductionChain(canvasId: string): Promise<void> {
  const db = getDb();
  const nodes = await loadNodes(canvasId);
  const edges = await loadEdges(canvasId);
  const edgeTargets = new Set(edges.map((e) => e.targetNodeId));

  let imageModelId: string | undefined;
  let videoModelId: string | undefined;
  try {
    imageModelId = (await getDefaultModel("default", "image")).id;
  } catch {
    /* optional */
  }
  try {
    videoModelId = (await getDefaultModel("default", "video")).id;
  } catch {
    /* optional */
  }

  const shots = nodes.filter((n) => n.type === "shot");

  // Copy-driven mode (default for 广告/短剧): no per-shot image generation.
  // Every shot gets a video node fed by (a) the shot copy and (b) the
  // uploaded reference image (an image node carrying referenceAssetIds,
  // whose output IS the uploaded asset). Without a reference image the
  // legacy per-shot image chain is kept as fallback.
  const referenceImage = nodes.find(
    (n) =>
      n.type === "image" &&
      Array.isArray((n.data as Record<string, unknown>).referenceAssetIds) &&
      ((n.data as Record<string, unknown>).referenceAssetIds as unknown[]).length > 0,
  );
  const copyDriven = !!referenceImage;
  const newNodes: typeof nodes = [...nodes];

  if (!copyDriven) {
    for (const shot of shots) {
      const hasImage = edges.some(
        (e) => e.sourceNodeId === shot.id && newNodes.find((n) => n.id === e.targetNodeId)?.type === "image",
      );
      if (!hasImage) {
        const data = shot.data as { ffDesc?: string };
        const imageId = randomUUID();
        const pos = shot.position as { x: number; y: number };
        await db.insert(canvasNodes).values({
          id: imageId,
          canvasId,
          type: "image",
          position: { x: pos.x + 300, y: pos.y },
          data: {
            prompt: data.ffDesc ?? "cinematic frame",
            modelId: imageModelId ?? "doubao-seedream-4-0",
            size: "1024x1024",
            status: "idle",
          },
          status: "idle",
        });
        await db.insert(canvasEdges).values({
          id: randomUUID(),
          canvasId,
          sourceNodeId: shot.id,
          targetNodeId: imageId,
          sourceHandle: "first_frame",
          targetHandle: "reference",
        });
        newNodes.push({ id: imageId, type: "image" } as never);
      }
    }
  }

  const refreshedEdges = await loadEdges(canvasId);
  const refreshedNodes = await loadNodes(canvasId);

  if (copyDriven && referenceImage) {
    // video per shot: shot supplies the copy, the reference image supplies
    // the first frame. One reference→video edge, shared by all shots.
    for (const shot of shots) {
      const hasVideo = refreshedEdges.some(
        (e) => e.sourceNodeId === shot.id && refreshedNodes.find((n) => n.id === e.targetNodeId)?.type === "video",
      );
      if (!hasVideo) {
        const videoId = randomUUID();
        const pos = shot.position as { x: number; y: number };
        await db.insert(canvasNodes).values({
          id: videoId,
          canvasId,
          type: "video",
          position: { x: (pos.x as number) + 300, y: pos.y },
          data: {
            motionPreset: "zoom_in",
            durationSec: 4,
            modelId: videoModelId ?? "doubao-seedance-1-0-lite",
            status: "idle",
          },
          status: "idle",
        });
        await db.insert(canvasEdges).values([
          {
            id: randomUUID(),
            canvasId,
            sourceNodeId: shot.id,
            targetNodeId: videoId,
            sourceHandle: null,
            targetHandle: null,
          },
          {
            id: randomUUID(),
            canvasId,
            sourceNodeId: referenceImage.id,
            targetNodeId: videoId,
            sourceHandle: "output",
            targetHandle: "first_frame",
          },
        ]);
        newNodes.push({ id: videoId, type: "video" } as never);
      }
    }
  } else {
    for (const image of refreshedNodes.filter((n) => n.type === "image")) {
      const hasVideo = refreshedEdges.some(
        (e) =>
          e.sourceNodeId === image.id &&
          refreshedNodes.find((n) => n.id === e.targetNodeId)?.type === "video",
      );
      if (!hasVideo) {
        const videoId = randomUUID();
        const pos = image.position as { x: number; y: number };
        await db.insert(canvasNodes).values({
          id: videoId,
          canvasId,
          type: "video",
          position: { x: pos.x + 300, y: pos.y },
          data: {
            motionPreset: "zoom_in",
            durationSec: 4,
            modelId: videoModelId ?? "doubao-seedance-1-0-lite",
            status: "idle",
          },
          status: "idle",
        });
        await db.insert(canvasEdges).values({
          id: randomUUID(),
          canvasId,
          sourceNodeId: image.id,
          targetNodeId: videoId,
          sourceHandle: "output",
          targetHandle: "first_frame",
        });
      }
    }
  }

  const allNodes = await loadNodes(canvasId);
  const allEdges = await loadEdges(canvasId);
  const existingEdgeKeys = allEdges.map((e) => ({
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
  }));
  const inferred = inferAutoEdges(
    allNodes.map((n) => ({ id: n.id, type: n.type as never })),
    randomUUID,
  );
  const toAdd = subtractEdges(inferred, existingEdgeKeys);
  for (const e of toAdd) {
    await db.insert(canvasEdges).values({
      id: e.id,
      canvasId,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    });
  }

  const videos = allNodes.filter((n) => n.type === "video");
  const hasConcat = allNodes.some((n) => n.type === "concat");
  if (videos.length > 1 && !hasConcat) {
    const concatId = randomUUID();
    const lastVideo = videos[videos.length - 1]!;
    const pos = lastVideo.position as { x: number; y: number };
    await db.insert(canvasNodes).values({
      id: concatId,
      canvasId,
      type: "concat",
      position: { x: pos.x + 300, y: pos.y },
      data: { transition: "dissolve", status: "idle" },
      status: "idle",
    });
    for (const v of videos) {
      await db.insert(canvasEdges).values({
        id: randomUUID(),
        canvasId,
        sourceNodeId: v.id,
        targetNodeId: concatId,
        sourceHandle: "output",
        targetHandle: "input",
      });
    }
  }

  void edgeTargets;
}

async function runNodesInOrder(
  canvasId: string,
  nodeIds: string[],
  concurrency: number,
  runId: string,
  stage: PipelineStage,
  signal?: AbortSignal,
): Promise<{ succeeded: number; failed: number; errors: AutoPipelineResult["errors"] }> {
  let succeeded = 0;
  let failed = 0;
  const errors: AutoPipelineResult["errors"] = [];
  const queue = [...nodeIds];

  async function runOne(nodeId: string): Promise<void> {
    try {
      const result = await runNode({ canvas_id: canvasId, node_id: nodeId });
      const status = await waitForJob(result.job_id, signal);
      if (status === "succeeded") succeeded++;
      else {
        failed++;
        errors.push({ stage, nodeId, error: "job failed" });
      }
    } catch (err) {
      failed++;
      errors.push({
        stage,
        nodeId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  emit(canvasId, runId, {
    type: "pipeline.stage_start",
    runId,
    canvasId,
    stage,
    nodeIds,
  });

  let done = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      if (signal?.aborted) break;
      const nodeId = queue.shift();
      if (!nodeId) break;
      await runOne(nodeId);
      done++;
      emit(canvasId, runId, {
        type: "pipeline.stage_progress",
        runId,
        canvasId,
        stage,
        done,
        total: nodeIds.length,
      });
    }
  });
  await Promise.all(workers);

  emit(canvasId, runId, {
    type: "pipeline.stage_done",
    runId,
    canvasId,
    stage,
  });

  return { succeeded, failed, errors };
}

/**
 * Regeneration starts from a clean slate: script2storyboard always INSERTS
 * new storyboard cells (persistStoryboardSpawn), so re-running without
 * deleting the old chain would duplicate every node.
 */
async function clearGeneratedNodes(canvasId: string): Promise<void> {
  const db = getDb();
  const nodes = await loadNodes(canvasId);
  const removedIds = nodes
    .filter((n) => n.type !== "script")
    .map((n) => n.id);
  if (removedIds.length === 0) return;
  // canvas_edges rows cascade-delete with their endpoints.
  await db.delete(canvasNodes).where(inArray(canvasNodes.id, removedIds));
  broadcastToRoom(canvasId, {
    type: "canvas.nodes_removed",
    canvasId,
    nodeIds: removedIds,
  });
}

export async function runAutoPipelineAsync(
  runId: string,
  input: AutoPipelineInput,
): Promise<AutoPipelineResult> {
  const ac = new AbortController();
  activeRuns.set(runId, ac);
  const signal = ac.signal;
  const concurrency = input.concurrency ?? 2;
  const errors: AutoPipelineResult["errors"] = [];
  let succeeded = 0;
  let failed = 0;

  try {
    const db = getDb();
    const { canvas_id: canvasId } = input;

    if (input.regenerate) {
      await clearGeneratedNodes(canvasId);
    }

    let scriptNodeId = input.script_node_id;
    if (!scriptNodeId) {
      const scripts = await db
        .select({ id: canvasNodes.id })
        .from(canvasNodes)
        .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.type, "script")))
        .limit(1);
      scriptNodeId = scripts[0]?.id;
    }
    if (!scriptNodeId) throw new Error("canvas.script_not_found");

    emit(canvasId, runId, {
      type: "pipeline.stage_start",
      runId,
      canvasId,
      stage: "storyboard",
      nodeIds: [scriptNodeId],
    });

    const s2s = await runScript2Storyboard(canvasId, scriptNodeId);
    const s2sStatus = await waitForJob(s2s.job_id, signal);
    if (s2sStatus === "failed") {
      failed++;
      errors.push({ stage: "storyboard", nodeId: scriptNodeId, error: "script2storyboard failed" });
      throw new Error("storyboard stage failed");
    }
    succeeded++;
    emit(canvasId, runId, {
      type: "pipeline.stage_done",
      runId,
      canvasId,
      stage: "storyboard",
    });

    const cells = (await loadNodes(canvasId)).filter((n) => n.type === "storyboard_cell");
    emit(canvasId, runId, {
      type: "pipeline.stage_start",
      runId,
      canvasId,
      stage: "shot",
      nodeIds: cells.map((c) => c.id),
    });

    let shotDone = 0;
    for (const cell of cells) {
      if (signal.aborted) throw new Error("pipeline.cancelled");
      try {
        await runStoryboard2Shot(canvasId, cell.id);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push({
          stage: "shot",
          nodeId: cell.id,
          error: err instanceof Error ? err.message : "unknown",
        });
        emit(canvasId, runId, {
          type: "pipeline.node_failed",
          runId,
          canvasId,
          stage: "shot",
          nodeId: cell.id,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
      shotDone++;
      emit(canvasId, runId, {
        type: "pipeline.stage_progress",
        runId,
        canvasId,
        stage: "shot",
        done: shotDone,
        total: cells.length,
      });
    }
    emit(canvasId, runId, { type: "pipeline.stage_done", runId, canvasId, stage: "shot" });

    await ensureProductionChain(canvasId);

    const allNodes = await loadNodes(canvasId);
    // Copy-driven mode: shots carry only copy (no first-frame jobs) and
    // reference images are already-done asset containers — neither runs.
    const isReferenceImage = (n: (typeof allNodes)[number]) =>
      n.type === "image" &&
      Array.isArray((n.data as Record<string, unknown>).referenceAssetIds) &&
      ((n.data as Record<string, unknown>).referenceAssetIds as unknown[]).length > 0;
    const images = allNodes
      .filter((n) => n.type === "image" && !isReferenceImage(n))
      .map((n) => n.id);
    const videos = allNodes.filter((n) => n.type === "video").map((n) => n.id);
    const concats = allNodes.filter((n) => n.type === "concat").map((n) => n.id);

    const stages: Array<[PipelineStage, string[]]> = [
      ["image", images],
      ["video", videos],
    ];
    if (concats.length > 0 && videos.length > 1) {
      stages.push(["concat", concats]);
    }

    for (const [stage, ids] of stages) {
      if (ids.length === 0) continue;
      const result = await runNodesInOrder(
        canvasId,
        ids,
        concurrency,
        runId,
        stage,
        signal,
      );
      succeeded += result.succeeded;
      failed += result.failed;
      errors.push(...result.errors);
    }

    const summary = { succeeded, failed };
    emit(canvasId, runId, {
      type: "pipeline.finished",
      runId,
      canvasId,
      summary,
    });
    return { run_id: runId, succeeded, failed, errors };
  } catch (err) {
    if (err instanceof Error && err.message === "pipeline.cancelled") {
      emit(input.canvas_id, runId, {
        type: "pipeline.finished",
        runId,
        canvasId: input.canvas_id,
        summary: { succeeded, failed, cancelled: true },
      });
    }
    throw err;
  } finally {
    activeRuns.delete(runId);
  }
}

export function startAutoPipeline(input: AutoPipelineInput): string {
  const runId = randomUUID();
  void runAutoPipelineAsync(runId, input).catch((err) => {
    console.error("[pipeline] run failed:", err);
  });
  return runId;
}
