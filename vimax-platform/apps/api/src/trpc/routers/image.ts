import { TRPCError } from "@trpc/server";
import {
  AssetConfirmUploadSchema,
  AssetUploadRequestSchema,
  ImageGenerateInputSchema,
} from "@vimax/contracts";
import { and, desc, eq, like, lt } from "drizzle-orm";
import { z } from "zod";
import {
  confirmAssetUpload,
  getAssetDownloadUrl,
  requestAssetUpload,
} from "../../domain/asset/asset.service.js";
import { generateImage, getImageJob } from "../../domain/image/generate.service.js";
import { getJobWithOutputUrl } from "../../domain/job/job-event.service.js";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, jobs } from "../../infrastructure/db/schema.js";
import { createPresignedDownloadUrl } from "../../infrastructure/storage/s3.js";
import { protectedProcedure, router } from "../trpc.js";

function mapError(err: unknown): never {
  const message = err instanceof Error ? err.message : "internal";
  const codeMap: Record<string, TRPCError["code"]> = {
    "input.asset_not_found": "NOT_FOUND",
    "input.unsupported_model": "BAD_REQUEST",
    "provider.invalid_key": "PRECONDITION_FAILED",
  };
  throw new TRPCError({
    code: codeMap[message] ?? "INTERNAL_SERVER_ERROR",
    message,
  });
}

export const imageRouter = router({
  generate: protectedProcedure.input(ImageGenerateInputSchema).mutation(async ({ input }) => {
    try {
      return await generateImage(input);
    } catch (err) {
      mapError(err);
    }
  }),

  getJob: protectedProcedure
    .input(z.object({ job_id: z.string().uuid() }))
    .query(async ({ input }) => {
      const result = await getJobWithOutputUrl(input.job_id);
      if (!result) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }

      const snapshot = result.job.inputSnapshot as {
        prompt?: string;
        mode?: string;
        model_id?: string;
        size?: string;
      };

      return {
        job_id: result.job.id,
        status: result.job.status,
        progress: result.job.progress,
        job_type: result.job.jobType,
        prompt: snapshot.prompt,
        mode: snapshot.mode,
        model_id: snapshot.model_id,
        size: snapshot.size,
        output_asset_id: result.job.outputAssetId,
        output_url: result.outputUrl,
        error_code: result.job.errorCode,
        error_message: result.job.errorMessage,
        queued_at: result.job.queuedAt?.toISOString(),
        finished_at: result.job.finishedAt?.toISOString(),
      };
    }),

  listHistory: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 20;
      const db = getDb();

      let cursorQueuedAt: Date | undefined;
      if (input?.cursor) {
        const cursorJob = await getImageJob(input.cursor);
        cursorQueuedAt = cursorJob?.queuedAt;
      }

      const rows = await db
        .select()
        .from(jobs)
        .where(
          and(
            like(jobs.jobType, "image.%"),
            cursorQueuedAt ? lt(jobs.queuedAt, cursorQueuedAt) : undefined,
          ),
        )
        .orderBy(desc(jobs.queuedAt))
        .limit(limit + 1);

      const page = rows.slice(0, limit);

      const items = await Promise.all(
        page.map(async (job) => {
          const snapshot = job.inputSnapshot as {
            prompt?: string;
            mode?: string;
            model_id?: string;
          };
          let thumbnailUrl: string | undefined;
          if (job.outputAssetId) {
            const [asset] = await db
              .select()
              .from(assets)
              .where(eq(assets.id, job.outputAssetId))
              .limit(1);
            if (asset) {
              thumbnailUrl = await createPresignedDownloadUrl(asset.storageKey, 600);
            }
          }
          return {
            job_id: job.id,
            status: job.status,
            prompt: snapshot.prompt ?? "",
            mode: snapshot.mode,
            model_id: snapshot.model_id,
            thumbnail_url: thumbnailUrl,
            created_at: job.queuedAt.toISOString(),
          };
        }),
      );

      return {
        items,
        nextCursor: rows.length > limit ? rows[limit]?.id : undefined,
      };
    }),
});

export const assetRouter = router({
  requestUpload: protectedProcedure.input(AssetUploadRequestSchema).mutation(async ({ input }) => {
    return requestAssetUpload(input);
  }),

  confirmUpload: protectedProcedure.input(AssetConfirmUploadSchema).mutation(async ({ input }) => {
    try {
      return await confirmAssetUpload(input);
    } catch (err) {
      mapError(err);
    }
  }),

  getDownloadUrl: protectedProcedure
    .input(z.object({ asset_id: z.string().uuid() }))
    .query(async ({ input }) => {
      try {
        return await getAssetDownloadUrl(input.asset_id);
      } catch (err) {
        mapError(err);
      }
    }),

  // ── Asset Library (资源库) ──────────────────────────────────────

  listAssets: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["image", "video", "audio"]).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().uuid().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const kind = input?.kind;
      const db = getDb();

      const conditions = [];
      if (kind) {
        conditions.push(eq(assets.kind, kind));
      }
      if (input?.cursor) {
        const [cursorAsset] = await db
          .select({ createdAt: assets.createdAt })
          .from(assets)
          .where(eq(assets.id, input.cursor))
          .limit(1);
        if (cursorAsset) {
          conditions.push(lt(assets.createdAt, cursorAsset.createdAt));
        }
      }

      const rows = await db
        .select()
        .from(assets)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(assets.createdAt))
        .limit(limit + 1);

      const page = rows.slice(0, limit);

      const items = await Promise.all(
        page.map(async (asset) => {
          let downloadUrl: string | undefined;
          try {
            downloadUrl = await createPresignedDownloadUrl(asset.storageKey, 300);
          } catch {
            // Skip if presigned URL fails
          }
          return {
            asset_id: asset.id,
            kind: asset.kind,
            mime_type: asset.mimeType,
            width: asset.width,
            height: asset.height,
            size_bytes: asset.sizeBytes,
            source: asset.source,
            download_url: downloadUrl,
            created_at: asset.createdAt.toISOString(),
          };
        }),
      );

      return {
        items,
        nextCursor: rows.length > limit ? rows[limit]?.id : undefined,
      };
    }),
});
