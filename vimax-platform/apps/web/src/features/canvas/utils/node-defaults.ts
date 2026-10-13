import type { CanvasNodeType } from "@vimax/contracts";
import { getImageKindPreset } from "@vimax/contracts";

export const FALLBACK_IMAGE_MODEL_ID = "doubao-seedream-4-0";
export const FALLBACK_VIDEO_MODEL_ID = "doubao-seedance-1-0-lite";

export interface ModelDefaults {
  imageModelId?: string;
  videoModelId?: string;
}

export function getDefaultNodeData(
  type: CanvasNodeType,
  defaults?: ModelDefaults,
  kind?: string,
): Record<string, unknown> {
  const imageModelId = defaults?.imageModelId || FALLBACK_IMAGE_MODEL_ID;
  const videoModelId = defaults?.videoModelId || FALLBACK_VIDEO_MODEL_ID;

  switch (type) {
    case "script":
      return { content: "", status: "idle" };
    case "audio":
      return { prompt: "", status: "idle" };
    case "character":
      return { name: "新角色", description: "", status: "idle" };
    case "storyboard_cell":
      return { shotBrief: "", cameraIdx: 0, status: "idle" };
    case "shot":
      return {
        ffDesc: "",
        lfDesc: "",
        motionDesc: "",
        audioDesc: "",
        variationType: "medium",
        ffVisCharIdxs: [],
        lfVisCharIdxs: [],
        negativePrompt: "",
        status: "idle",
      };
    case "image": {
      const preset = getImageKindPreset(kind);
      return {
        prompt: "",
        negativePrompt: "",
        modelId: imageModelId,
        size: preset?.size ?? "1024x1024",
        kind: preset?.kind,
        status: "idle",
      };
    }
    case "video":
      return {
        motionPreset: "zoom_in",
        durationSec: 4,
        modelId: videoModelId,
        negativePrompt: "",
        status: "idle",
      };
    case "concat":
      return { transition: "dissolve", status: "idle" };
    default:
      return { status: "idle" };
  }
}
