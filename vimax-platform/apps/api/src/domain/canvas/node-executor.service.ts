import { randomUUID } from "node:crypto";
import type {
  ImageJobPayload,
  ImageNodeData,
  ImageSize,
  NodeRunBatchInput,
  NodeRunBatchOutput,
  NodeRunInput,
  NodeRunOutput,
  VideoJobPayload,
  CharacterNodeData,
  ShotNodeData,
} from "@vimax/contracts";
import { getImageModel, getVideoModel, getMotionPreset } from "@vimax/contracts";
import { KEY_LIGHT_POSITIONS, RIM_LIGHT_PRESETS, AMBIENT_LIGHT_OPTIONS } from "@vimax/contracts";
import { getDefaultModel, getModelById } from "../model/model.service.js";
import { and, eq } from "drizzle-orm";
import { config } from "../../config/env.js";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, canvasEdges, canvasNodes, canvases, jobEvents, jobs } from "../../infrastructure/db/schema.js";
import { getRedisQueue, jobEventChannel } from "../../infrastructure/redis/client.js";
import { enqueueImageJob, enqueueVideoJob } from "../../infrastructure/queue/producer.js";
import { buildStorageKey, getBucket } from "../../infrastructure/storage/s3.js";
import {
  buildImageCacheKey,
  collectReferenceSha256s,
  findCachedImageJob,
} from "../image/cache.service.js";
import { setNodeStatus, updateNodeDataField } from "./canvas.service.js";

// ── Main entry: run a single node ──────────────────────────────────

export async function runNode(input: NodeRunInput): Promise<NodeRunOutput> {
  const db = getDb();

  // 1. Look up the node
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, input.canvas_id),
        eq(canvasNodes.id, input.node_id),
      ),
    )
    .limit(1);

  if (!node) throw new Error("canvas.node_not_found");

  // 2. Collect upstream references from incoming edges
  const upstreamAssets = await collectUpstreamAssets(
    input.canvas_id,
    input.node_id,
  );

  // 3. Mark node as running
  await setNodeStatus(input.canvas_id, input.node_id, "running");

  // 4. Dispatch based on node type
  try {
    switch (node.type) {
      case "image":
        return await runImageNode(node, upstreamAssets);
      case "character":
        return await runCharacterNode(node, upstreamAssets);
      case "shot":
        return await runShotNode(node, upstreamAssets);
      case "video":
        return await runVideoNode(node, upstreamAssets);
      case "concat":
        return await runConcatNode(node, upstreamAssets);
      default:
        throw new Error("canvas.node_type_not_runnable");
    }
  } catch (err) {
    // Revert status on failure
    await setNodeStatus(input.canvas_id, input.node_id, "failed");
    throw err;
  }
}

// ── Batch run ──────────────────────────────────────────────────────

export async function runNodeBatch(
  input: NodeRunBatchInput,
): Promise<NodeRunBatchOutput> {
  const results: Array<{ node_id: string; job_id: string; job_type: string }> =
    [];

  for (const nodeId of input.node_ids) {
    try {
      const result = await runNode({
        canvas_id: input.canvas_id,
        node_id: nodeId,
      });
      results.push({
        node_id: result.node_id,
        job_id: result.job_id,
        job_type: result.job_type,
      });
    } catch {
      // Skip failed nodes in batch — individual errors don't block others
      results.push({
        node_id: nodeId,
        job_id: "",
        job_type: "error",
      });
    }
  }

  return { jobs: results };
}

// ── Upstream asset collection ──────────────────────────────────────

async function collectUpstreamAssets(
  canvasId: string,
  nodeId: string,
): Promise<string[]> {
  const db = getDb();

  // Find edges where this node is the target
  const incoming = await db
    .select({
      sourceNodeId: canvasEdges.sourceNodeId,
    })
    .from(canvasEdges)
    .where(
      and(
        eq(canvasEdges.canvasId, canvasId),
        eq(canvasEdges.targetNodeId, nodeId),
      ),
    );

  if (incoming.length === 0) return [];

  const upstreamIds = incoming.map((e) => e.sourceNodeId);

  const upstreamNodes = await db
    .select({
      id: canvasNodes.id,
      outputAssetId: canvasNodes.outputAssetId,
    })
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        // Collect all at once — small fan-out in practice
      ),
    );

  const nodeMap = new Map(upstreamNodes.map((n) => [n.id, n]));

  const assetIds: string[] = [];
  for (const id of upstreamIds) {
    const upstream = nodeMap.get(id);
    if (upstream?.outputAssetId) {
      assetIds.push(upstream.outputAssetId);
    }
  }

  return assetIds;
}

