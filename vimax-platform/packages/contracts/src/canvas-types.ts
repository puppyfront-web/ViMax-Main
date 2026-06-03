// ── Canvas Node Types ──────────────────────────────────────────────

export const CANVAS_NODE_TYPES = [
  "script",
  "character",
  "storyboard_cell",
  "shot",
  "image",
  "video",
  "concat",
] as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

export const CANVAS_NODE_STATUSES = [
  "idle",
  "running",
  "done",
  "dirty",
  "failed",
] as const;

export type CanvasNodeStatus = (typeof CANVAS_NODE_STATUSES)[number];

// ── Canvas Job Types (for job_type column) ─────────────────────────

export const CANVAS_JOB_TYPES = [
  "shot.first_frame",
  "shot.last_frame",
  "shot.video",
  "pipeline.idea2video",
  "pipeline.script2video",
  "character.portrait.side",
  "character.portrait.back",
  // ── New job types ──
  "pipeline.script2storyboard",
  "shot.multi_camera_grid",
  "image.predict_motion",
  "image.split_grid",
  "pipeline.story_push",
  "audio.generate",
] as const;

export type CanvasJobType = (typeof CANVAS_JOB_TYPES)[number];

/** All job types across the platform — canvas jobs + image jobs. */
export const ALL_JOB_TYPES = [
  "image.t2i",
  "image.i2i",
  ...CANVAS_JOB_TYPES,
] as const;

// ── Queue assignment ───────────────────────────────────────────────

export const CANVAS_QUEUES = {
  "image.t2i": "q.image.std",
  "image.i2i": "q.image.std",
  "shot.first_frame": "q.image.refine",
  "shot.last_frame": "q.image.refine",
  "shot.video": "q.video.std",
  "pipeline.idea2video": "q.pipeline.full",
  "pipeline.script2video": "q.pipeline.full",
  "character.portrait.side": "q.image.refine",
  "character.portrait.back": "q.image.refine",
  // ── New queue assignments ──
  "pipeline.script2storyboard": "q.pipeline.full",
  "shot.multi_camera_grid": "q.image.refine",
  "image.predict_motion": "q.image.refine",
  "image.split_grid": "q.image.std",
  "pipeline.story_push": "q.pipeline.full",
  "audio.generate": "q.audio.std",
} as const satisfies Record<string, string>;

// ── Node Data Shapes (stored in canvas_nodes.data JSONB) ───────────

export interface ScriptNodeData {
  content: string;
}

export interface CharacterNodeData {
  name: string;
  description: string;
  frontAssetId?: string; // uploaded character front view asset
  sideAssetId?: string; // generated side view asset
  backAssetId?: string; // generated back view asset
}

export interface StoryboardCellNodeData {
  shotBrief: string;
  cameraIdx: number;
}

export interface ShotNodeData {
  ffDesc: string;
  lfDesc: string;
  motionDesc: string;
  audioDesc: string;
  variationType: "large" | "medium" | "small";
  ffVisCharIdxs: number[];
  lfVisCharIdxs: number[];
  // ── Lighting control (电影级灯光控制) ──
  keyLightPosition?: string;
  keyLightIntensity?: number;   // 0-100
  rimLight?: string;
  ambientLight?: string;        // "warm" | "cool" | "neutral"
  // ── Focus / DOF (镜头聚焦) ──
  focusPoint?: { x: number; y: number }; // 0-1 normalized
  focusRadius?: number;          // 0-100
  bokehStrength?: number;        // 0-100
}

export interface ImageNodeData {
  prompt: string;
  negativePrompt?: string;
  modelId: string;
  size: string;
  seed?: number;
  /** Direct reference assets (in addition to upstream node outputs). */
  referenceAssetIds?: string[];
}

export interface VideoNodeData {
  motionPreset: string;
  durationSec: number;
  modelId: string;
}

export interface ConcatNodeData {
  transition: string;
  /** Ordered list of upstream video node IDs (optional — defaults to edge order). */
  clipOrder?: string[];
}

