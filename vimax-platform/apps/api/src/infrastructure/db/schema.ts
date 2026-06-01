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

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
