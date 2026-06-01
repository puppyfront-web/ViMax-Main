import type { JobEventValidated } from "@vimax/contracts";
import { JobEventSchema } from "@vimax/contracts";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, jobEvents, jobs } from "../../infrastructure/db/schema.js";
import { createPresignedDownloadUrl } from "../../infrastructure/storage/s3.js";
import { broadcastJobEvent } from "../../realtime/sse.js";

function mapEventType(type: JobEventValidated["type"]) {
  switch (type) {
    case "started":
      return "started" as const;
    case "progress":
      return "progress" as const;
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "log" as const;
  }
}

export async function handleJobEvent(raw: string): Promise<void> {
  let parsed: JobEventValidated;
  try {
    parsed = JobEventSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }

  const db = getDb();
  await db.insert(jobEvents).values({
    jobId: parsed.job_id,
    eventType: mapEventType(parsed.type),
    payload: parsed as unknown as Record<string, unknown>,
  });

  if (parsed.type === "started") {
    await db
      .update(jobs)
      .set({ status: "running", startedAt: new Date(), progress: 5 })
      .where(eq(jobs.id, parsed.job_id));
  }

  if (parsed.type === "progress") {
    await db
      .update(jobs)
      .set({ progress: parsed.percent })
      .where(eq(jobs.id, parsed.job_id));
  }

  if (parsed.type === "completed") {
    const [existingAsset] = await db
      .select()
      .from(assets)
      .where(eq(assets.storageKey, parsed.output.storage_key))
      .limit(1);

    let assetId = existingAsset?.id;
    if (!assetId) {
      const [created] = await db
        .insert(assets)
        .values({
          kind: "image",
          mimeType: parsed.output.mime_type,
          storageKey: parsed.output.storage_key,
          sizeBytes: parsed.output.size_bytes,
          width: parsed.output.width,
          height: parsed.output.height,
          sha256: parsed.output.sha256,
          source: "generated",
        })
        .returning();
      assetId = created.id;
    }

    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        outputAssetId: assetId,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, parsed.job_id));
  }

  if (parsed.type === "failed") {
    await db
      .update(jobs)
      .set({
        status: "failed",
        errorCode: parsed.error_code,
        errorMessage: parsed.error_message,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, parsed.job_id));
  }

  broadcastJobEvent(parsed.job_id, parsed);
}

export async function getJobEvents(jobId: string) {
  const db = getDb();
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(asc(jobEvents.ts));
}

export async function getJobWithOutputUrl(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    return null;
  }

  let outputUrl: string | undefined;
  if (job.outputAssetId) {
    const [asset] = await db.select().from(assets).where(eq(assets.id, job.outputAssetId)).limit(1);
    if (asset) {
      outputUrl = await createPresignedDownloadUrl(asset.storageKey);
    }
  }

  return { job, outputUrl };
}
