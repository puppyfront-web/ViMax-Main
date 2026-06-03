import { initTRPC, TRPCError } from "@trpc/server";
import {
  CanvasCreateInputSchema,
  CanvasListInputSchema,
  CanvasSaveInputSchema,
  CanvasSnapshotInputSchema,
  CharacterViewRunInputSchema,
  MultiCameraGridInputSchema,
  MotionPredictionInputSchema,
  GridSplitInputSchema,
  StoryPushInputSchema,
  NodeRunBatchInputSchema,
  NodeRunInputSchema,
  NodeStatusInputSchema,
  ExportUrlInputSchema,
  Script2StoryboardInputSchema,
} from "@vimax/contracts";
import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createCanvas,
  deleteCanvas,
  getCanvasNode,
  getCanvasSnapshot,
  listCanvases,
  saveCanvas,
} from "../../domain/canvas/canvas.service.js";
import {
  runNode,
  runNodeBatch,
  runCharacterView,
  runScript2Storyboard,
  runMultiCameraGrid,
  runMotionPrediction,
  runGridSplit,
  runStoryPush,
  runAudioGeneration,
} from "../../domain/canvas/node-executor.service.js";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, jobs } from "../../infrastructure/db/schema.js";
import { createPresignedDownloadUrl } from "../../infrastructure/storage/s3.js";

const t = initTRPC.create();

function mapError(err: unknown): never {
  const message = err instanceof Error ? err.message : "internal";
  const codeMap: Record<string, TRPCError["code"]> = {
    "canvas.not_found": "NOT_FOUND",
    "canvas.node_not_found": "NOT_FOUND",
    "canvas.node_type_not_runnable": "BAD_REQUEST",
    "canvas.video_needs_upstream_frames": "BAD_REQUEST",
    "canvas.concat_needs_upstream_videos": "BAD_REQUEST",
    "canvas.character_needs_front_view": "BAD_REQUEST",
    "canvas.script_empty": "BAD_REQUEST",
    "canvas.node_needs_output": "BAD_REQUEST",
    "canvas.audio_desc_empty": "BAD_REQUEST",
    "input.unsupported_model": "BAD_REQUEST",
    "provider.invalid_key": "PRECONDITION_FAILED",
  };
  throw new TRPCError({
    code: codeMap[message] ?? "INTERNAL_SERVER_ERROR",
    message,
  });
}

export const canvasRouter = t.router({
  // ── Canvas CRUD ───────────────────────────────────────────────

  create: t.procedure
    .input(CanvasCreateInputSchema)
    .mutation(async ({ input }) => {
      return createCanvas(input);
    }),

  list: t.procedure
    .input(CanvasListInputSchema.optional())
    .query(async ({ input }) => {
      return listCanvases(input ?? { limit: 20 });
    }),

  snapshot: t.procedure
    .input(CanvasSnapshotInputSchema)
    .query(async ({ input }) => {
      const snapshot = await getCanvasSnapshot(input.canvas_id);
      if (!snapshot) {
        throw new TRPCError({ code: "NOT_FOUND", message: "canvas.not_found" });
      }
      return snapshot;
    }),

  save: t.procedure
    .input(CanvasSaveInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await saveCanvas(input);
      } catch (err) {
        mapError(err);
      }
    }),

  delete: t.procedure
    .input(CanvasSnapshotInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await deleteCanvas(input.canvas_id);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Node operations ───────────────────────────────────────────

  runNode: t.procedure
    .input(NodeRunInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runNode(input);
      } catch (err) {
        mapError(err);
      }
    }),

  runNodeBatch: t.procedure
    .input(NodeRunBatchInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runNodeBatch(input);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Character three-view (三视图) ───────────────────────────────

  runCharacterView: t.procedure
    .input(CharacterViewRunInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runCharacterView(input.canvas_id, input.node_id, input.view);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Script-to-Storyboard (剧本转分镜) ───────────────────────────

  runScript2Storyboard: t.procedure
    .input(Script2StoryboardInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runScript2Storyboard(input.canvas_id, input.node_id);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Multi-Camera Grid (多机位宫格) ──────────────────────────────

  runMultiCameraGrid: t.procedure
    .input(MultiCameraGridInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runMultiCameraGrid(input.canvas_id, input.node_id, input.grid_size);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Motion Prediction (画面推演) ────────────────────────────────

  runMotionPrediction: t.procedure
    .input(MotionPredictionInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runMotionPrediction(input.canvas_id, input.node_id, input.direction, input.seconds);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Grid Split (宫格切分) ───────────────────────────────────────

  runGridSplit: t.procedure
    .input(GridSplitInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runGridSplit(input.canvas_id, input.node_id, input.grid_size);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Story Push 4-Grid (剧情推演) ────────────────────────────────

  runStoryPush: t.procedure
    .input(StoryPushInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runStoryPush(input.canvas_id, input.node_id);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Audio Generation (音频生成) ─────────────────────────────────

  runAudioGeneration: t.procedure
    .input(NodeRunInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await runAudioGeneration(input.canvas_id, input.node_id);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Export URL (导出下载链接) ────────────────────────────────────

  getExportUrl: t.procedure
    .input(ExportUrlInputSchema)
    .query(async ({ input }) => {
      const node = await getCanvasNode(input.canvas_id, input.node_id);
      if (!node?.outputAssetId) {
        return { download_url: null, filename: null };
      }
      const db = getDb();
      const [asset] = await db
        .select({ storageKey: assets.storageKey, mimeType: assets.mimeType })
        .from(assets)
        .where(eq(assets.id, node.outputAssetId))
        .limit(1);
      if (!asset) return { download_url: null, filename: null };
      const url = await createPresignedDownloadUrl(asset.storageKey);
      const ext = asset.mimeType.split("/")[1] ?? "bin";
      return { download_url: url, filename: `${node.id.slice(0, 8)}.${ext}` };
    }),

  // ── Node status query ─────────────────────────────────────────

  getNodeStatus: t.procedure
    .input(NodeStatusInputSchema)
    .query(async ({ input }) => {
      const node = await getCanvasNode(input.canvas_id, input.node_id);
      if (!node) {
        throw new TRPCError({ code: "NOT_FOUND", message: "canvas.node_not_found" });
      }

      const db = getDb();
      const nodeJobs = await db
        .select({
          id: jobs.id,
          status: jobs.status,
          progress: jobs.progress,
          jobType: jobs.jobType,
        })
        .from(jobs)
        .where(
          sql`${jobs.inputSnapshot} -> '_canvas' ->> 'node_id' = ${input.node_id}`,
        )
        .orderBy(desc(jobs.queuedAt))
        .limit(1);

      const latestJob = nodeJobs[0];

      return {
        node_id: node.id,
        status: node.status,
        output_asset_id: node.outputAssetId,
        job_id: latestJob?.id ?? null,
        job_status: latestJob?.status ?? null,
        job_progress: latestJob?.progress ?? null,
      };
    }),
});
