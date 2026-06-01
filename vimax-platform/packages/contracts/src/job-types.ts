export const IMAGE_JOB_TYPES = ["image.t2i", "image.i2i"] as const;
export type ImageJobType = (typeof IMAGE_JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cached",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_EVENT_TYPES = [
  "queued",
  "started",
  "progress",
  "log",
  "completed",
  "failed",
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export const IMAGE_SIZES = [
  "1024x1024",
  "1600x900",
  "1024x1792",
  "1792x1024",
] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export const IMAGE_MODES = ["t2i", "i2i"] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

export interface ImageJobCredential {
  class_path: string;
  api_key: string;
  base_url?: string;
  model?: string;
}

export interface ImageJobInput {
  prompt: string;
  size: ImageSize;
  reference_storage_keys?: string[];
}

export interface ImageJobCallback {
  event_channel: string;
  upload_bucket: string;
  upload_prefix: string;
}

export interface ImageJobPayload {
  job_id: string;
  job_type: ImageJobType;
  model_id: string;
  credential: ImageJobCredential;
  input: ImageJobInput;
  callback: ImageJobCallback;
  cache_key: string;
  timeout_ms: number;
}

export interface ImageJobOutput {
  storage_key: string;
  width: number;
  height: number;
  sha256: string;
  mime_type: string;
  size_bytes: number;
}

export interface JobCompletedEvent {
  type: "completed";
  ts: string;
  job_id: string;
  output: ImageJobOutput;
}

export interface JobFailedEvent {
  type: "failed";
  ts: string;
  job_id: string;
  error_code: string;
  error_message: string;
  retryable: boolean;
}

export interface JobProgressEvent {
  type: "progress";
  ts: string;
  job_id: string;
  percent: number;
  message: string;
}

export interface JobStartedEvent {
  type: "started";
  ts: string;
  job_id: string;
}

export type JobEvent =
  | JobStartedEvent
  | JobProgressEvent
  | JobCompletedEvent
  | JobFailedEvent;

export interface ImageModelDescriptor {
  id: string;
  label: string;
  provider: "doubao" | "google" | "yunwu";
  class_path: string;
  sizes: ImageSize[];
  supports_reference: boolean;
  credits_per_image: number;
  init_args?: Record<string, string>;
}

export const IMAGE_MODELS: ImageModelDescriptor[] = [
  {
    id: "doubao-seedream-4-0",
    label: "Doubao Seedream 4.0",
    provider: "doubao",
    class_path: "tools.ImageGeneratorDoubaoSeedreamYunwuAPI",
    sizes: ["1024x1024", "1600x900", "1024x1792"],
    supports_reference: true,
    credits_per_image: 1,
    init_args: {
      model: "doubao-seedream-4-0-250828",
      base_url: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    },
  },
  {
    id: "nanobanana-google",
    label: "NanoBanana (Google)",
    provider: "google",
    class_path: "tools.ImageGeneratorNanobananaGoogleAPI",
    sizes: ["1024x1024", "1600x900"],
    supports_reference: true,
    credits_per_image: 2,
  },
];

export function getImageModel(modelId: string): ImageModelDescriptor | undefined {
  return IMAGE_MODELS.find((m) => m.id === modelId);
}
