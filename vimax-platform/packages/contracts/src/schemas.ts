import { z } from "zod";
import { ALL_IMAGE_JOB_TYPES, IMAGE_MODES, IMAGE_SIZES, PIPELINE_JOB_TYPES, AUDIO_JOB_TYPES } from "./job-types.js";

export const ImageGenerateInputSchema = z
  .object({
    mode: z.enum(IMAGE_MODES),
    prompt: z.string().min(1).max(4000),
    model_id: z.string().min(1),
    size: z.enum(IMAGE_SIZES),
    reference_asset_ids: z.array(z.string().uuid()).max(4).optional(),
    force: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "i2i" && (!val.reference_asset_ids || val.reference_asset_ids.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "i2i mode requires at least one reference_asset_id",
        path: ["reference_asset_ids"],
      });
    }
  });

export type ImageGenerateInput = z.infer<typeof ImageGenerateInputSchema>;

export const ImageGenerateOutputSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(["queued", "cached"]),
  cache_hit: z.boolean(),
  output_asset_id: z.string().uuid().optional(),
});

export type ImageGenerateOutput = z.infer<typeof ImageGenerateOutputSchema>;

export const AssetUploadRequestSchema = z.object({
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(20 * 1024 * 1024),
});

export type AssetUploadRequest = z.infer<typeof AssetUploadRequestSchema>;

export const AssetUploadResponseSchema = z.object({
  asset_id: z.string().uuid(),
  upload_url: z.string().url(),
  storage_key: z.string(),
  expires_at: z.string().datetime(),
});

export type AssetUploadResponse = z.infer<typeof AssetUploadResponseSchema>;

export const AssetConfirmUploadSchema = z.object({
  asset_id: z.string().uuid(),
  sha256: z.string().length(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type AssetConfirmUpload = z.infer<typeof AssetConfirmUploadSchema>;

export const ImageJobPayloadSchema = z.object({
  job_id: z.string().uuid(),
  job_type: z.enum(ALL_IMAGE_JOB_TYPES),
  model_id: z.string(),
  credential: z.object({
    class_path: z.string(),
    api_key: z.string(),
    base_url: z.string().optional(),
    model: z.string().optional(),
  }),
  input: z.object({
    prompt: z.string(),
    size: z.enum(IMAGE_SIZES),
    reference_storage_keys: z.array(z.string()).optional(),
  }),
  callback: z.object({
    event_channel: z.string(),
    upload_bucket: z.string(),
    upload_prefix: z.string(),
  }),
  cache_key: z.string(),
  timeout_ms: z.number().int().positive(),
});

export type ImageJobPayloadValidated = z.infer<typeof ImageJobPayloadSchema>;

// ── Video job payload (forshot.video) ──────────────────────────────

export const VideoJobPayloadSchema = z.object({
  job_id: z.string().uuid(),
  job_type: z.enum(["shot.video"]),
  model_id: z.string(),
  credential: z.object({
    class_path: z.string(),
    api_key: z.string(),
    base_url: z.string().optional(),
    model: z.string().optional(),
  }),
  input: z.object({
    prompt: z.string(),
    first_frame_storage_key: z.string().optional(),
    last_frame_storage_key: z.string().optional(),
    duration_sec: z.number().int().positive().optional(),
    resolution: z.string().optional(),
  }),
  callback: z.object({
    event_channel: z.string(),
    upload_bucket: z.string(),
    upload_prefix: z.string(),
  }),
  cache_key: z.string(),
  timeout_ms: z.number().int().positive(),
});

export type VideoJobPayloadValidated = z.infer<typeof VideoJobPayloadSchema>;

// ── Concat job payload ────────────────────────────────────────────────

export const ConcatJobPayloadSchema = z.object({
  job_id: z.string().uuid(),
  job_type: z.enum(["concat.videos"]),
  input: z.object({
    storage_keys: z.array(z.string()),
  }),
  callback: z.object({
    event_channel: z.string(),
    upload_bucket: z.string(),
    upload_prefix: z.string(),
  }),
  cache_key: z.string(),
  timeout_ms: z.number().int().positive(),
});

export type ConcatJobPayloadValidated = z.infer<typeof ConcatJobPayloadSchema>;

export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    ts: z.string(),
    job_id: z.string().uuid(),
  }),
  z.object({
    type: z.literal("progress"),
    ts: z.string(),
    job_id: z.string().uuid(),
    percent: z.number().min(0).max(100),
    message: z.string(),
  }),
  z.object({
    type: z.literal("completed"),
    ts: z.string(),
    job_id: z.string().uuid(),
    output: z.object({
      storage_key: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      sha256: z.string(),
      mime_type: z.string(),
      size_bytes: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal("failed"),
    ts: z.string(),
    job_id: z.string().uuid(),
    error_code: z.string(),
    error_message: z.string(),
    retryable: z.boolean(),
  }),
]);

export type JobEventValidated = z.infer<typeof JobEventSchema>;

// ── Pipeline job payload ───────────────────────────────────────────

export const PipelineJobPayloadSchema = z.object({
  job_id: z.string().uuid(),
  job_type: z.enum(PIPELINE_JOB_TYPES),
  credential: z.object({
    class_path: z.string(),
    api_key: z.string(),
    base_url: z.string().optional(),
    model: z.string().optional(),
  }),
  input: z.object({
    content: z.string(),
    // For story_push: reference image storage keys
    reference_storage_keys: z.array(z.string()).optional(),
  }),
  callback: z.object({
    event_channel: z.string(),
    upload_bucket: z.string(),
    upload_prefix: z.string(),
  }),
  cache_key: z.string(),
  timeout_ms: z.number().int().positive(),
});

export type PipelineJobPayloadValidated = z.infer<typeof PipelineJobPayloadSchema>;

// ── Audio job payload ──────────────────────────────────────────────

export const AudioJobPayloadSchema = z.object({
  job_id: z.string().uuid(),
  job_type: z.enum(AUDIO_JOB_TYPES),
  input: z.object({
    prompt: z.string(),
    duration_sec: z.number().int().positive().optional(),
  }),
  callback: z.object({
    event_channel: z.string(),
    upload_bucket: z.string(),
    upload_prefix: z.string(),
  }),
  cache_key: z.string(),
  timeout_ms: z.number().int().positive(),
});

export type AudioJobPayloadValidated = z.infer<typeof AudioJobPayloadSchema>;
