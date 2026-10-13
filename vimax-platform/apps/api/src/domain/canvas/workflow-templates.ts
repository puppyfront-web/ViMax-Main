// ── Workflow templates ─────────────────────────────────────────────
//
// Pre-built canvas graphs users can drop onto a blank canvas — the
// liblibtv-style "pick a template → fill in → generate" entry point.
//
// Templates compose EXISTING node types (no new schema, no migration):
// instantiation just clones the template's nodes (fresh UUIDs) and
// rewires its edges to the new ids. All execution/cache/cascade
// machinery built elsewhere applies unchanged.

import { randomUUID } from "node:crypto";
import type {
  CanvasNodeType,
  InstantiatedEdge,
  InstantiatedNode,
  TemplateCategory,
  TemplateSummary,
} from "@vimax/contracts";

// Re-export the shared DTOs so callers can import everything from here.
export type {
  InstantiatedEdge,
  InstantiatedNode,
  TemplateCategory,
  TemplateSummary,
};

// ── Template model ─────────────────────────────────────────────────

/** A node inside a template. `id` is stable WITHIN the template only. */
export interface TemplateNode {
  id: string;
  type: CanvasNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  /** Human-readable role, shown in the picker. */
  label: string;
}

export interface TemplateEdge {
  id: string;
  source: string; // TemplateNode.id
  target: string; // TemplateNode.id
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

/** Metadata for the picker — omits the heavy graph payload. */
export function summarizeTemplate(t: WorkflowTemplate): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    nodeCount: t.nodes.length,
  };
}

