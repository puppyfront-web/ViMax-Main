// ── Agent Decision Layer ─────────────────────────────────────────────
// Adapted from Toonflow's productionAgent/index.ts runDecisionAI()
// Routes user intent to appropriate sub-agents and tools.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { streamText, generateText, type AIStreamChunk } from "./ai-service.js";
import { getDb } from "../../infrastructure/db/client.js";
import { canvases, canvasNodes, canvasEdges } from "../../infrastructure/db/schema.js";
import { autoWireCanvas } from "../canvas/canvas.service.js";
import type { CanvasMutation } from "@vimax/contracts";
import {
  buildAdScriptPrompt,
  formatAdScript,
  parseAdScript,
  getAdCtaType,
  getAdHookType,
  type AdCtaTypeId,
  type AdHookTypeId,
  type AdScriptInput,
} from "@vimax/contracts";
import { getDefaultModel } from "../model/model.service.js";
import { runAdVariants } from "../canvas/ad-variants.js";
import { extractProductFromUrl } from "../ad/product-url.js";

// ── Tool Definitions ────────────────────────────────────────────────

export const AGENT_TOOLS = {
  generate_script: {
    description: "根据用户描述生成剧本内容。输入100字以内的剧本概要描述。",
    parameters: z.object({
      prompt: z.string().describe("剧本概要描述，100字以内"),
    }),
  },
  create_ad: {
    description:
      "根据商品/产品信息生成信息流广告脚本（黄金3秒钩子→痛点→方案→CTA），并创建脚本节点。适合带货/种草/推广场景。",
    parameters: z.object({
      product_description: z.string().describe("产品/商品描述，包含品类与核心信息"),
      selling_points: z.array(z.string()).optional().describe("卖点列表，不传则自动从商品描述提炼"),
      audience: z.string().optional().describe("目标人群，如：25-35岁职场女性"),
      duration_sec: z.number().int().optional().describe("广告时长秒数：15/30/60，默认30"),
      hook_type: z
        .enum(["pain_question", "counter_intuition", "result_first", "identity", "suspense"])
        .optional()
        .describe("钩子类型：痛点提问/反常识/效果前置/身份认同/悬念冲突"),
      cta_type: z
        .enum(["limited_offer", "buy_now", "learn_more", "follow"])
        .optional()
        .describe("CTA类型：限时优惠/立即购买/点击了解/关注账号"),
      style: z.string().optional().describe("视觉风格，默认原生素人感"),
    }),
  },
  create_ad_variants: {
    description:
      "为已有的广告脚本批量生成钩子变体（每版只换开场钩子，产品/卖点/CTA 保持一致），用于投放 A/B 测试。",
    parameters: z.object({
      hook_types: z
        .array(z.enum(["pain_question", "counter_intuition", "result_first", "identity", "suspense"]))
        .optional()
        .describe("要生成的钩子类型列表，默认自动挑 3 个与当前不同的"),
      count: z.number().int().min(1).max(4).optional().describe("变体数量（未指定 hook_types 时生效），默认 3"),
    }),
  },
  extract_product: {
    description:
      "从商品详情页链接提取名称/描述/图片等公开元数据（Open Graph / JSON-LD），用于后续 create_ad。仅支持公开页面。",
    parameters: z.object({
      url: z.string().url().describe("商品详情页 URL"),
    }),
  },
  generate_storyboard: {
    description: "根据剧本内容生成分镜表和分镜面板。",
    parameters: z.object({
      prompt: z.string().describe("分镜生成指令，100字以内"),
    }),
  },
  extract_characters: {
    description: "从剧本或故事文本中提取角色信息。",
    parameters: z.object({
      prompt: z.string().describe("角色提取指令，100字以内"),
    }),
  },
  generate_assets: {
    description: "生成角色/场景/道具的参考图。",
    parameters: z.object({
      prompt: z.string().describe("资产生成指令，100字以内"),
    }),
  },
  activate_skill: {
    description: "激活一个美术风格或故事类型技能。",
    parameters: z.object({
      skillId: z.string().describe("技能ID，如 anime, realistic, action 等"),
    }),
  },
  create_canvas_nodes: {
    description: "在画布上创建新的节点。",
    parameters: z.object({
      nodes: z.array(z.object({
        type: z.enum(["script", "character", "storyboard_cell", "shot", "image", "video", "concat"]),
        data: z.record(z.unknown()).describe("节点数据"),
      })).describe("要创建的节点列表"),
    }),
  },
  run_node: {
    description: "执行画布上的某个节点（生成图片/视频等）。",
    parameters: z.object({
      nodeId: z.string().describe("要执行的节点ID"),
    }),
  },
} as const;

