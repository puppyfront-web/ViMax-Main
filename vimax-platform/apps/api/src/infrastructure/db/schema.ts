import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const assetKindEnum = pgEnum("asset_kind", ["image", "video", "audio", "json"]);
export const assetSourceEnum = pgEnum("asset_source", ["generated", "upload"]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cached",
  "cancelled",
]);

export const jobEventTypeEnum = pgEnum("job_event_type", [
  "queued",
  "started",
  "progress",
  "log",
  "completed",
  "failed",
]);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: assetKindEnum("kind").notNull().default("image"),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    source: assetSourceEnum("source").notNull().default("upload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sha256Idx: index("assets_sha256_idx").on(table.sha256),
    storageKeyIdx: index("assets_storage_key_idx").on(table.storageKey),
  }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: text("job_type").notNull(),
    queueName: text("queue_name").notNull().default("q.image.std"),
    bullmqJobId: text("bullmq_job_id").unique(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    cacheKey: text("cache_key").notNull(),
    outputAssetId: uuid("output_asset_id").references(() => assets.id),
    status: jobStatusEnum("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    cacheKeyIdx: index("jobs_cache_key_idx").on(table.cacheKey),
    statusIdx: index("jobs_status_idx").on(table.status),
    queuedAtIdx: index("jobs_queued_at_idx").on(table.queuedAt),
  }),
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    eventType: jobEventTypeEnum("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdTsIdx: index("job_events_job_id_ts_idx").on(table.jobId, table.ts),
  }),
);

// ── Canvas enums ───────────────────────────────────────────────────

export const canvasNodeTypeEnum = pgEnum("canvas_node_type", [
  "script",
  "character",
  "storyboard_cell",
  "shot",
  "image",
  "video",
  "concat",
]);

export const canvasNodeStatusEnum = pgEnum("canvas_node_status", [
  "idle",
  "running",
  "done",
  "dirty",
  "failed",
]);

// ── Canvas tables ──────────────────────────────────────────────────

export const canvases = pgTable(
  "canvases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().default("default"),
    name: text("name").notNull(),
    viewport: jsonb("viewport").notNull().default({ x: 0, y: 0, zoom: 1 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index("canvases_tenant_id_idx").on(table.tenantId),
    updatedAtIdx: index("canvases_updated_at_idx").on(table.updatedAt),
  }),
);

export const canvasNodes = pgTable(
  "canvas_nodes",
  {
    id: uuid("id").primaryKey(), // client-assigned UUID
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    type: canvasNodeTypeEnum("type").notNull(),
    position: jsonb("position").notNull().default({ x: 0, y: 0 }),
    data: jsonb("data").notNull().default({}),
    outputAssetId: uuid("output_asset_id").references(() => assets.id),
    status: canvasNodeStatusEnum("status").notNull().default("idle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canvasIdIdx: index("canvas_nodes_canvas_id_idx").on(table.canvasId),
    canvasTypeIdx: index("canvas_nodes_canvas_type_idx").on(table.canvasId, table.type),
  }),
);

export const canvasEdges = pgTable(
  "canvas_edges",
  {
    id: uuid("id").primaryKey(), // client-assigned UUID
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    sourceNodeId: uuid("source_node_id")
      .notNull()
      .references(() => canvasNodes.id, { onDelete: "cascade" }),
    targetNodeId: uuid("target_node_id")
      .notNull()
      .references(() => canvasNodes.id, { onDelete: "cascade" }),
    sourceHandle: text("source_handle"),
    targetHandle: text("target_handle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canvasIdIdx: index("canvas_edges_canvas_id_idx").on(table.canvasId),
    sourceNodeIdx: index("canvas_edges_source_node_idx").on(table.sourceNodeId),
    targetNodeIdx: index("canvas_edges_target_node_idx").on(table.targetNodeId),
  }),
);

// ── TypeScript types ───────────────────────────────────────────────

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;

export type Canvas = typeof canvases.$inferSelect;
export type NewCanvas = typeof canvases.$inferInsert;
export type CanvasNode = typeof canvasNodes.$inferSelect;
export type NewCanvasNode = typeof canvasNodes.$inferInsert;
export type CanvasEdge = typeof canvasEdges.$inferSelect;
export type NewCanvasEdge = typeof canvasEdges.$inferInsert;

// ── Character Library (跨画布角色管理) ──────────────────────────────

export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().default("default"),
    name: text("name").notNull(),
    description: text("description"),
    frontAssetId: uuid("front_asset_id").references(() => assets.id),
    sideAssetId: uuid("side_asset_id").references(() => assets.id),
    backAssetId: uuid("back_asset_id").references(() => assets.id),
    tags: jsonb("tags").default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index("characters_tenant_id_idx").on(table.tenantId),
    updatedAtIdx: index("characters_updated_at_idx").on(table.updatedAt),
  }),
);

export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