// ── Seed templates ─────────────────────────────────────────────────
// Positions are laid out left → right; the canvas places them as-is.

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "ecommerce-product-scene",
    name: "电商商品场景图",
    description: "上传商品白底图 → 一键生成场景图与动态视频",
    category: "ecommerce",
    nodes: [
      {
        id: "product",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          prompt: "商品白底图，干净，高清，电商主图质感",
          size: "1024x1024",
        },
        label: "商品图（替换为你的商品）",
      },
      {
        id: "scene",
        type: "image",
        position: { x: 320, y: 0 },
        data: {
          prompt: "商品置于海滩场景，黄金时刻光线，商业摄影质感，景深",
          size: "1024x1024",
        },
        label: "场景图",
      },
      {
        id: "promo",
        type: "video",
        position: { x: 640, y: 0 },
        data: { motionPreset: "zoom_in", durationSec: 4 },
        label: "动态视频",
      },
    ],
    edges: [
      { id: "e1", source: "product", target: "scene", sourceHandle: "output", targetHandle: "reference" },
      { id: "e2", source: "scene", target: "promo", sourceHandle: "output", targetHandle: "first_frame" },
    ],
  },
  {
    id: "ecommerce-main-image",
    name: "电商主图（1:1 棚拍）",
    description: "商品白底主图 + 详情场景图，1:1 主图比例，棚拍质感",
    category: "ecommerce",
    nodes: [
      {
        id: "main",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          prompt: "高质量电商商品主图，细节清晰，质感出色",
          size: "1024x1024",
          kind: "product",
          aspectRatio: "sq-1-1",
          scene: "clean-white",
        },
        label: "商品主图",
      },
      {
        id: "detail",
        type: "image",
        position: { x: 320, y: 0 },
        data: {
          prompt: "商品使用场景，突出卖点",
          size: "1024x1536",
          kind: "scene",
          aspectRatio: "pt-3-4",
          scene: "home",
        },
        label: "详情场景图",
      },
    ],
    edges: [
      { id: "e1", source: "main", target: "detail", sourceHandle: "output", targetHandle: "reference" },
    ],
  },
  {
    id: "ecommerce-feed-video",
    name: "电商信息流视频（9:16）",
    description: "商品图 → 9:16 信息流短视频，适合抖音/小红书投放",
    category: "ecommerce",
    nodes: [
      {
        id: "product",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          prompt: "商品特写，吸引眼球，适合信息流",
          size: "864x1536",
          kind: "product",
          aspectRatio: "fv-9-16",
          scene: "studio",
        },
        label: "商品图（9:16）",
      },
      {
        id: "feed",
        type: "video",
        position: { x: 320, y: 0 },
        data: { motionPreset: "zoom_in", durationSec: 5 },
        label: "信息流视频",
      },
    ],
    edges: [
      { id: "e1", source: "product", target: "feed", sourceHandle: "output", targetHandle: "first_frame" },
    ],
  },
  {
    id: "short-drama-shot",
    name: "短剧·单镜头",
    description: "角色 → 镜头 → 首帧 → 视频，一条完整的短剧镜头流水线",
    category: "short-drama",
    nodes: [
      {
        id: "hero",
        type: "character",
        position: { x: 0, y: 0 },
        data: { name: "主角", description: "请填写角色外貌与服饰" },
        label: "角色",
      },
      {
        id: "shot",
        type: "shot",
        position: { x: 320, y: 0 },
        data: {
          ffDesc: "角色出场，中景，环境光",
          lfDesc: "",
          motionDesc: "缓慢推近",
          audioDesc: "",
          variationType: "medium",
        },
        label: "镜头",
      },
      {
        id: "frame",
        type: "image",
        position: { x: 640, y: 0 },
        data: { prompt: "角色中景出场镜头，电影感", size: "1600x900" },
        label: "首帧",
      },
      {
        id: "clip",
        type: "video",
        position: { x: 960, y: 0 },
        data: { motionPreset: "zoom_in", durationSec: 4 },
        label: "视频",
      },
    ],
    edges: [
      { id: "e1", source: "hero", target: "shot", targetHandle: "reference" },
      { id: "e2", source: "shot", target: "frame", sourceHandle: "first_frame", targetHandle: "reference" },
      { id: "e3", source: "frame", target: "clip", sourceHandle: "output", targetHandle: "first_frame" },
    ],
  },
  {
    id: "ad-key-visual",
    name: "创意广告·关键画面",
    description: "创意脚本 → 关键画面 → 动态视频，快速出广告素材",
    category: "ad",
    nodes: [
      {
        id: "idea",
        type: "script",
        position: { x: 0, y: 0 },
        data: { content: "广告创意：一句话卖点 + 视觉风格描述" },
        label: "创意脚本",
      },
      {
        id: "keyvisual",
        type: "image",
        position: { x: 320, y: 0 },
        data: { prompt: "广告关键画面，强视觉冲击，品牌调性，高清", size: "1024x1024" },
        label: "关键画面",
      },
      {
        id: "motion",
        type: "video",
        position: { x: 640, y: 0 },
        data: { motionPreset: "zoom_in", durationSec: 5 },
        label: "动态视频",
      },
    ],
    edges: [
      { id: "e1", source: "idea", target: "keyvisual" },
      { id: "e2", source: "keyvisual", target: "motion", sourceHandle: "output", targetHandle: "first_frame" },
    ],
  },
  {
    id: "creative-asset-pack",
    name: "创意素材包（人物/场景/道具）",
    description: "人物形象、场景概念、道具素材一次配齐，作为可复用的参考素材库",
    category: "general",
    nodes: [
      {
        id: "portrait",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          prompt: "主要人物形象，正面半身，气质鲜明",
          kind: "portrait",
          size: "1024x1536",
        },
        label: "人物形象",
      },
      {
        id: "environment",
        type: "image",
        position: { x: 320, y: 0 },
        data: {
          prompt: "故事主场景概念图，氛围光影",
          kind: "environment",
          size: "1600x900",
        },
        label: "场景概念",
      },
      {
        id: "prop",
        type: "image",
        position: { x: 640, y: 0 },
        data: {
          prompt: "关键道具，干净背景，细节清晰",
          kind: "prop",
          size: "1024x1024",
        },
        label: "道具素材",
      },
    ],
    edges: [],
  },
];

export function getTemplateById(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

// ── Instantiation (pure) ───────────────────────────────────────────

export interface InstantiateOptions {
  /** Override the id generator (deterministic ids for tests). */
  idGenerator?: () => string;
  /** Translate every node position by this offset. */
  offset?: { x: number; y: number };
}

/**
 * Clone a template into a concrete set of canvas nodes + edges with fresh
 * ids. Edges are rewired from template-local ids to the new node ids.
 * Node `data` is shallow-cloned per node (the template is never mutated).
 */
export function instantiateTemplate(
  template: WorkflowTemplate,
  opts: InstantiateOptions = {},
): { nodes: InstantiatedNode[]; edges: InstantiatedEdge[] } {
  const gen = opts.idGenerator ?? randomUUID;
  const offset = opts.offset ?? { x: 0, y: 0 };

  const idMap = new Map<string, string>();
  const nodes: InstantiatedNode[] = template.nodes.map((n) => {
    const newId = gen();
    idMap.set(n.id, newId);
    return {
      id: newId,
      type: n.type,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: { ...n.data },
    };
  });

  const edges: InstantiatedEdge[] = template.edges.map((e) => ({
    id: gen(),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));

  return { nodes, edges };
}