// ── Zone Layout (mirrors frontend dagre-layout.ts) ──────────────────
// Seven columns left → right, one per node type. Nodes stack vertically
// inside their column with a row height exceeding the tallest node, so
// generated nodes never overlap.

const ZONE_LAYOUT: Record<string, { x: number; y: number }> = {
  script: { x: 40, y: 60 },
  character: { x: 380, y: 60 },
  storyboard_cell: { x: 720, y: 60 },
  shot: { x: 1060, y: 60 },
  image: { x: 1400, y: 60 },
  video: { x: 1740, y: 60 },
  concat: { x: 2080, y: 60 },
};

const ZONE_TITLE_HEIGHT = 36;
const ZONE_ROW_HEIGHT = 240;

/** Compute position for a new node of the given type, stacking vertically
 * inside its zone column with no overlap. */
function computeNodePosition(
  nodeType: string,
  existingCount: number,
): { x: number; y: number } {
  const base = ZONE_LAYOUT[nodeType] ?? { x: 100, y: 100 };
  return {
    x: base.x + 16,
    y: base.y + ZONE_TITLE_HEIGHT + existingCount * ZONE_ROW_HEIGHT,
  };
}

// ── Node Data Normalization ──────────────────────────────────────────

/**
 * Models occasionally ignore the `data: object` schema and pass a plain
 * string (e.g. "镜头2：…"). Storing that raw would corrupt the node —
 * downstream editors spread it into {"0":"镜","1":"头",…}. Coerce every
 * payload into a valid object, mapping the string into the field the node
 * type actually reads.
 */
export function normalizeNodeData(type: string, data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  const text = typeof data === "string" ? data.trim() : "";
  if (!text) return {};
  switch (type) {
    case "script": return { content: text, status: "idle" };
    case "storyboard_cell": return { shotBrief: text, status: "idle" };
    case "shot": return { ffDesc: text, status: "idle" };
    case "image": return { prompt: text, status: "idle" };
    case "character": return { description: text, status: "idle" };
    default: return { note: text, status: "idle" };
  }
}

// ── Canvas Context Builder ───────────────────────────────────────────

export interface CanvasContext {
  canvasId: string;
  canvasName: string;
  nodes: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
    status: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }>;
  activeSkills: string[];
}

/**
 * Latest script node's content on the canvas, so downstream tools
 * (extract_characters, generate_storyboard) operate on the ACTUAL script
 * text instead of a short instruction the model passes as `prompt`.
 */
async function getScriptContent(canvasId: string): Promise<string | null> {
  try {
    const db = getDb();
    const rows = await db
      .select({ data: canvasNodes.data })
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.type, "script")))
      .orderBy(desc(canvasNodes.createdAt))
      .limit(1);
    const content = (rows[0]?.data as Record<string, unknown> | undefined)?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** 最新一个广告脚本节点（钩子变体的默认基座）。 */
async function findLatestAdScriptNodeId(canvasId: string): Promise<string | null> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: canvasNodes.id, data: canvasNodes.data })
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.type, "script")))
      .orderBy(desc(canvasNodes.createdAt))
      .limit(10);
    const adNode = rows.find(
      (row) => (row.data as Record<string, unknown> | undefined)?.isAd === true,
    );
    return adNode?.id ?? null;
  } catch {
    return null;
  }
}

