// ── Agent Decision Layer ─────────────────────────────────────────────
// Adapted from Toonflow's productionAgent/index.ts runDecisionAI()
// Routes user intent to appropriate sub-agents and tools.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { streamText, generateText, type AIStreamChunk } from "./ai-service.js";
import { getDb } from "../../infrastructure/db/client.js";
import { canvases, canvasNodes, canvasEdges } from "../../infrastructure/db/schema.js";
import type { CanvasMutation } from "@vimax/contracts";
import { getDefaultModel } from "../model/model.service.js";
import { config } from "../../config/env.js";

// ── Tool Definitions ────────────────────────────────────────────────

export const AGENT_TOOLS = {
  generate_script: {
    description: "根据用户描述生成剧本内容。输入100字以内的剧本概要描述。",
    parameters: z.object({
      prompt: z.string().describe("剧本概要描述，100字以内"),
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

// ── Zone Layout (mirrors frontend InfiniteCanvas.tsx) ───────────────

const ZONE_LAYOUT: Record<string, { x: number; y: number }> = {
  script: { x: 40, y: 60 },
  character: { x: 40, y: 300 },
  storyboard_cell: { x: 360, y: 60 },
  shot: { x: 680, y: 160 },
  image: { x: 1020, y: 60 },
  video: { x: 1360, y: 160 },
  concat: { x: 1020, y: 420 },
};

const ZONE_OFFSET = 280;

/** Compute position for a new node of the given type, stacking within its zone */
function computeNodePosition(
  nodeType: string,
  existingCount: number,
): { x: number; y: number } {
  const base = ZONE_LAYOUT[nodeType] ?? { x: 100, y: 100 };
  // Stack same-type nodes vertically, 3 per row then wrap
  const col = Math.floor(existingCount / 3);
  const row = existingCount % 3;
  return {
    x: base.x + col * 20,
    y: base.y + row * ZONE_OFFSET,
  };
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
2. **generate_storyboard** — 根据剧本生成分镜
3. **extract_characters** — 从文本提取角色
4. **generate_assets** — 生成角色/场景/道具参考图
5. **activate_skill** — 激活美术风格（anime/realistic/cinematic/comic/watercolor/oil-painting/ink-wash/flat-design/claymation/pixel-art/noir）或故事类型（action/romance/sci-fi/fantasy/mystery/comedy/horror/documentary/historical/slice-of-life/musical）
6. **create_canvas_nodes** — 在画布上创建节点
7. **run_node** — 执行画布上的节点

## 工作流程

当用户请求制作视频时，你应该按以下顺序调用工具：
1. 如果需要生成剧本 → generate_script
2. 如果需要角色 → extract_characters → generate_assets
3. 如果需要分镜 → generate_storyboard
4. 如果需要生成图片/视频 → create_canvas_nodes + run_node

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
    });

    for await (const chunk of stream) {
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

          const nodeData = (n.data ?? {}) as Record<string, unknown>;

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

    // ── generate_storyboard ──────────────────────────────────────────
    case "generate_storyboard": {
      try {
        const prompt = args.prompt as string;
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
        const prompt = args.prompt as string;
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
        // Dynamically import the queue producer to avoid circular deps
        const { enqueueImageJob } = await import(
          "../../infrastructure/queue/producer.js"
        );
        const prompt = args.prompt as string;

        // Resolve model config from DB (user-configured API key), fallback to env
        const defaultModel = await getDefaultModel("default", "image");
        const modelCfg = defaultModel.config as Record<string, unknown>;
        const classPath = (defaultModel.classPath ?? modelCfg.class_path ?? (modelCfg.init_args as Record<string,string>)?.class_path) as string;
        const baseUrl = (defaultModel.baseUrl ?? modelCfg.base_url ?? (modelCfg.init_args as Record<string,string>)?.base_url) as string | undefined;
        const model = (defaultModel.vendorModelId ?? (modelCfg.init_args as Record<string,string>)?.model) as string | undefined;
        const apiKey = defaultModel.apiKey ?? config.arkApiKey();
        if (!apiKey) throw new Error("No API key configured for image generation");

        // Enqueue an image generation job for the asset
        const jobId = randomUUID();
        await enqueueImageJob({
          job_id: jobId,
          job_type: "image.t2i",
          model_id: defaultModel.id,
          credential: {
            class_path: classPath,
            api_key: apiKey,
            base_url: baseUrl,
            model: model,
          },
          input: {
            prompt,
            size: "1024x1024" as const,
          },
          callback: {
            event_channel: `events:job:${jobId}`,
            upload_bucket: "vimax-assets",
            upload_prefix: `agent/${jobId}`,
          },
          cache_key: `agent_asset_${jobId}`,
          timeout_ms: 120000,
        });

        return {
          success: true,
          result: { jobId, prompt },
          message: `资产生成已提交（任务ID: ${jobId.slice(0, 8)}…）`,
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