// ── Model resolution helpers ─────────────────────────────────────────
// Try DB-backed model first, fall back to hardcoded contract models.

async function getTenantIdForCanvas(canvasId: string): Promise<string> {
  const db = getDb();
  const [canvas] = await db
    .select({ tenantId: canvases.tenantId })
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .limit(1);
  return canvas?.tenantId ?? "default";
}

async function resolveImageModel(modelId?: string): Promise<{
  id: string; class_path: string; base_url?: string; model?: string;
  sizes?: string[]; supports_reference?: boolean; api_key?: string;
}> {
  // Try DB lookup first
  if (modelId) {
    const dbModel = await getModelById(modelId);
    if (dbModel) {
      const cfg = dbModel.config as Record<string, unknown>;
      return {
        id: dbModel.id,
        class_path: (dbModel.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string,
        base_url: (dbModel.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
        model: (dbModel.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
        sizes: cfg.sizes as string[] | undefined,
        supports_reference: cfg.supports_reference as boolean | undefined,
        api_key: dbModel.apiKey ?? undefined,
      };
    }
  }
  // Fallback to hardcoded
  if (modelId) {
    const hc = getImageModel(modelId);
    if (hc) return {
      id: hc.id, class_path: hc.class_path,
      base_url: hc.init_args?.base_url, model: hc.init_args?.model,
      sizes: hc.sizes, supports_reference: hc.supports_reference,
    };
  }
  // Ultimate default
  const def = await getDefaultModel("default", "image");
  const cfg = def.config as Record<string, unknown>;
  return {
    id: def.id, class_path: (def.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string,
    base_url: (def.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
    model: (def.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
    sizes: cfg.sizes as string[] | undefined, supports_reference: cfg.supports_reference as boolean | undefined,
    api_key: def.apiKey ?? undefined,
  };
}

async function resolveVideoModel(modelId?: string): Promise<{
  id: string; class_path?: string; base_url?: string; model?: string;
  maxDuration?: number; resolutions?: string[]; api_key?: string;
}> {
  if (modelId) {
    const dbModel = await getModelById(modelId);
    if (dbModel) {
      const cfg = dbModel.config as Record<string, unknown>;
      return {
        id: dbModel.id,
        class_path: (dbModel.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string | undefined,
        base_url: (dbModel.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
        model: (dbModel.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
        api_key: dbModel.apiKey ?? undefined,
      };
    }
  }
  if (modelId) {
    const hc = getVideoModel(modelId);
    if (hc) return {
      id: hc.id, class_path: hc.class_path,
      base_url: hc.init_args?.base_url, model: hc.init_args?.model,
    };
  }
  const def = await getDefaultModel("default", "video");
  const cfg = def.config as Record<string, unknown>;
  return {
    id: def.id, class_path: (def.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string | undefined,
    base_url: (def.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
    model: (def.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
    api_key: def.apiKey ?? undefined,
  };
}

async function runImageNode(
  node: typeof canvasNodes.$inferSelect,
  upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  const data = node.data as ImageNodeData;

  const model = await resolveImageModel(data.modelId);
  if (!model) throw new Error("input.unsupported_model");

  // Merge upstream assets with any direct reference assets
  const refAssetIds = [
    ...upstreamAssetIds,
    ...(data.referenceAssetIds ?? []),
  ];

  // Check if i2i mode is needed (implied by having references)
  const mode = refAssetIds.length > 0 ? "i2i" : "t2i";

  if (mode === "i2i" && !model.supports_reference) {
    throw new Error("input.unsupported_model");
  }

  const { sha256s } = await collectReferenceSha256s(refAssetIds);

  const cacheKey = buildImageCacheKey({
    mode,
    prompt: data.prompt,
    model_id: data.modelId,
    size: data.size as ImageSize,
    reference_sha256s: sha256s,
  });

  // Cache hit check
  const cached = await findCachedImageJob(cacheKey);
  if (cached?.outputAssetId) {
    await setNodeStatus(node.canvasId, node.id, "done", cached.outputAssetId);
    return {
      job_id: cached.id,
      node_id: node.id,
      job_type: cached.jobType,
      queue_name: cached.queueName,
    };
  }

  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const jobId = randomUUID();
  const jobType = mode === "t2i" ? "image.t2i" : "image.i2i";
  const queueName = "q.image.std";

  // Store canvas context in input_snapshot so the completion handler
  // can update the node status and propagate dirty flags.
  const inputSnapshot = {
    mode,
    prompt: data.prompt,
    model_id: data.modelId,
    size: data.size,
    reference_asset_ids: refAssetIds,
    // Canvas context — read by job-event.service on completion
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  const payload: ImageJobPayload = {
    job_id: jobId,
    job_type: jobType,
    model_id: data.modelId,
    credential: {
      class_path: model.class_path,
      api_key: apiKey,
      base_url: model.base_url,
      model: model.model,
    },
    input: {
      prompt: data.prompt,
      size: data.size as ImageJobPayload["input"]["size"],
      reference_storage_keys: [], // resolved by cache service
    },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: cacheKey,
    timeout_ms: 120_000,
  };

  const db = getDb();
  await db.insert(jobs).values({
    id: jobId,
    jobType,
    queueName,
    bullmqJobId: jobId,
    inputSnapshot,
    cacheKey,
    status: "queued",
    progress: 0,
  });

  await db.insert(jobEvents).values({
    jobId,
    eventType: "queued",
    payload: { message: "Job queued via canvas node", node_id: node.id },
  });

  await enqueueImageJob(payload);

  return {
    job_id: jobId,
    node_id: node.id,
    job_type: jobType,
    queue_name: queueName,
  };
}

// ── Character node executor (MVP: generates front/side/back portraits) ──

async function runCharacterNode(
  node: typeof canvasNodes.$inferSelect,
  _upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  // For MVP, character node generates a portrait using the character
  // description as the prompt. This reuses the image generation pipeline.
  const data = node.data as {
    name?: string;
    description?: string;
    frontAssetId?: string;
  };

  const name = data.name ?? "character";
  const desc = data.description ?? "";
  const prompt = [
    "Character design sheet, full body front view, clean reference",
    name ? `Name: ${name}.` : "",
    desc ? desc : "",
    "white background, professional character reference, high quality, sharp focus",
  ]
    .filter(Boolean)
    .join(", ");

  const tenantId = await getTenantIdForCanvas(node.canvasId);
  const model = await resolveImageModel(undefined); // default image model
  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const jobId = randomUUID();
  const jobType = "character.portrait.front" as const;
  const queueName = "q.image.std";

  const inputSnapshot = {
    mode: "t2i",
    prompt,
    model_id: model.id,
    size: "1024x1024",
    character_name: name,
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  const payload: ImageJobPayload = {
    job_id: jobId,
    job_type: jobType,
    model_id: model.id,
    credential: {
      class_path: model.class_path,
      api_key: apiKey,
      base_url: model.base_url,
      model: model.model,
    },
    input: {
      prompt,
      size: "1024x1024",
    },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: `canvas:character:${jobId}`,
    timeout_ms: 120_000,
  };

  const db = getDb();
  await db.insert(jobs).values({
    id: jobId,
    jobType,
    queueName,
    bullmqJobId: jobId,
    inputSnapshot,
    cacheKey: payload.cache_key,
    status: "queued",
  });

  await db.insert(jobEvents).values({
    jobId,
    eventType: "queued",
    payload: { message: "Character portrait queued", node_id: node.id },
  });

  await enqueueImageJob(payload);

  return {
    job_id: jobId,
    node_id: node.id,
    job_type: jobType,
    queue_name: queueName,
  };
}

// ── Shot node executor (MVP: generates first frame) ────────────────

async function runShotNode(
  node: typeof canvasNodes.$inferSelect,
  upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  const data = node.data as ShotNodeData;

  const motion = data.motionDesc ?? "";
  const ffDesc = data.ffDesc ?? "cinematic shot";

  // Build lighting prompt part
  const lightingParts: string[] = [];
  if (data.keyLightPosition) {
    const kl = KEY_LIGHT_POSITIONS.find((p) => p.id === data.keyLightPosition);
    if (kl) lightingParts.push(`Key light: ${kl.label} (${kl.id})`);
  }
  if (data.keyLightIntensity != null) lightingParts.push(`intensity ${data.keyLightIntensity}%`);
  if (data.rimLight && data.rimLight !== "none") {
    const rl = RIM_LIGHT_PRESETS.find((p) => p.id === data.rimLight);
    if (rl) lightingParts.push(`Rim light: ${rl.label}`);
  }
  if (data.ambientLight) {
    const al = AMBIENT_LIGHT_OPTIONS.find((o) => o.id === data.ambientLight);
    if (al) lightingParts.push(`Ambient: ${al.label}`);
  }
  const lightingStr = lightingParts.length > 0 ? `. Lighting: ${lightingParts.join(", ")}` : "";

  // Build focus/DOF prompt part
  const focusParts: string[] = [];
  if (data.focusPoint) focusParts.push(`Focus point at (${data.focusPoint.x.toFixed(2)}, ${data.focusPoint.y.toFixed(2)})`);
  if (data.bokehStrength && data.bokehStrength > 0) focusParts.push(`bokeh strength ${data.bokehStrength}, shallow depth of field`);
  const focusStr = focusParts.length > 0 ? `. ${focusParts.join(", ")}` : "";

  const prompt = [
    "Cinematic frame, widescreen 16:9, high production value",
    `Shot description: ${ffDesc}.`,
    motion ? `Camera movement: ${motion}.` : "",
    lightingStr,
    focusStr,
    "professional cinematography, film grade, 4K, sharp focus",
  ]
    .filter(Boolean)
    .join(" ");

  const model = await resolveImageModel(undefined); // default image model
  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const jobId = randomUUID();
  const jobType = "shot.first_frame" as const;
  const queueName = "q.image.refine";

  const inputSnapshot = {
    mode: upstreamAssetIds.length > 0 ? "i2i" : "t2i",
    prompt,
    model_id: model.id,
    size: "1600x900",
    reference_asset_ids: upstreamAssetIds,
    ff_desc: data.ffDesc,
    lf_desc: data.lfDesc,
    motion_desc: data.motionDesc,
    variation_type: data.variationType,
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  const payload: ImageJobPayload = {
    job_id: jobId,
    job_type: jobType as ImageJobPayload["job_type"],
    model_id: model.id,
    credential: {
      class_path: model.class_path,
      api_key: apiKey,
      base_url: model.base_url,
      model: model.model,
    },
    input: {
      prompt,
      size: "1600x900",
      reference_storage_keys: [],
    },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: `canvas:shot:${jobId}`,
    timeout_ms: 120_000,
  };

  const db = getDb();
  await db.insert(jobs).values({
    id: jobId,
    jobType,
    queueName,
    bullmqJobId: jobId,
    inputSnapshot,
    cacheKey: payload.cache_key,
    status: "queued",
  });

  await db.insert(jobEvents).values({
    jobId,
    eventType: "queued",
    payload: { message: "Shot frame queued", node_id: node.id },
  });

  await enqueueImageJob(payload);

  return {
    job_id: jobId,
    node_id: node.id,
    job_type: jobType,
    queue_name: queueName,
  };
}

// ── Video node executor (MVP: stub — video generation not yet implemented) ──

async function runVideoNode(
  node: typeof canvasNodes.$inferSelect,
  upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  if (upstreamAssetIds.length === 0) {
    throw new Error("canvas.video_needs_upstream_frames");
  }

  const data = node.data as {
    motionPreset?: string;
    durationSec?: number;
    modelId?: string;
  };

  // Resolve upstream asset storage keys
  const db = getDb();
  const upstreamAssets = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(
      upstreamAssetIds.length === 1
        ? eq(assets.id, upstreamAssetIds[0])
        : undefined as unknown as ReturnType<typeof eq>,
    );

  // Simpler: query one by one
  const storageKeys: string[] = [];
  for (const assetId of upstreamAssetIds.slice(0, 2)) {
    const [a] = await db
      .select({ storageKey: assets.storageKey })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (a) storageKeys.push(a.storageKey);
  }

  // Resolve motion preset label
  const preset = getMotionPreset(data.motionPreset ?? "zoom_in");
  const motionDesc = preset ? `${preset.label}: ${preset.description}` : (data.motionPreset ?? "zoom in");
  const prompt = `Cinematic video, ${motionDesc}, smooth motion, high quality`;

  // Resolve video model
  const videoModel = await resolveVideoModel(data.modelId);
  const apiKey = videoModel?.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const jobId = randomUUID();
  const jobType = "shot.video" as const;
  const queueName = "q.video.std";

  const inputSnapshot = {
    first_frame_asset_id: upstreamAssetIds[0],
    last_frame_asset_id: upstreamAssetIds[1] ?? upstreamAssetIds[0],
    motion_preset: data.motionPreset ?? "zoom_in",
    duration_sec: data.durationSec ?? 4,
    model_id: data.modelId ?? "doubao-seedance-1-0-lite",
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  const cacheKey = `canvas:video:${jobId}`;

  await db.insert(jobs).values({
    id: jobId,
    jobType,
    queueName,
    bullmqJobId: jobId,
    inputSnapshot,
    cacheKey,
    status: "queued",
  });

  await db.insert(jobEvents).values({
    jobId,
    eventType: "queued",
    payload: { message: "Video generation queued", node_id: node.id },
  });

  // Enqueue via BullMQ video queue
  const videoPayload: VideoJobPayload = {
    job_id: jobId,
    job_type: jobType,
    model_id: data.modelId ?? "doubao-seedance-1-0-lite",
    credential: {
      class_path: videoModel?.class_path ?? "tools.VideoGeneratorDoubaoSeedanceYunwuAPI",
      api_key: apiKey,
      base_url: videoModel?.base_url ?? "https://yunwu.ai/volc/v1",
      model: videoModel?.model ?? "doubao-seedance-1-0-lite-t2v-250428",
    },
    input: {
      prompt,
      first_frame_storage_key: storageKeys[0],
      last_frame_storage_key: storageKeys[1],
      duration_sec: data.durationSec ?? 5,
      resolution: "720p",
    },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: cacheKey,
    timeout_ms: 300_000,
  };

  await enqueueVideoJob(videoPayload);

  return {
    job_id: jobId,
    node_id: node.id,
    job_type: jobType,
    queue_name: queueName,
  };
}

// ── Concat node executor ───────────────────────────────────────────

async function runConcatNode(
  node: typeof canvasNodes.$inferSelect,
  upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  if (upstreamAssetIds.length < 2) {
    throw new Error("canvas.concat_needs_upstream_videos");
  }

  const db = getDb();
  const storageKeys: string[] = [];
  for (const assetId of upstreamAssetIds) {
    const [a] = await db
      .select({ storageKey: assets.storageKey })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (a) storageKeys.push(a.storageKey);
  }

  if (storageKeys.length < 2) {
    throw new Error("canvas.concat_needs_upstream_videos");
  }

  const jobId = randomUUID();
  const jobType = "concat.videos";
  const queueName = "q.concat.std";
  const cacheKey = `canvas:concat:${jobId}`;

  const inputSnapshot = {
    upstream_asset_ids: upstreamAssetIds,
    storage_key_count: storageKeys.length,
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  await db.insert(jobs).values({
    id: jobId,
    jobType,
    queueName,
    bullmqJobId: jobId,
    inputSnapshot,
    cacheKey,
    status: "queued",
  });

  await db.insert(jobEvents).values({
    jobId,
    eventType: "queued",
    payload: { message: "Concat job queued", node_id: node.id, clip_count: storageKeys.length },
  });

  // Push directly to Redis (concat uses simple queue, no BullMQ needed)
  const redis = getRedisQueue();
  const CONCAT_KEY = "vimax:queue:q.concat.std";
  await redis.lpush(
    CONCAT_KEY,
    JSON.stringify({
      job_id: jobId,
      job_type: jobType,
      input: { storage_keys: storageKeys },
      callback: {
        event_channel: jobEventChannel(jobId),
        upload_bucket: getBucket(),
        upload_prefix: buildStorageKey("generated", jobId),
      },
      cache_key: cacheKey,
      timeout_ms: 120_000,
    }),
  );

  return {
    job_id: jobId,
    node_id: node.id,
    job_type: jobType,
    queue_name: queueName,
  };
}

// ── Character View executor (三视图) ───────────────────────────────

export async function runCharacterView(
  canvasId: string,
  nodeId: string,
  view: "front" | "side" | "back",
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node) throw new Error("canvas.node_not_found");

  const data = node.data as CharacterNodeData;
  const model = await resolveImageModel(undefined);
  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const refAssetIds: string[] = [];
  let prompt: string;
  let jobType: string;

  if (view === "front") {
    prompt = [
      "Character design sheet, full body front view, clean reference",
      data.name ? `Name: ${data.name}.` : "",
      data.description ?? "",
      "white background, professional character reference, high quality, sharp focus",
    ].filter(Boolean).join(", ");
    jobType = "character.portrait.front";
  } else {
    if (!data.frontAssetId) throw new Error("canvas.character_needs_front_view");
    refAssetIds.push(data.frontAssetId);
    const viewLabel = view === "side" ? "side view" : "back view";
    prompt = [
      `Character design sheet, full body ${viewLabel}, clean reference`,
      data.name ? `Name: ${data.name}.` : "",
      data.description ?? "",
      `Based on the front-view reference image, ${viewLabel} perspective`,
      "white background, professional character reference, high quality, sharp focus",
    ].filter(Boolean).join(", ");
    jobType = view === "side" ? "character.portrait.side" : "character.portrait.back";
  }

  await collectReferenceSha256s(refAssetIds);
  const jobId = randomUUID();
  const queueName = "q.image.refine";

  const inputSnapshot = {
    mode: refAssetIds.length > 0 ? "i2i" : "t2i",
    prompt,
    model_id: model.id,
    size: "1024x1024",
    reference_asset_ids: refAssetIds,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
    _character_view: view,
  };

  const payload: ImageJobPayload = {
    job_id: jobId,
    job_type: jobType as ImageJobPayload["job_type"],
    model_id: model.id,
    credential: {
      class_path: model.class_path,
      api_key: apiKey,
      base_url: model.base_url,
      model: model.model,
    },
    input: { prompt, size: "1024x1024", reference_storage_keys: [] },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: `canvas:char-${view}:${jobId}`,
    timeout_ms: 120_000,
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: payload.cache_key, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: `Character ${view} view queued`, node_id: nodeId, view },
  });
  await enqueueImageJob(payload);
  await setNodeStatus(canvasId, nodeId, "running");

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Script-to-Storyboard executor (剧本转分镜) ─────────────────────

export async function runScript2Storyboard(
  canvasId: string,
  nodeId: string,
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "script") throw new Error("canvas.node_not_found");

  const data = node.data as { content?: string };
  if (!data.content?.trim()) throw new Error("canvas.script_empty");

  const defaultModel = await getDefaultModel("default", "image");
  const apiKey = defaultModel.apiKey ?? config.arkApiKey();
  const jobId = randomUUID();
  const jobType = "pipeline.script2storyboard";
  const queueName = "q.pipeline.full";

  const inputSnapshot = {
    content: data.content,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:s2s:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Script-to-storyboard queued", node_id: nodeId },
  });

  const redis = getRedisQueue();
  await redis.lpush(
    "vimax:queue:q.pipeline.full",
    JSON.stringify({
      job_id: jobId,
      job_type: jobType,
      credential: { class_path: "agents.StoryboardArtist", api_key: apiKey ?? "" },
      input: { content: data.content },
      callback: {
        event_channel: jobEventChannel(jobId),
        upload_bucket: getBucket(),
        upload_prefix: buildStorageKey("pipeline", jobId),
      },
      cache_key: `canvas:s2s:${jobId}`,
      timeout_ms: 120_000,
    }),
  );

  await setNodeStatus(canvasId, nodeId, "running");

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Multi-Camera Grid executor (多机位宫格) ─────────────────────────

export async function runMultiCameraGrid(
  canvasId: string,
  nodeId: string,
  gridSize: "3x3" | "5x5",
): Promise<{ jobs: Array<{ node_id: string; job_id: string; job_type: string }> }> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "shot") throw new Error("canvas.node_not_found");

  const data = node.data as ShotNodeData;
  const count = gridSize === "3x3" ? 9 : 25;
  const cols = gridSize === "3x3" ? 3 : 5;
  const model = await resolveImageModel(undefined);
  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const upstreamAssetIds = await collectUpstreamAssets(canvasId, nodeId);
  const results: Array<{ node_id: string; job_id: string; job_type: string }> = [];

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const angleLabel = `camera position row${row + 1} col${col + 1}`;

    const prompt = [
      "Cinematic frame, widescreen 16:9, high production value",
      `Shot description: ${data.ffDesc ?? "cinematic shot"}.`,
      `Multi-camera ${angleLabel}, ${gridSize} grid, variation ${data.variationType ?? "medium"}`,
      "professional cinematography, film grade, 4K",
    ].filter(Boolean).join(" ");

    const imageNodeId = randomUUID();
    await db.insert(canvasNodes).values({
      id: imageNodeId,
      canvasId,
      type: "image",
      position: { x: (node.position as { x: number; y: number }).x + 300 + col * 240, y: (node.position as { x: number; y: number }).y + row * 140 },
      data: { prompt, modelId: model.id, size: "1600x900", status: "idle", _parentShotNodeId: nodeId, _gridIndex: i },
      status: "idle",
    });
    await db.insert(canvasEdges).values({
      id: randomUUID(),
      canvasId,
      sourceNodeId: nodeId,
      targetNodeId: imageNodeId,
      sourceHandle: "multi_camera",
      targetHandle: "reference",
    });

    const jobId = randomUUID();
    const queueName = "q.image.refine";
    const inputSnapshot = {
      mode: upstreamAssetIds.length > 0 ? "i2i" : "t2i",
      prompt, model_id: model.id, size: "1600x900",
      reference_asset_ids: upstreamAssetIds,
      _canvas: { canvas_id: canvasId, node_id: imageNodeId },
    };

    const payload: ImageJobPayload = {
      job_id: jobId,
      job_type: "shot.first_frame" as ImageJobPayload["job_type"],
      model_id: model.id,
      credential: {
        class_path: model.class_path, api_key: apiKey,
        base_url: model.base_url, model: model.model,
      },
      input: { prompt, size: "1600x900", reference_storage_keys: [] },
      callback: {
        event_channel: jobEventChannel(jobId),
        upload_bucket: getBucket(),
        upload_prefix: buildStorageKey("generated", jobId),
      },
      cache_key: `canvas:grid:${jobId}`,
      timeout_ms: 120_000,
    };

    await db.insert(jobs).values({
      id: jobId, jobType: "shot.multi_camera_grid", queueName, bullmqJobId: jobId,
      inputSnapshot, cacheKey: payload.cache_key, status: "queued",
    });
    await db.insert(jobEvents).values({
      jobId, eventType: "queued",
      payload: { message: `Grid camera ${i + 1}/${count} queued`, node_id: imageNodeId },
    });
    await enqueueImageJob(payload);
    results.push({ node_id: imageNodeId, job_id: jobId, job_type: "shot.multi_camera_grid" });
  }

  return { jobs: results };
}

// ── Motion Prediction executor (画面推演) ───────────────────────────

export async function runMotionPrediction(
  canvasId: string,
  nodeId: string,
  direction: "forward" | "backward",
  seconds: number,
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || !node.outputAssetId) throw new Error("canvas.node_needs_output");

  // Resolve video model first to get its api_key
  const videoModel = await resolveVideoModel(undefined);
  const apiKey = videoModel?.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const videoNodeId = randomUUID();
  const dirLabel = direction === "forward" ? `${seconds}秒后` : `${seconds}秒前`;
  await db.insert(canvasNodes).values({
    id: videoNodeId, canvasId, type: "video",
    position: { x: (node.position as { x: number; y: number }).x + 300, y: (node.position as { x: number; y: number }).y },
    data: {
      motionPreset: "static", durationSec: seconds, modelId: "doubao-seedance-1-0-lite",
      status: "idle", _predictionSource: nodeId, _predictionDirection: direction,
    },
    status: "idle",
  });
  await db.insert(canvasEdges).values({
    id: randomUUID(), canvasId,
    sourceNodeId: nodeId, targetNodeId: videoNodeId,
    sourceHandle: "output", targetHandle: "input",
  });

  const [sourceAsset] = await db
    .select({ storageKey: assets.storageKey })
    .from(assets).where(eq(assets.id, node.outputAssetId)).limit(1);

  const prompt = `Predict what happens ${dirLabel} this scene, smooth temporal transition, cinematic quality`;
  const jobId = randomUUID();
  const jobType = "image.predict_motion";
  const queueName = "q.video.std";

  const inputSnapshot = {
    first_frame_asset_id: node.outputAssetId,
    motion_direction: direction, seconds,
    _canvas: { canvas_id: canvasId, node_id: videoNodeId },
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:predict:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: `Motion prediction (${dirLabel}) queued`, node_id: videoNodeId },
  });

  await enqueueVideoJob({
    job_id: jobId, job_type: "shot.video", model_id: "doubao-seedance-1-0-lite",
    credential: {
      class_path: videoModel?.class_path ?? "tools.VideoGeneratorDoubaoSeedanceYunwuAPI",
      api_key: apiKey, base_url: videoModel?.base_url,
    },
    input: { prompt, first_frame_storage_key: sourceAsset?.storageKey, duration_sec: seconds, resolution: "720p" },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(), upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: `canvas:predict:${jobId}`, timeout_ms: 300_000,
  });

  return { job_id: jobId, node_id: videoNodeId, job_type: jobType, queue_name: queueName };
}

// ── Grid Split executor (宫格切分) ─────────────────────────────────

export async function runGridSplit(
  canvasId: string,
  nodeId: string,
  gridSize: "3x3" | "5x5",
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || !node.outputAssetId) throw new Error("canvas.node_needs_output");

  const jobId = randomUUID();
  const jobType = "image.split_grid";
  const queueName = "q.image.std";

  const inputSnapshot = {
    source_asset_id: node.outputAssetId, grid_size: gridSize,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:split:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: `Grid split (${gridSize}) queued`, node_id: nodeId },
  });

  const [sourceAsset] = await db
    .select({ storageKey: assets.storageKey })
    .from(assets).where(eq(assets.id, node.outputAssetId)).limit(1);

  const redis = getRedisQueue();
  await redis.lpush("vimax:queue:q.image.std", JSON.stringify({
    job_id: jobId, job_type: jobType,
    input: { source_storage_key: sourceAsset?.storageKey, grid_size: gridSize, split: true },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(), upload_prefix: buildStorageKey("split", jobId),
    },
    cache_key: `canvas:split:${jobId}`, timeout_ms: 60_000,
  }));

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Story Push 4-Grid executor (剧情推演) ───────────────────────────

export async function runStoryPush(
  canvasId: string,
  nodeId: string,
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "shot") throw new Error("canvas.node_not_found");

  const data = node.data as ShotNodeData;
  const defaultModel = await getDefaultModel("default", "image");
  const apiKey = defaultModel.apiKey ?? config.arkApiKey();
  const jobId = randomUUID();
  const jobType = "pipeline.story_push";
  const queueName = "q.pipeline.full";

  const inputSnapshot = {
    ff_desc: data.ffDesc, lf_desc: data.lfDesc, motion_desc: data.motionDesc,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:push:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Story push 4-grid queued", node_id: nodeId },
  });

  const redis = getRedisQueue();
  await redis.lpush("vimax:queue:q.pipeline.full", JSON.stringify({
    job_id: jobId, job_type: jobType,
    credential: { class_path: "agents.StoryboardArtist", api_key: apiKey ?? "" },
    input: { content: `Predict next 4 frames: ${(data.ffDesc ?? "")}. Motion: ${(data.motionDesc ?? "")}` },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(), upload_prefix: buildStorageKey("pipeline", jobId),
    },
    cache_key: `canvas:push:${jobId}`, timeout_ms: 120_000,
  }));

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Audio Generation executor (音频生成 MVP) ────────────────────────

export async function runAudioGeneration(
  canvasId: string,
  nodeId: string,
): Promise<NodeRunOutput> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "shot") throw new Error("canvas.node_not_found");

  const data = node.data as ShotNodeData;
  if (!data.audioDesc?.trim()) throw new Error("canvas.audio_desc_empty");

  const jobId = randomUUID();
  const jobType = "audio.generate";
  const queueName = "q.audio.std";

  const inputSnapshot = {
    audio_desc: data.audioDesc,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
  };

  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:audio:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Audio generation queued", node_id: nodeId },
  });

  const redis = getRedisQueue();
  await redis.lpush("vimax:queue:q.audio.std", JSON.stringify({
    job_id: jobId, job_type: jobType,
    input: { prompt: data.audioDesc },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(), upload_prefix: buildStorageKey("audio", jobId),
    },
    cache_key: `canvas:audio:${jobId}`, timeout_ms: 60_000,
  }));

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}