export async function buildCanvasContext(canvasId: string): Promise<CanvasContext | null> {
  try {
    const db = getDb();

    const canvasRows = await db
      .select()
      .from(canvases)
      .where(eq(canvases.id, canvasId))
      .limit(1);

    if (canvasRows.length === 0) return null;

    const nodesRows = await db
      .select()
      .from(canvasNodes)
      .where(eq(canvasNodes.canvasId, canvasId));

    const edgesRows = await db
      .select()
      .from(canvasEdges)
      .where(eq(canvasEdges.canvasId, canvasId));

    return {
      canvasId,
      canvasName: canvasRows[0]!.name,
      nodes: nodesRows.map((n) => ({
        id: n.id,
        type: n.type,
        data: n.data as Record<string, unknown>,
        status: n.status,
      })),
      edges: edgesRows.map((e) => ({
        source: e.sourceNodeId,
        target: e.targetNodeId,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
      activeSkills: [],
    };
  } catch {
    return null;
  }
}

// ── System Prompt Builder ───────────────────────────────────────────

const DECISION_SYSTEM_PROMPT = `你是一个专业的AI视频制作助手（决策层）。你可以帮助用户完成以下任务：

## 可用工具

1. **generate_script** — 根据描述生成剧本
2. **create_ad** — 根据商品/产品信息生成信息流广告脚本（黄金3秒钩子+卖点+CTA）
3. **create_ad_variants** — 为已有广告脚本批量生成钩子变体（投放 A/B）
4. **extract_product** — 从商品详情页链接提取公开元数据（先 extract_product 再 create_ad 可直接做广告）
5. **generate_storyboard** — 根据剧本生成分镜
6. **extract_characters** — 从文本提取角色
7. **generate_assets** — 生成角色/场景/道具参考图
8. **activate_skill** — 激活美术风格（anime/realistic/cinematic/comic/watercolor/oil-painting/ink-wash/flat-design/claymation/pixel-art/noir）或故事类型（action/romance/sci-fi/fantasy/mystery/comedy/horror/documentary/historical/slice-of-life/musical）
9. **create_canvas_nodes** — 在画布上创建节点
10. **run_node** — 执行画布上的节点

## 工作流程

当用户请求制作视频时，你应该按以下顺序调用工具：
1. 如果需要生成剧本 → generate_script
2. 如果需要角色 → extract_characters → generate_assets
3. 如果需要分镜 → generate_storyboard
4. 如果需要生成图片/视频 → create_canvas_nodes + run_node

## 广告创作工作流

当用户想为产品/商品/品牌制作创意广告时（关键词：广告、带货、种草、推广、投放）：
1. 调用 create_ad 生成结构化广告脚本——自动提炼卖点、默认 15 秒信息流时长、自动选择钩子策略；用户给了明确人群/时长/风格时原样传入
2. 生成后告知用户：可以点击"一键生成"跑全自动管线（分镜→角色→图片→视频→合成）
3. 用户想多版本测试时，用不同的 hook_type 再生成一版（钩子变体是投放 A/B 的刚需）

## 画布上下文

当前画布有 {nodeCount} 个节点和 {edgeCount} 条连接。
节点类型分布：{nodeTypeSummary}

## 指令

- 分析用户意图，决定需要调用哪些工具
- 每次只调用一个工具，等待结果后再决定下一步
- 用中文回复用户
- 如果用户的要求不明确，先询问澄清`;

// ── Decision Agent Runner ────────────────────────────────────────────

export interface DecisionAgentResult {
  /** Full text response from the agent */
  text: string;
  /** Tool calls made by the agent */
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Thinking/reasoning content */
  thinking?: string;
}

/**
 * Run the decision agent for a user message.
 * Streams the response and collects tool calls.
 */
export async function runDecisionAgent(
  canvasId: string,
  userMessage: string,
  onChunk: (chunk: AIStreamChunk) => void,
  modelId?: string,
  abortSignal?: AbortSignal,
): Promise<DecisionAgentResult> {
  // Build canvas context
  const ctx = await buildCanvasContext(canvasId);

  const nodeTypeSummary = ctx
    ? ctx.nodes
        .reduce(
          (acc, n) => {
            acc[n.type] = (acc[n.type] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        )
    : {};

  const systemPrompt = DECISION_SYSTEM_PROMPT
    .replace("{nodeCount}", String(ctx?.nodes.length ?? 0))
    .replace("{edgeCount}", String(ctx?.edges.length ?? 0))
    .replace(
      "{nodeTypeSummary}",
      Object.entries(nodeTypeSummary)
        .map(([t, c]) => `${t}: ${c}`)
        .join(", ") || "无节点",
    );

  let fullText = "";
  let thinking = "";
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  try {
    const stream = streamText({
      model: modelId,
      system: systemPrompt,
      prompt: userMessage,
      tools: Object.fromEntries(
        Object.entries(AGENT_TOOLS).map(([name, tool]) => [name, tool]),
      ),
      temperature: 0.7,
      maxTokens: 4096,
      abortSignal,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;
      onChunk(chunk);

      if (chunk.type === "text-delta" && chunk.text) {
        fullText += chunk.text;
      }
      if (chunk.type === "thinking-delta" && chunk.thinking) {
        thinking += chunk.thinking;
      }
      if (chunk.type === "tool-call" && chunk.toolName) {
        toolCalls.push({
          name: chunk.toolName,
          args: chunk.toolArgs ?? {},
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    onChunk({ type: "error", error: errorMessage });
    return { text: `抱歉，AI 处理时出错: ${errorMessage}`, toolCalls: [], thinking };
  }

  return { text: fullText, toolCalls, thinking: thinking || undefined };
}

// ── Execution Layer ─────────────────────────────────────────────────

export interface ToolCallOptions {
  /** Callback to broadcast canvas mutations to all connected clients */
  onCanvasMutation?: (mutation: CanvasMutation) => void;
  /** Current count of nodes by type (for computing zone positions) */
  nodeTypeCounts?: Record<string, number>;
}

/**
 * Execute a tool call from the decision agent with REAL dispatch.
 * - Text generation tools → call LLM via generateText(), create canvas nodes
 * - Asset generation → enqueue via BullMQ bridge
 * - Node execution → call node-executor.service.ts
 *
 * Returns the result to be sent back to the agent or user.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  canvasId: string,
  opts?: ToolCallOptions,
): Promise<{
  success: boolean;
  result: unknown;
  message: string;
  /** Canvas mutation produced by this tool call (if any) */
  canvasMutation?: CanvasMutation;
}> {
  const db = getDb();
  const onMutation = opts?.onCanvasMutation;
  const typeCounts = opts?.nodeTypeCounts ?? {};

  switch (toolName) {
    // ── create_canvas_nodes ──────────────────────────────────────────
    case "create_canvas_nodes": {
      try {
        const nodesArg = args.nodes as Array<{
          type: string;
          data?: Record<string, unknown>;
          position?: { x: number; y: number };
        }> | undefined;

        if (!nodesArg || nodesArg.length === 0) {
          return { success: false, result: null, message: "没有提供要创建的节点" };
        }

        const now = new Date();
        const mutationNodes: Array<{
          id: string;
          type: string;
          position: { x: number; y: number };
          data: Record<string, unknown>;
        }> = [];

        for (const n of nodesArg) {
          const nodeId = randomUUID();
          const nodeType = n.type;
          typeCounts[nodeType] = (typeCounts[nodeType] ?? 0) + 1;
          const position = n.position ?? computeNodePosition(nodeType, typeCounts[nodeType] - 1);

          const nodeData = normalizeNodeData(nodeType, n.data);

          await db.insert(canvasNodes).values({
            id: nodeId,
            canvasId,
            type: nodeType as never,
            position,
            data: nodeData,
            status: "idle",
            createdAt: now,
            updatedAt: now,
          });

          mutationNodes.push({ id: nodeId, type: nodeType, position, data: nodeData });
        }

        const mutation: CanvasMutation = {
          type: "nodes.add",
          nodes: mutationNodes,
        };
        onMutation?.(mutation);

        // Auto-wire type-dependency edges across the canvas (script→cell→shot→
        // image→video→concat) so generated nodes show up as a connected
        // pipeline, not scattered cards.
        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) {
          onMutation?.({ type: "edges.add", edges: wiredEdges });
        }

        const nodeList = mutationNodes.map((n) => `${n.type}(${n.id.slice(0, 8)}…)`).join(", ");
        return {
          success: true,
          result: { created: mutationNodes.length, nodeIds: mutationNodes.map((n) => n.id) },
          message: `已在画布上创建 ${mutationNodes.length} 个节点: ${nodeList}`,
          canvasMutation: mutation,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `创建节点失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── generate_script ──────────────────────────────────────────────
    case "generate_script": {
      try {
        const prompt = args.prompt as string;
        const scriptPrompt = `你是一位专业的编剧。请根据以下描述生成一个完整的剧本。

要求：
1. 包含标题、类型、人物简介
2. 完整的剧情概述（200-500字）
3. 分场大纲（3-5场）
4. 关键对话片段
5. 视觉风格建议

用户描述: ${prompt}

请用中文输出，格式清晰。`;

        const response = await generateText({
          system: "你是一位资深的中国影视编剧，擅长创作各类题材的剧本。你的回复专业、有创意、且符合工业标准。",
          prompt: scriptPrompt,
          temperature: 0.8,
          maxTokens: 4096,
        });

        const content = response.text;

        // Create a script node on the canvas with the generated content
        typeCounts["script"] = (typeCounts["script"] ?? 0) + 1;
        const nodeId = randomUUID();
        const position = computeNodePosition("script", typeCounts["script"] - 1);
        const now = new Date();

        await db.insert(canvasNodes).values({
          id: nodeId,
          canvasId,
          type: "script",
          position,
          data: { content, status: "idle", prompt },
          status: "idle",
          createdAt: now,
          updatedAt: now,
        });

        const mutation: CanvasMutation = {
          type: "nodes.add",
          nodes: [{ id: nodeId, type: "script", position, data: { content, status: "idle", prompt } }],
        };
        onMutation?.(mutation);

        // Wire the new script to existing storyboard/character nodes, if any.
        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) {
          onMutation?.({ type: "edges.add", edges: wiredEdges });
        }

        return {
          success: true,
          result: { nodeId, contentLength: content.length },
          message: `剧本已生成（${content.length}字），已创建脚本节点`,
          canvasMutation: mutation,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `剧本生成失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── create_ad ────────────────────────────────────────────────────
    case "create_ad": {
      try {
        const input: AdScriptInput = {
          productDescription: String(args.product_description ?? ""),
          sellingPoints: Array.isArray(args.selling_points)
            ? args.selling_points.map(String)
            : undefined,
          audience: args.audience ? String(args.audience) : undefined,
          durationSec:
            typeof args.duration_sec === "number" ? args.duration_sec : undefined,
          hookType: args.hook_type as AdHookTypeId | undefined,
          ctaType: args.cta_type as AdCtaTypeId | undefined,
          style: args.style ? String(args.style) : undefined,
        };
        if (!input.productDescription.trim()) {
          return { success: false, result: null, message: "缺少商品描述，无法生成广告脚本" };
        }

        const durationSec = input.durationSec ?? 30;
        const { system, prompt } = buildAdScriptPrompt(input);
        const response = await generateText({
          system,
          prompt,
          temperature: 0.8,
          maxTokens: 4096,
        });

        const ad = parseAdScript(response.text, durationSec);
        const content = ad ? formatAdScript(ad) : response.text.trim();
        const hook = getAdHookType(ad?.hookType ?? input.hookType);
        const cta = getAdCtaType(ad?.ctaType ?? input.ctaType);

        typeCounts["script"] = (typeCounts["script"] ?? 0) + 1;
        const nodeId = randomUUID();
        const position = computeNodePosition("script", typeCounts["script"] - 1);
        const now = new Date();
        const nodeData = {
          content,
          status: "idle",
          isAd: true,
          adBrief: {
            productDescription: input.productDescription,
            sellingPoints: ad?.sellingPoints ?? input.sellingPoints ?? [],
            audience: input.audience,
            durationSec,
            hookType: hook.id,
            ctaType: cta.id,
            style: input.style,
          },
        };

        await db.insert(canvasNodes).values({
          id: nodeId,
          canvasId,
          type: "script",
          position,
          data: nodeData,
          status: "idle",
          createdAt: now,
          updatedAt: now,
        });

        const mutation: CanvasMutation = {
          type: "nodes.add",
          nodes: [{ id: nodeId, type: "script", position, data: nodeData }],
        };
        onMutation?.(mutation);

        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) {
          onMutation?.({ type: "edges.add", edges: wiredEdges });
        }

        return {
          success: true,
          result: { nodeId, durationSec, hookType: hook.id, ctaType: cta.id },
          message: `广告脚本已生成（${durationSec} 秒 · ${hook.label}钩子 · ${cta.label}），已创建脚本节点。可以让用户点击"一键生成"跑全自动管线出片。`,
          canvasMutation: mutation,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `广告脚本生成失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── create_ad_variants ───────────────────────────────────────────
    case "create_ad_variants": {
      try {
        const nodeId = await findLatestAdScriptNodeId(canvasId);
        if (!nodeId) {
          return { success: false, result: null, message: "画布上还没有广告脚本，请先用 create_ad 生成" };
        }
        const hookTypes = Array.isArray(args.hook_types)
          ? (args.hook_types as AdHookTypeId[])
          : undefined;
        const result = await runAdVariants(canvasId, nodeId, {
          hookTypes,
          count: typeof args.count === "number" ? args.count : undefined,
        });
        const hooksLabel = result.created.map((v) => getAdHookType(v.hookType).label).join("、");
        return {
          success: true,
          result,
          message: `已生成 ${result.created.length} 个钩子变体脚本节点（${hooksLabel}），每个都可以单独跑一键生成做 A/B 测试。`,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `钩子变体生成失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── extract_product ──────────────────────────────────────────────
    case "extract_product": {
      try {
        const url = String(args.url ?? "");
        const product = await extractProductFromUrl(url);
        return {
          success: true,
          result: product,
          message: [
            `已从链接提取商品信息：`,
            `名称：${product.name}`,
            product.brand ? `品牌：${product.brand}` : null,
            product.price ? `价格：${product.price}` : null,
            product.description ? `描述：${product.description.slice(0, 200)}` : null,
            `（提取到 ${product.imageUrls.length} 张商品图，可手动下载后上传画布作参考图）`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Unknown error";
        const hint = reason.startsWith("product_url.")
          ? "该页面不可提取（需要登录/反爬拦截/无公开元数据）。请让用户直接粘贴商品名称和卖点描述。"
          : reason;
        return { success: false, result: null, message: `商品链接提取失败：${hint}` };
      }
    }

    // ── generate_storyboard ──────────────────────────────────────────
    case "generate_storyboard": {
      try {
        const prompt = (await getScriptContent(canvasId)) ?? (args.prompt as string);
        const sbPrompt = `你是一位专业的分镜师。请根据以下描述生成分镜表。

要求：
1. 将内容拆分为5-8个镜头
2. 每个镜头包含：镜头编号、景别（远景/全景/中景/近景/特写）、摄影机运动、画面描述、时长（秒）
3. 用中文输出

输入: ${prompt}

请按以下JSON格式输出（仅输出JSON，不要其他内容）：
{
  "shots": [
    { "index": 1, "shotType": "近景", "camera": "固定", "description": "...", "durationSec": 4 },
    ...
  ]
}`;

        const response = await generateText({
          system: "你是一位专业的分镜师。你只输出有效的JSON，不包含任何其他文字。",
          prompt: sbPrompt,
          temperature: 0.7,
          maxTokens: 4096,
        });

        // Try to parse JSON, fall back to text if not valid JSON
        let shots: Array<Record<string, unknown>> = [];
        try {
          const jsonMatch = response.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            shots = (parsed.shots as Array<Record<string, unknown>>) ?? [];
          }
        } catch {
          // Fallback: create a single storyboard cell with the raw text
          shots = [{ index: 1, shotType: "中景", camera: "固定", description: response.text, durationSec: 5 }];
        }

        const now = new Date();
        const mutationNodes: Array<{
          id: string;
          type: string;
          position: { x: number; y: number };
          data: Record<string, unknown>;
        }> = [];

        for (const shot of shots) {
          const nodeId = randomUUID();
          const idx = (shot.index as number) ?? shots.indexOf(shot) + 1;
          typeCounts["storyboard_cell"] = (typeCounts["storyboard_cell"] ?? 0) + 1;
          const position = computeNodePosition("storyboard_cell", typeCounts["storyboard_cell"] - 1);

          const nodeData = {
            shotBrief: shot.description ?? "",
            cameraIdx: idx,
            shotType: shot.shotType ?? "中景",
            camera: shot.camera ?? "固定",
            durationSec: shot.durationSec ?? 5,
            status: "idle",
          };

          await db.insert(canvasNodes).values({
            id: nodeId,
            canvasId,
            type: "storyboard_cell",
            position,
            data: nodeData,
            status: "idle",
            createdAt: now,
            updatedAt: now,
          });

          mutationNodes.push({ id: nodeId, type: "storyboard_cell", position, data: nodeData });
        }

        const mutation: CanvasMutation | undefined = mutationNodes.length > 0
          ? { type: "nodes.add", nodes: mutationNodes }
          : undefined;
        if (mutation) onMutation?.(mutation);

        // Wire storyboard cells to the script node and any existing shots.
        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) onMutation?.({ type: "edges.add", edges: wiredEdges });

        return {
          success: true,
          result: { shotCount: mutationNodes.length },
          message: `分镜已生成，共 ${mutationNodes.length} 个镜头`,
          ...(mutation ? { canvasMutation: mutation } : {}),
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `分镜生成失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── extract_characters ───────────────────────────────────────────
    case "extract_characters": {
      try {
        const prompt = (await getScriptContent(canvasId)) ?? (args.prompt as string);
        const charPrompt = `从以下文本中提取所有角色信息。

输入文本: ${prompt}

请按以下JSON格式输出（仅输出JSON，不要其他内容）：
{
  "characters": [
    { "name": "角色名", "description": "外貌、性格、背景等" },
    ...
  ]
}`;

        const response = await generateText({
          system: "你是一个专业的角色分析工具。你只输出有效的JSON。",
          prompt: charPrompt,
          temperature: 0.5,
          maxTokens: 4096,
        });

        let characters: Array<Record<string, unknown>> = [];
        try {
          const jsonMatch = response.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            characters = (parsed.characters as Array<Record<string, unknown>>) ?? [];
          }
        } catch {
          characters = [{ name: "主角", description: response.text.slice(0, 200) }];
        }

        const now = new Date();
        const mutationNodes: Array<{
          id: string;
          type: string;
          position: { x: number; y: number };
          data: Record<string, unknown>;
        }> = [];

        for (const char of characters) {
          const nodeId = randomUUID();
          typeCounts["character"] = (typeCounts["character"] ?? 0) + 1;
          const position = computeNodePosition("character", typeCounts["character"] - 1);

          const nodeData = {
            name: (char.name as string) ?? "未命名角色",
            description: (char.description as string) ?? "",
            status: "idle",
          };

          await db.insert(canvasNodes).values({
            id: nodeId,
            canvasId,
            type: "character",
            position,
            data: nodeData,
            status: "idle",
            createdAt: now,
            updatedAt: now,
          });

          mutationNodes.push({ id: nodeId, type: "character", position, data: nodeData });
        }

        const mutation: CanvasMutation | undefined = mutationNodes.length > 0
          ? { type: "nodes.add", nodes: mutationNodes }
          : undefined;
        if (mutation) onMutation?.(mutation);

        // Wire characters to the script node and any existing shots.
        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) onMutation?.({ type: "edges.add", edges: wiredEdges });

        return {
          success: true,
          result: { characterCount: mutationNodes.length },
          message: `已提取 ${mutationNodes.length} 个角色`,
          ...(mutation ? { canvasMutation: mutation } : {}),
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `角色提取失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── generate_assets ──────────────────────────────────────────────
    case "generate_assets": {
      try {
        const prompt = args.prompt as string;
        const defaultModel = await getDefaultModel("default", "image");
        const nodeId = randomUUID();
        typeCounts["image"] = (typeCounts["image"] ?? 0) + 1;
        const position = computeNodePosition("image", typeCounts["image"] - 1);
        const now = new Date();

        await db.insert(canvasNodes).values({
          id: nodeId,
          canvasId,
          type: "image",
          position,
          data: {
            prompt,
            modelId: defaultModel.id,
            size: "1024x1024",
            status: "idle",
          },
          status: "idle",
          createdAt: now,
          updatedAt: now,
        });

        const mutation: CanvasMutation = {
          type: "nodes.add",
          nodes: [{
            id: nodeId,
            type: "image",
            position,
            data: { prompt, modelId: defaultModel.id, size: "1024x1024", status: "running" },
          }],
        };
        onMutation?.(mutation);

        // Wire the image node to any existing shots (shot→image).
        const wiredEdges = await autoWireCanvas(canvasId);
        if (wiredEdges.length > 0) onMutation?.({ type: "edges.add", edges: wiredEdges });

        const { runNode } = await import("../canvas/node-executor.service.js");
        const result = await runNode({ canvas_id: canvasId, node_id: nodeId });

        return {
          success: true,
          result: { jobId: result.job_id, nodeId, prompt },
          message: `资产生成已提交，画布已创建图片节点`,
          canvasMutation: mutation,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `资产生成提交失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── run_node ─────────────────────────────────────────────────────
    case "run_node": {
      try {
        const nodeId = args.nodeId as string;
        // Dynamically import node executor to avoid circular deps
        const { runNode } = await import(
          "../canvas/node-executor.service.js"
        );

        const result = await runNode({
          canvas_id: canvasId,
          node_id: nodeId,
        });

        return {
          success: true,
          result: { nodeId, ...result },
          message: `节点 ${nodeId.slice(0, 8)}… 执行完成`,
        };
      } catch (err) {
        return {
          success: false,
          result: null,
          message: `节点执行失败: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
      }
    }

    // ── activate_skill ───────────────────────────────────────────────
    case "activate_skill": {
      const skillId = args.skillId as string;
      // Try to load skill from registry
      let skillInfo = "";
      try {
        const { getSkill } = await import("../skill/skill-registry.js");
        const skill = getSkill(skillId);
        if (skill) {
          skillInfo = `已加载技能「${skill.name}」(${skill.type}): ${skill.description}`;
        } else {
          skillInfo = `技能「${skillId}」已激活（提示：可用的美术风格: anime, realistic, cinematic, comic, watercolor, oil-painting, ink-wash, flat-design, claymation, pixel-art, noir；故事类型: action, romance, sci-fi, fantasy, mystery, comedy, horror, documentary, historical, slice-of-life, musical）`;
        }
      } catch {
        skillInfo = `技能「${skillId}」已激活`;
      }

      return {
        success: true,
        result: { skillId, loaded: skillInfo.includes("已加载") },
        message: skillInfo,
      };
    }

    default:
      return {
        success: false,
        result: null,
        message: `未知工具: ${toolName}`,
      };
  }
}
