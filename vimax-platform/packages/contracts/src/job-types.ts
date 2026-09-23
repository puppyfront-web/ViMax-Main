export const IMAGE_JOB_TYPES = [
  "image.t2i",
  "image.i2i",
] as const;

/** Canvas-originated job types that still use the image generation pipeline. */
export const CANVAS_IMAGE_JOB_TYPES = [
  "shot.first_frame",
  "shot.last_frame",
  "character.portrait.front",
  "character.portrait.side",
  "character.portrait.back",
] as const;

export const ALL_IMAGE_JOB_TYPES = [
  ...IMAGE_JOB_TYPES,
  ...CANVAS_IMAGE_JOB_TYPES,
] as const;

export type ImageJobType = (typeof IMAGE_JOB_TYPES)[number];
export type CanvasImageJobType = (typeof CANVAS_IMAGE_JOB_TYPES)[number];
export type AllImageJobType = (typeof ALL_IMAGE_JOB_TYPES)[number];

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
  job_type: AllImageJobType;
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

// ── Video job types ─────────────────────────────────────────────────

export const VIDEO_JOB_TYPES = ["shot.video"] as const;
export type VideoJobType = (typeof VIDEO_JOB_TYPES)[number];

export const CONCAT_JOB_TYPES = ["concat.videos"] as const;
export type ConcatJobType = (typeof CONCAT_JOB_TYPES)[number];

/** All job types that can reach the Python workers. */
export const ALL_WORKER_JOB_TYPES = [
  ...ALL_IMAGE_JOB_TYPES,
  ...VIDEO_JOB_TYPES,
] as const;

export interface VideoJobInput {
  prompt: string;
  first_frame_storage_key?: string;
  last_frame_storage_key?: string;
  duration_sec?: number;
  resolution?: string;
}

export interface VideoJobPayload {
  job_id: string;
  job_type: VideoJobType;
  model_id: string;
  credential: {
    class_path: string;
    api_key: string;
    base_url?: string;
    model?: string;
  };
  input: VideoJobInput;
  callback: {
    event_channel: string;
    upload_bucket: string;
    upload_prefix: string;
  };
  cache_key: string;
  timeout_ms: number;
}

export interface VideoJobOutput {
  storage_key: string;
  width: number;
  height: number;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  duration_sec?: number;
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

// ── Video Motion Presets (大师运镜) ────────────────────────────────

export const VIDEO_MOTION_PRESETS = [
  // 基础运镜
  { id: "push_in", label: "推 (Push In)", category: "basic", description: "缓慢推向主体，制造紧张感" },
  { id: "pull_out", label: "拉 (Pull Out)", category: "basic", description: "从主体缓慢拉远，展现场景全貌" },
  { id: "pan_left", label: "摇左 (Pan Left)", category: "basic", description: "水平向左摇镜头" },
  { id: "pan_right", label: "摇右 (Pan Right)", category: "basic", description: "水平向右摇镜头" },
  { id: "tilt_up", label: "仰 (Tilt Up)", category: "basic", description: "从下向上仰拍，展现宏伟" },
  { id: "tilt_down", label: "俯 (Tilt Down)", category: "basic", description: "从上向下俯拍，展现全貌" },
  { id: "zoom_in", label: "变焦推近 (Zoom In)", category: "basic", description: "镜头变焦推近，聚焦细节" },
  { id: "zoom_out", label: "变焦拉远 (Zoom Out)", category: "basic", description: "镜头变焦拉远，展现环境" },
  // 运动运镜
  { id: "tracking", label: "跟拍 (Tracking)", category: "movement", description: "跟随主体移动，保持距离" },
  { id: "orbit", label: "环绕 (Orbit)", category: "movement", description: "围绕主体360度旋转拍摄" },
  { id: "aerial", label: "航拍 (Aerial)", category: "movement", description: "高空俯视航拍大场景" },
  { id: "crane", label: "升降 (Crane)", category: "movement", description: "摇臂升降运动，从地面到高空" },
  { id: "dolly", label: "滑轨 (Dolly)", category: "movement", description: "沿滑轨平滑推进或拉远" },
  // 效果运镜
  { id: "handheld", label: "手持晃动 (Handheld)", category: "effect", description: "手持摄影晃动效果，增加真实感" },
  { id: "static", label: "静止 (Static)", category: "effect", description: "固定机位静止画面" },
  { id: "whip_pan", label: "甩镜 (Whip Pan)", category: "effect", description: "快速甩镜转场，连接两个画面" },
  { id: "roll", label: "旋转 (Roll)", category: "effect", description: "镜头绕光轴旋转" },
  { id: "rack_focus", label: "移焦 (Rack Focus)", category: "effect", description: "焦点从一个主体转移到另一个" },
] as const;

export type VideoMotionPresetId = (typeof VIDEO_MOTION_PRESETS)[number]["id"];

export function getMotionPreset(id: string) {
  return VIDEO_MOTION_PRESETS.find((p) => p.id === id);
}

// ── Video Model Descriptors ────────────────────────────────────────

export interface VideoModelDescriptor {
  id: string;
  label: string;
  provider: "doubao" | "google" | "yunwu";
  class_path: string;
  maxDuration: number;
  resolutions: string[];
  supports_reference: boolean;
  credits_per_second: number;
  init_args?: Record<string, string>;
}

export const VIDEO_MODELS: VideoModelDescriptor[] = [
  {
    id: "doubao-seedance-1-0-lite",
    label: "Doubao Seedance 1.0 Lite",
    provider: "doubao",
    class_path: "tools.VideoGeneratorDoubaoSeedanceYunwuAPI",
    maxDuration: 10,
    resolutions: ["480p", "720p", "1080p"],
    supports_reference: true,
    credits_per_second: 1,
    init_args: {
      base_url: "https://yunwu.ai/volc/v1/contents/generations/tasks",
    },
  },
  {
    id: "veo-yunwu",
    label: "Veo 3.1 (Yunwu)",
    provider: "yunwu",
    class_path: "tools.VideoGeneratorVeoYunwuAPI",
    maxDuration: 8,
    resolutions: ["720p", "1080p"],
    supports_reference: true,
    credits_per_second: 2,
    init_args: {
      base_url: "https://yunwu.ai",
    },
  },
  {
    id: "veo-google",
    label: "Veo 3.1 (Google)",
    provider: "google",
    class_path: "tools.VideoGeneratorVeoGoogleAPI",
    maxDuration: 8,
    resolutions: ["720p", "1080p"],
    supports_reference: true,
    credits_per_second: 3,
  },
];

export function getVideoModel(modelId: string): VideoModelDescriptor | undefined {
  return VIDEO_MODELS.find((m) => m.id === modelId);
}

// ── Default Text Model (fallback when no DB model configured) ──────────

export const DEFAULT_TEXT_MODEL_ID = "doubao-pro-32k";

export const DEFAULT_TEXT_MODEL = {
  id: DEFAULT_TEXT_MODEL_ID,
  label: "Doubao Pro 32K",
  provider: "doubao" as const,
  vendorId: "openai-compatible",
  vendorModelId: "doubao-pro-32k",
  maxTokens: 32768,
  supportsThinking: true,
};

// ── Pipeline Job Types ─────────────────────────────────────────────

export const PIPELINE_JOB_TYPES = [
  "pipeline.script2storyboard",
  "pipeline.story_push",
] as const;
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

// ── Audio Job Types ────────────────────────────────────────────────

export const AUDIO_JOB_TYPES = ["audio.generate"] as const;
export type AudioJobType = (typeof AUDIO_JOB_TYPES)[number];
