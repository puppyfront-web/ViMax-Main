import { z } from "zod";
import { CANVAS_NODE_STATUSES, CANVAS_NODE_TYPES } from "./canvas-types.js";

// ── Position & Viewport ────────────────────────────────────────────

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const ViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

// ── Canvas CRUD ────────────────────────────────────────────────────

export const CanvasCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
});

export type CanvasCreateInput = z.infer<typeof CanvasCreateInputSchema>;

export const CanvasCreateOutputSchema = z.object({
  canvas_id: z.string().uuid(),
});

export type CanvasCreateOutput = z.infer<typeof CanvasCreateOutputSchema>;

// ── Canvas List ────────────────────────────────────────────────────

export const CanvasListInputSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export type CanvasListInput = z.infer<typeof CanvasListInputSchema>;

export const CanvasSummarySchema = z.object({
  canvas_id: z.string().uuid(),
  name: z.string(),
  node_count: z.number().int(),
  updated_at: z.string().datetime(),
});

export const CanvasListOutputSchema = z.object({
  items: z.array(CanvasSummarySchema),
  nextCursor: z.string().uuid().optional(),
});

export type CanvasListOutput = z.infer<typeof CanvasListOutputSchema>;

// ── Canvas Snapshot (full state load) ──────────────────────────────

export const CanvasSnapshotInputSchema = z.object({
  canvas_id: z.string().uuid(),
});

export type CanvasSnapshotInput = z.infer<typeof CanvasSnapshotInputSchema>;

export const CanvasNodeSchema = z.object({
  id: z.string().uuid(),
  canvas_id: z.string().uuid(),
  type: z.enum(CANVAS_NODE_TYPES),
  position: PositionSchema,
  data: z.record(z.unknown()),
  output_asset_id: z.string().uuid().nullable(),
  status: z.enum(CANVAS_NODE_STATUSES),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const CanvasEdgeSchema = z.object({
  id: z.string().uuid(),
  canvas_id: z.string().uuid(),
  source_node_id: z.string().uuid(),
  target_node_id: z.string().uuid(),
  source_handle: z.string().nullable(),
  target_handle: z.string().nullable(),
  created_at: z.string().datetime(),
});

export const CanvasSnapshotOutputSchema = z.object({
  canvas: z.object({
    id: z.string().uuid(),
    tenant_id: z.string(),
    name: z.string(),
    viewport: ViewportSchema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
});

export type CanvasSnapshotOutput = z.infer<typeof CanvasSnapshotOutputSchema>;

// ── Canvas Save (batch upsert nodes + edges) ───────────────────────

export const CanvasNodeUpsertSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(CANVAS_NODE_TYPES),
  position: PositionSchema,
  data: z.record(z.unknown()),
});

export const CanvasEdgeUpsertSchema = z.object({
  id: z.string().uuid(),
  source_node_id: z.string().uuid(),
  target_node_id: z.string().uuid(),
  source_handle: z.string().nullable().optional(),
  target_handle: z.string().nullable().optional(),
});

export const CanvasSaveInputSchema = z.object({
  canvas_id: z.string().uuid(),
  nodes: z.array(CanvasNodeUpsertSchema),
  edges: z.array(CanvasEdgeUpsertSchema),
  viewport: ViewportSchema.optional(),
});

export type CanvasSaveInput = z.infer<typeof CanvasSaveInputSchema>;

export const CanvasSaveOutputSchema = z.object({
  ok: z.literal(true),
});

// ── Node Run ───────────────────────────────────────────────────────

export const NodeRunInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
});

export type NodeRunInput = z.infer<typeof NodeRunInputSchema>;

export const NodeRunOutputSchema = z.object({
  job_id: z.string().uuid(),
  node_id: z.string().uuid(),
  job_type: z.string(),
  queue_name: z.string(),
});

export type NodeRunOutput = z.infer<typeof NodeRunOutputSchema>;

// ── Node Run Batch ─────────────────────────────────────────────────

export const NodeRunBatchInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_ids: z.array(z.string().uuid()).min(1).max(50),
});

export type NodeRunBatchInput = z.infer<typeof NodeRunBatchInputSchema>;

export const NodeRunBatchOutputSchema = z.object({
  jobs: z.array(
    z.object({
      node_id: z.string().uuid(),
      job_id: z.string().uuid(),
      job_type: z.string(),
    }),
  ),
});

export type NodeRunBatchOutput = z.infer<typeof NodeRunBatchOutputSchema>;

// ── Get Node Status (for polling) ──────────────────────────────────

export const NodeStatusInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
});

export const NodeStatusOutputSchema = z.object({
  node_id: z.string().uuid(),
  status: z.enum(CANVAS_NODE_STATUSES),
  output_asset_id: z.string().uuid().nullable(),
  job_id: z.string().uuid().nullable(),
  job_status: z.string().nullable(),
  job_progress: z.number().int().nullable(),
});

// ── Character View Run (三视图) ────────────────────────────────────

export const CharacterViewRunInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
  view: z.enum(["front", "side", "back"]),
});

export type CharacterViewRunInput = z.infer<typeof CharacterViewRunInputSchema>;

// ── Multi-Camera Grid (多机位宫格) ─────────────────────────────────

export const MultiCameraGridInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
  grid_size: z.enum(["3x3", "5x5"]),
});

export type MultiCameraGridInput = z.infer<typeof MultiCameraGridInputSchema>;

// ── Script-to-Storyboard (剧本转分镜) ──────────────────────────────

export const Script2StoryboardInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
});

export type Script2StoryboardInput = z.infer<typeof Script2StoryboardInputSchema>;

// ── Export URL (导出下载) ───────────────────────────────────────────

export const ExportUrlInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
});

export const ExportUrlOutputSchema = z.object({
  download_url: z.string().url().nullable(),
  filename: z.string().nullable(),
});

// ── Motion Prediction (画面推演) ───────────────────────────────────

export const MotionPredictionInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
  direction: z.enum(["forward", "backward"]),
  seconds: z.number().int().min(1).max(10).default(3),
});

export type MotionPredictionInput = z.infer<typeof MotionPredictionInputSchema>;

// ── Grid Split (宫格切分) ──────────────────────────────────────────

export const GridSplitInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
  grid_size: z.enum(["3x3", "5x5"]),
});

export type GridSplitInput = z.infer<typeof GridSplitInputSchema>;

// ── Story Push 4-Grid (剧情推演) ───────────────────────────────────

export const StoryPushInputSchema = z.object({
  canvas_id: z.string().uuid(),
  node_id: z.string().uuid(),
});

export type StoryPushInput = z.infer<typeof StoryPushInputSchema>;