/** Discriminated union of all node data shapes. */
export type CanvasNodeData =
  | { type: "script"; data: ScriptNodeData }
  | { type: "character"; data: CharacterNodeData }
  | { type: "storyboard_cell"; data: StoryboardCellNodeData }
  | { type: "shot"; data: ShotNodeData }
  | { type: "image"; data: ImageNodeData }
  | { type: "video"; data: VideoNodeData }
  | { type: "concat"; data: ConcatNodeData };

// ── Canvas, Node, Edge domain objects ──────────────────────────────

export interface CanvasNode {
  id: string; // uuid — client-assigned
  canvasId: string;
  type: CanvasNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>; // validated per type on run
  outputAssetId?: string | null;
  status: CanvasNodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string; // uuid — client-assigned
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle?: string | null; // e.g. "output", "first_frame"
  targetHandle?: string | null; // e.g. "reference", "input"
  createdAt: string;
}

export interface Canvas {
  id: string;
  tenantId: string;
  name: string;
  viewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSnapshot {
  canvas: Canvas;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ── Node → upstream dependency mapping (for DAG execution) ─────────

/** Maps a target handle to the upstream node's output. */
export interface NodeUpstream {
  /** The source node. */
  nodeId: string;
  nodeType: CanvasNodeType;
  outputAssetId: string | null;
  /** Which handle on the target this feeds into. */
  targetHandle: string;
  /** Which handle on the source this comes from. */
  sourceHandle: string;
}

// ── Lighting constants ─────────────────────────────────────────────

export const KEY_LIGHT_POSITIONS = [
  { id: "front-center", label: "正面中央" },
  { id: "front-left-30", label: "前左30度" },
  { id: "front-left-45", label: "前左45度" },
  { id: "front-left-60", label: "前左60度" },
  { id: "front-right-30", label: "前右30度" },
  { id: "front-right-45", label: "前右45度" },
  { id: "front-right-60", label: "前右60度" },
  { id: "side-left-90", label: "左侧90度" },
  { id: "side-right-90", label: "右侧90度" },
  { id: "back-left-120", label: "后左120度" },
  { id: "back-left-135", label: "后左135度" },
  { id: "back-left-150", label: "后左150度" },
  { id: "back-right-120", label: "后右120度" },
  { id: "back-right-135", label: "后右135度" },
  { id: "back-right-150", label: "后右150度" },
  { id: "back-center", label: "正后方" },
  { id: "top-center", label: "顶部中央" },
  { id: "top-front-45", label: "顶前45度" },
  { id: "top-back-45", label: "顶后45度" },
  { id: "top-left", label: "顶左" },
  { id: "top-right", label: "顶右" },
  { id: "bottom-front", label: "底前45度 (鬼光)" },
  { id: "bottom-left", label: "底左" },
  { id: "bottom-right", label: "底右" },
] as const;

export const RIM_LIGHT_PRESETS = [
  { id: "none", label: "无轮廓光" },
  { id: "warm-backlight", label: "暖色逆光" },
  { id: "cool-backlight", label: "冷色逆光" },
  { id: "warm-side-left", label: "暖色左侧光" },
  { id: "warm-side-right", label: "暖色右侧光" },
  { id: "cool-side-left", label: "冷色左侧光" },
  { id: "cool-side-right", label: "冷色右侧光" },
  { id: "rim-hair", label: "发丝光" },
  { id: "double-rim", label: "双侧轮廓光" },
] as const;

export const AMBIENT_LIGHT_OPTIONS = [
  { id: "neutral", label: "中性" },
  { id: "warm", label: "暖色" },
  { id: "cool", label: "冷色" },
  { id: "golden-hour", label: "黄金时刻" },
  { id: "blue-hour", label: "蓝调时刻" },
  { id: "overcast", label: "阴天漫射" },
] as const;

// ── Pipeline result types ──────────────────────────────────────────

export interface Script2StoryboardCell {
  shotBrief: string;
  cameraIdx: number;
  ffDesc: string;
  lfDesc: string;
  motionDesc: string;
}

export interface Script2StoryboardResult {
  cells: Script2StoryboardCell[];
}
