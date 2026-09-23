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
  StoryboardCellNodeData,
} from "@vimax/contracts";
import { composeImagePrompt, getImageModel, getMotionPreset, getVideoModel, getVideoAspectRatio, getVideoStylePreset } from "@vimax/contracts";
import { KEY_LIGHT_POSITIONS, RIM_LIGHT_PRESETS, AMBIENT_LIGHT_OPTIONS } from "@vimax/contracts";
import { getDefaultModel, getModelById } from "../model/model.service.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "../../config/env.js";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, canvasEdges, canvasNodes, canvases, jobEvents, jobs } from "../../infrastructure/db/schema.js";
import { getRedisQueue, jobEventChannel } from "../../infrastructure/redis/client.js";
import {
  enqueueAudioJob,
  enqueueConcatJob,
  enqueueImageJob,
  enqueuePipelineJob,
  enqueueVideoJob,
} from "../../infrastructure/queue/producer.js";
import { buildStorageKey, getBucket } from "../../infrastructure/storage/s3.js";
import {
  buildImageCacheKey,
  collectReferenceSha256s,
  findCachedJob,
} from "../image/cache.service.js";
import { setNodeStatus, updateNodeDataField, markDownstreamDirty } from "./canvas.service.js";
import {
  normalizeCharacterAssets,
  pickByHandle,
  readyDirtyChildrenOf,
  readyDirtyNodes,
  resolveShotMode,
  resolveUpstreamInputs,
  type EdgeLike,
  type NodeRuntimeLike,
  type UpstreamInput,
} from "./canvas-graph.js";
import { generateText } from "../agent/ai-service.js";
import {
  STORYBOARD_DECOMPOSE_SYSTEM_PROMPT,
  buildDecomposeUserPrompt,
  buildShotNodeData,
  parseDecomposition,
} from "./shot-decompose.js";
import { buildConcatCacheKey, buildVideoCacheKey } from "./cache-keys.js";
import { broadcastNodeStatus } from "./node-status.js";
import { MAX_VARIANTS } from "./variations.js";
import {
  buildStoryboardUserRequirement,
  mapCanvasCharactersToPayload,
} from "./storyboard-input.js";

// ── Cache-hit fast path ────────────────────────────────────────────
//
// A cached re-run never enqueues a job, so the job-event stream that
// normally drives a node's running → done transition stays silent. Mark
// the node done in the DB and broadcast the transition ourselves, otherwise
// clients stay stuck on "running" relying on a stale SSE replay of the
// original job.
// ── In-flight dedup guard ───────────────────────────────────────────
// One node runs at most one job at a time. A second enqueue for the same
// node while a job is queued/running would double-bill the vendor: both
// jobs generate for real, and neither can hit the content cache because
// the cache record is only written on success. Variant galleries are
// exempt — they intentionally enqueue several jobs for one node.
async function assertNoInFlightNodeJob(
  canvasId: string,
  nodeId: string,
): Promise<void> {
  const db = getDb();
  const [inFlight] = await db
    .select({ id: jobs.id, jobType: jobs.jobType })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        sql`input_snapshot->'_variant' IS NULL`,
        sql`input_snapshot->'_canvas'->>'canvas_id' = ${canvasId}`,
        sql`input_snapshot->'_canvas'->>'node_id' = ${nodeId}`,
      ),
    )
    .limit(1);
  if (inFlight) {
    throw new Error(`canvas.job_in_flight:${inFlight.jobType}`);
  }
}

async function applyCacheHit(
  node: { canvasId: string; id: string },
  cached: NonNullable<Awaited<ReturnType<typeof findCachedJob>>>,
): Promise<NodeRunOutput> {
  await setNodeStatus(node.canvasId, node.id, "done", cached.outputAssetId);
  broadcastNodeStatus(node.canvasId, node.id, "done", cached.outputAssetId);
  return {
    job_id: cached.id,
    node_id: node.id,
    job_type: cached.jobType,
    queue_name: cached.queueName,
  };
}

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

  // 2. Collect upstream references from incoming edges (handle-aware).
  const upstream = await collectUpstreamAssets(input.canvas_id, input.node_id);
  const upstreamAssetIds = upstream.map((input2) => input2.assetId);

  // 3. Mark node as running
  await setNodeStatus(input.canvas_id, input.node_id, "running");
  broadcastNodeStatus(input.canvas_id, input.node_id, "running");

  // 4. Dispatch based on node type
  try {
    switch (node.type) {
      case "image":
        return await runImageNode(node, upstreamAssetIds);
      case "character":
        return await runCharacterNode(node, upstreamAssetIds);
      case "shot":
        return await runShotNode(node, upstreamAssetIds);
      case "audio":
        return runAudioNode(node, upstreamAssetIds);
      case "video":
        return await runVideoNode(node, upstream);
      case "concat":
        return await runConcatNode(node, upstreamAssetIds);
      default:
        throw new Error("canvas.node_type_not_runnable");
    }
  } catch (err) {
    // Revert status on failure
    await setNodeStatus(input.canvas_id, input.node_id, "failed");
    broadcastNodeStatus(input.canvas_id, input.node_id, "failed");
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

// ── Subgraph re-run ────────────────────────────────────────────────

/** Load a canvas's node runtime state + edges for readiness checks. */
async function loadCanvasRuntime(canvasId: string): Promise<{
  nodes: Map<string, NodeRuntimeLike>;
  edges: EdgeLike[];
}> {
  const db = getDb();
  const nodeRows = await db
    .select({
      id: canvasNodes.id,
      status: canvasNodes.status,
      type: canvasNodes.type,
    })
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId));
  const edgeRows = await db
    .select({
      sourceNodeId: canvasEdges.sourceNodeId,
      targetNodeId: canvasEdges.targetNodeId,
      sourceHandle: canvasEdges.sourceHandle,
      targetHandle: canvasEdges.targetHandle,
    })
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvasId));

  const nodes = new Map(
    nodeRows.map((n) => [n.id, { id: n.id, status: n.status, type: n.type }]),
  );
  const edges: EdgeLike[] = edgeRows.map((e) => ({
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

/**
 * Reactive cascade: after `completedNodeId` finishes, enqueue every dirty
 * direct child that is now ready (all its runnable upstreams done). The
 * children's own completions re-trigger this, so a single re-run walks the
 * whole affected subgraph without an explicit orchestrator.
 *
 * Returns the ids that were actually enqueued. Failures are logged and do
 * not abort the rest of the cascade.
 */
export async function runReadyDirtyChildren(
  canvasId: string,
  completedNodeId: string,
): Promise<string[]> {
  const { nodes, edges } = await loadCanvasRuntime(canvasId);
  const ready = readyDirtyChildrenOf(edges, nodes, completedNodeId);

  const enqueued: string[] = [];
  for (const nodeId of ready) {
    try {
      await runNode({ canvas_id: canvasId, node_id: nodeId });
      enqueued.push(nodeId);
    } catch (err) {
      console.error(
        `[cascade] failed to run node ${nodeId}:`,
        (err as Error).message,
      );
    }
  }
  return enqueued;
}

/**
 * Manual "re-run all dirty nodes": enqueue every dirty node that is
 * currently ready. Nodes still waiting on an unfinished upstream are
 * reported as `skipped` — they will become eligible as their upstreams
 * complete (and the cascade picks them up).
 */
export async function runAllDirty(
  canvasId: string,
): Promise<{ enqueued: string[]; skipped: string[] }> {
  const { nodes, edges } = await loadCanvasRuntime(canvasId);

  const dirtyIds = [...nodes.values()]
    .filter((n) => n.status === "dirty")
    .map((n) => n.id);
  const ready = readyDirtyNodes(edges, nodes);
  const readySet = new Set(ready);
  const skipped = dirtyIds.filter((id) => !readySet.has(id));

  const enqueued: string[] = [];
  for (const nodeId of ready) {
    try {
      await runNode({ canvas_id: canvasId, node_id: nodeId });
      enqueued.push(nodeId);
    } catch (err) {
      console.error(
        `[runAllDirty] failed to run node ${nodeId}:`,
        (err as Error).message,
      );
    }
  }
  return { enqueued, skipped };
}

// ── Variants: N independent generations of an image node ───────────

/**
 * Enqueue `count` image jobs for the same node params. Each gets a
 * distinct cache key (so dedup never collapses them) and a `_variant`
 * marker the completion hook reads to gather results into a gallery.
 * Diversity relies on the model's non-determinism across calls.
 */
export async function runVariants(
  canvasId: string,
  nodeId: string,
  count: number,
): Promise<{ jobIds: string[] }> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "image") {
    throw new Error("canvas.variants_need_image_node");
  }

  const data = node.data as ImageNodeData;
  const model = await resolveImageModel(data.modelId);
  if (!model) throw new Error("input.unsupported_model");

  const effectivePrompt = composeImagePrompt(data.prompt, data.scene, data.kind);

  const upstreamAssetIds = await collectUpstreamAssetIds(canvasId, nodeId);
  const refAssetIds = [...upstreamAssetIds, ...(data.referenceAssetIds ?? [])];
  const mode = refAssetIds.length > 0 ? "i2i" : "t2i";
  if (mode === "i2i" && !model.supports_reference) {
    throw new Error("input.unsupported_model");
  }

  const { sha256s } = await collectReferenceSha256s(refAssetIds);
  const baseCacheKey = buildImageCacheKey({
    mode,
    prompt: effectivePrompt,
    model_id: data.modelId,
    size: data.size as ImageSize,
    reference_sha256s: sha256s,
  });

  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  await setNodeStatus(canvasId, nodeId, "running");
  broadcastNodeStatus(canvasId, nodeId, "running");

  const n = Math.max(1, Math.min(count, MAX_VARIANTS));
  const jobIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const jobId = randomUUID();
    // Distinct cache key per variant so the dedup layer keeps them apart.
    const cacheKey = `${baseCacheKey}:v${i}:${jobId.slice(0, 8)}`;
    const jobType = mode === "t2i" ? "image.t2i" : "image.i2i";
    const inputSnapshot = {
      mode,
      prompt: effectivePrompt,
      model_id: data.modelId,
      size: data.size,
      reference_asset_ids: refAssetIds,
      _canvas: { canvas_id: canvasId, node_id: nodeId },
      _variant: { index: i },
    };

    await db.insert(jobs).values({
      id: jobId,
      jobType,
      queueName: "q.image.std",
      bullmqJobId: jobId,
      inputSnapshot,
      cacheKey,
      status: "queued",
    });
    await db.insert(jobEvents).values({
      jobId,
      eventType: "queued",
      payload: { message: `Variant ${i + 1}/${n} queued`, node_id: nodeId },
    });

    await enqueueImageJob({
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
        prompt: effectivePrompt,
        size: data.size as ImageJobPayload["input"]["size"],
        reference_storage_keys: [],
      },
      callback: {
        event_channel: jobEventChannel(jobId),
        upload_bucket: getBucket(),
        upload_prefix: buildStorageKey("variant", jobId),
      },
      cache_key: cacheKey,
      timeout_ms: 120_000,
    });
    jobIds.push(jobId);
  }

  return { jobIds };
}

/**
 * Promote one gallery variant to be the node's output, then re-run any
 * stale downstream nodes (same lifecycle as a normal completion).
 */
export async function pickVariant(
  canvasId: string,
  nodeId: string,
  assetId: string,
): Promise<void> {
  await setNodeStatus(canvasId, nodeId, "done", assetId);
  broadcastNodeStatus(canvasId, nodeId, "done", assetId);
  await markDownstreamDirty(canvasId, nodeId);
  await runReadyDirtyChildren(canvasId, nodeId);
}

// ── Upstream asset collection ──────────────────────────────────────
//
// Returns handle-aware inputs so node executors can bind the right asset
// to the right slot (e.g. `first_frame` vs `last_frame`). The flat-id
// helper below is a convenience for nodes that only consume references.

async function collectUpstreamAssets(
  canvasId: string,
  nodeId: string,
): Promise<UpstreamInput[]> {
  const db = getDb();

  const incoming = await db
    .select({
      sourceNodeId: canvasEdges.sourceNodeId,
      sourceHandle: canvasEdges.sourceHandle,
      targetHandle: canvasEdges.targetHandle,
    })
    .from(canvasEdges)
    .where(
      and(
        eq(canvasEdges.canvasId, canvasId),
        eq(canvasEdges.targetNodeId, nodeId),
      ),
    );

  if (incoming.length === 0) return [];

  const sourceIds = incoming.map((e) => e.sourceNodeId);
  const sourceNodes = await db
    .select({
      id: canvasNodes.id,
      type: canvasNodes.type,
      outputAssetId: canvasNodes.outputAssetId,
    })
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        inArray(canvasNodes.id, sourceIds),
      ),
    );

  const nodeMap = new Map(
    sourceNodes.map((n) => [n.id, {
      id: n.id,
      type: n.type,
      outputAssetId: n.outputAssetId,
    }]),
  );

  return resolveUpstreamInputs(
    incoming.map((e) => ({
      sourceNodeId: e.sourceNodeId,
      targetNodeId: nodeId,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
    nodeMap,
    nodeId,
  );
}

/** Flat list of upstream output asset ids, in edge order. */
async function collectUpstreamAssetIds(
  canvasId: string,
  nodeId: string,
): Promise<string[]> {
  const inputs = await collectUpstreamAssets(canvasId, nodeId);
  return inputs.map((input) => input.assetId);
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
  let resolved: {
    id: string; class_path?: string; base_url?: string; model?: string;
    sizes?: string[]; supports_reference?: boolean; api_key?: string;
  } | undefined;

  // DB lookup first
  if (modelId) {
    const dbModel = await getModelById(modelId);
    if (dbModel) {
      const cfg = dbModel.config as Record<string, unknown>;
      resolved = {
        id: dbModel.id,
        class_path: (dbModel.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string | undefined,
        base_url: (dbModel.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
        model: (dbModel.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
        sizes: cfg.sizes as string[] | undefined,
        supports_reference: cfg.supports_reference as boolean | undefined,
        api_key: dbModel.apiKey ?? undefined,
      };
    } else {
      const hc = getImageModel(modelId);
      if (hc) {
        resolved = {
          id: hc.id, class_path: hc.class_path,
          base_url: hc.init_args?.base_url, model: hc.init_args?.model,
          sizes: hc.sizes, supports_reference: hc.supports_reference,
        };
      }
    }
  }

  // Tenant default
  if (!resolved) {
    const def = await getDefaultModel("default", "image");
    const cfg = def.config as Record<string, unknown>;
    resolved = {
      id: def.id,
      class_path: (def.classPath ?? cfg.class_path ?? (cfg.init_args as Record<string,string>)?.class_path) as string | undefined,
      base_url: (def.baseUrl ?? cfg.base_url ?? (cfg.init_args as Record<string,string>)?.base_url) as string | undefined,
      model: (def.vendorModelId ?? (cfg.init_args as Record<string,string>)?.model) as string | undefined,
      sizes: cfg.sizes as string[] | undefined, supports_reference: cfg.supports_reference as boolean | undefined,
      api_key: def.apiKey ?? undefined,
    };
  }

  // The Python bridge can only route jobs via class_path — fail before enqueue.
  const { class_path, ...rest } = resolved;
  if (!class_path) {
    throw new Error("provider.model_not_configured");
  }
  return { ...rest, class_path };
}

export async function resolveVideoModel(modelId?: string): Promise<{
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
  const modelId = data.modelId ?? model.id;

  // E-commerce/creative kind preset augments the prompt (and the cache key).
  const effectivePrompt = composeImagePrompt(data.prompt, data.scene, data.kind);

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
    prompt: effectivePrompt,
    model_id: modelId,
    size: data.size as ImageSize,
    reference_sha256s: sha256s,
  });

  // Cache hit check
  const cached = await findCachedJob(cacheKey);
  if (cached?.outputAssetId) return applyCacheHit(node, cached);

  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  const jobId = randomUUID();
  const jobType = mode === "t2i" ? "image.t2i" : "image.i2i";
  const queueName = "q.image.std";

  // Store canvas context in input_snapshot so the completion handler
  // can update the node status and propagate dirty flags.
  const inputSnapshot = {
    mode,
    prompt: effectivePrompt,
    model_id: modelId,
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
    model_id: modelId,
    credential: {
      class_path: model.class_path,
      api_key: apiKey,
      base_url: model.base_url,
      model: model.model,
    },
    input: {
      prompt: effectivePrompt,
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
  await assertNoInFlightNodeJob(node.canvasId, node.id);
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

  // Content-based cache: same character brief → reuse the prior portrait.
  const cacheKey = buildImageCacheKey({
    mode: "t2i",
    prompt,
    model_id: model.id,
    size: "1024x1024",
    reference_sha256s: [],
  });
  const cached = await findCachedJob(cacheKey);
  if (cached?.outputAssetId) return applyCacheHit(node, cached);

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
    cache_key: cacheKey,
    timeout_ms: 120_000,
  };

  const db = getDb();
  await assertNoInFlightNodeJob(node.canvasId, node.id);
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

/** Fetch the portrait asset ids of the characters declared as visible in a
 * shot (visibleCharIds), preferring each character's three-view front
 * portrait. Fed into the first-frame references for cross-shot consistency. */
async function collectVisibleCharAssets(
  canvasId: string,
  visibleCharIds: string[] | undefined,
): Promise<string[]> {
  if (!visibleCharIds?.length) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: canvasNodes.id,
      outputAssetId: canvasNodes.outputAssetId,
      data: canvasNodes.data,
    })
    .from(canvasNodes)
    .where(
      and(eq(canvasNodes.canvasId, canvasId), inArray(canvasNodes.id, visibleCharIds)),
    );
  return normalizeCharacterAssets(rows);
}

async function runShotNode(
  node: typeof canvasNodes.$inferSelect,
  upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  const data = node.data as ShotNodeData;

  const motion = data.motionDesc ?? "";
  const ffDesc = data.ffDesc ?? "cinematic shot";

  // Visible characters' portraits join the reference set so the first frame
  // keeps the same faces across shots (mirrors idea2video's ff_vis_char_idxs).
  const visibleCharRefs = await collectVisibleCharAssets(node.canvasId, data.visibleCharIds);
  const hasReference = upstreamAssetIds.length > 0 || visibleCharRefs.length > 0;

  // variation_type drives the generation mode (mirrors idea2video): a `large`
  // variation is a bold composition change, so references are discarded and
  // the frame is generated fresh (t2i); `small`/`medium` keep continuity with
  // the upstream reference (i2i) when one is available.
  const { mode, promptSuffix } = resolveShotMode(data.variationType, hasReference);

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
    promptSuffix,
    "professional cinematography, film grade, 4K, sharp focus",
  ]
    .filter(Boolean)
    .join(" ");

  const model = await resolveImageModel(undefined); // default image model
  const apiKey = model.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  // Content-based cache: same shot brief + lighting + references → reuse.
  // Large variations run as t2i, so references no longer feed the model or
  // the cache key.
  const refAssetIds = mode === "i2i" ? [...upstreamAssetIds, ...visibleCharRefs] : [];
  const { sha256s } = await collectReferenceSha256s(refAssetIds);
  const cacheKey = buildImageCacheKey({
    mode,
    prompt,
    model_id: model.id,
    size: "1600x900",
    reference_sha256s: sha256s,
  });
  const cached = await findCachedJob(cacheKey);
  if (cached?.outputAssetId) return applyCacheHit(node, cached);

  const jobId = randomUUID();
  const jobType = "shot.first_frame" as const;
  const queueName = "q.image.refine";

  const inputSnapshot = {
    mode,
    prompt,
    model_id: model.id,
    size: "1600x900",
    reference_asset_ids: refAssetIds,
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
    cache_key: cacheKey,
    timeout_ms: 120_000,
  };

  const db = getDb();
  await assertNoInFlightNodeJob(node.canvasId, node.id);
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

// ── Video node executor ────────────────────────────────────────────
//
// Binds the first/last frame from upstream by target handle
// ("first_frame" / "last_frame"), falling back to an unlabelled "input"
// slot and finally to positional order — so older graphs without handle
// labels keep working.

async function runVideoNode(
  node: typeof canvasNodes.$inferSelect,
  upstream: UpstreamInput[],
): Promise<NodeRunOutput> {
  const firstFrameId =
    pickByHandle(upstream, "first_frame") ??
    upstream.find((i) => i.targetHandle === null || i.targetHandle === "input")?.assetId ??
    upstream[0]?.assetId ??
    null;

  const data = node.data as {
    motionPreset?: string;
    durationSec?: number;
    modelId?: string;
    aspectRatio?: string;
    fps?: number;
    negativePrompt?: string;
    stylePresetId?: string;
  };

  // Copy-driven mode (LibTV parity): the video is driven by the shot's
  // script copy plus the nearest uploaded reference image — no per-shot
  // first-frame generation. Walk one hop up from the direct upstreams to
  // read the shot copy and to find a reference asset when the direct
  // upstream carries no output (a shot in this mode never does).
  const db = getDb();
  let shotDesc = "";
  let referenceAssetId: string | null = null;
  if (firstFrameId == null || upstream.every((i) => !i.assetId)) {
    const sourceRows = await db
      .select({
        id: canvasNodes.id,
        type: canvasNodes.type,
        data: canvasNodes.data,
        outputAssetId: canvasNodes.outputAssetId,
      })
      .from(canvasEdges)
      .innerJoin(canvasNodes, eq(canvasNodes.id, canvasEdges.sourceNodeId))
      .where(eq(canvasEdges.targetNodeId, node.id));

    for (const src of sourceRows) {
      if (src.type === "shot" && !shotDesc) {
        shotDesc = ((src.data as Record<string, unknown>).ffDesc as string) ?? "";
      }
      if (src.type === "image" && src.outputAssetId && !referenceAssetId) {
        referenceAssetId = src.outputAssetId;
      }
    }
    if (!referenceAssetId) {
      const shotIds = sourceRows.filter((s) => s.type === "shot").map((s) => s.id);
      if (shotIds.length > 0) {
        const grandRows = await db
          .select({
            type: canvasNodes.type,
            outputAssetId: canvasNodes.outputAssetId,
          })
          .from(canvasEdges)
          .innerJoin(canvasNodes, eq(canvasNodes.id, canvasEdges.sourceNodeId))
          .where(inArray(canvasEdges.targetNodeId, shotIds));
        referenceAssetId =
          grandRows.find((g) => g.type === "image" && g.outputAssetId)?.outputAssetId ?? null;
      }
    }
  }

  const effectiveFirstFrameId = firstFrameId ?? referenceAssetId;
  if (!effectiveFirstFrameId) {
    throw new Error("canvas.video_needs_upstream_frames");
  }

  const lastFrameId =
    pickByHandle(upstream, "last_frame") ??
    upstream[1]?.assetId ??
    effectiveFirstFrameId;

  // Resolve both frames' storage keys + sha256 in a single query.
  const frameIds = [...new Set([effectiveFirstFrameId, lastFrameId])];
  const frameRows = await db
    .select({ id: assets.id, storageKey: assets.storageKey, sha256: assets.sha256 })
    .from(assets)
    .where(inArray(assets.id, frameIds));
  const storageByKey = new Map(frameRows.map((r) => [r.id, r.storageKey]));
  const shaByKey = new Map(frameRows.map((r) => [r.id, r.sha256]));
  const firstFrameKey = storageByKey.get(effectiveFirstFrameId);
  const lastFrameKey = storageByKey.get(lastFrameId) ?? firstFrameKey;

  // Resolve motion preset label
  const preset = getMotionPreset(data.motionPreset ?? "zoom_in");
  const motionDesc = preset ? `${preset.label}: ${preset.description}` : (data.motionPreset ?? "zoom in");
  // Copy-driven prompt: the shot script copy is the picture description;
  // the reference image keeps the product/character appearance consistent.
  const prompt = [
    "Cinematic video",
    shotDesc ? `Scene: ${shotDesc}` : "",
    `Camera movement: ${motionDesc}`,
    getVideoStylePreset(data.stylePresetId)?.prompt,
    "Keep the subject appearance consistent with the reference image",
    "smooth motion, high quality",
    data.negativePrompt?.trim() ? `Avoid: ${data.negativePrompt.trim()}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  // Resolve video model
  const videoModel = await resolveVideoModel(data.modelId);
  const apiKey = videoModel?.api_key ?? config.arkApiKey();
  if (!apiKey) throw new Error("provider.invalid_key");

  // Content-based cache: an identical re-run (same model, prompt, frames,
  // duration, resolution) reuses the prior result instead of re-billing.
  const effectiveModelId = data.modelId ?? "doubao-seedance-1-0-lite";
  const effectiveDurationSec = data.durationSec ?? 5;
  const effectiveAspectRatio = getVideoAspectRatio(data.aspectRatio)?.ratio ?? "16:9";
  const effectiveFps = data.fps ?? 16;
  const cacheKey = buildVideoCacheKey({
    model_id: effectiveModelId,
    prompt,
    first_frame_sha256: shaByKey.get(effectiveFirstFrameId) ?? null,
    last_frame_sha256: shaByKey.get(lastFrameId) ?? null,
    duration_sec: effectiveDurationSec,
    resolution: "720p",
    aspect_ratio: effectiveAspectRatio,
    fps: effectiveFps,
  });

  const cached = await findCachedJob(cacheKey);
  if (cached?.outputAssetId) return applyCacheHit(node, cached);

  const jobId = randomUUID();
  const jobType = "shot.video" as const;
  const queueName = "q.video.std";

  const inputSnapshot = {
    first_frame_asset_id: firstFrameId,
    last_frame_asset_id: lastFrameId,
    motion_preset: data.motionPreset ?? "zoom_in",
    duration_sec: effectiveDurationSec,
    model_id: effectiveModelId,
    aspect_ratio: effectiveAspectRatio,
    fps: effectiveFps,
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  await assertNoInFlightNodeJob(node.canvasId, node.id);
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
    model_id: effectiveModelId,
    credential: {
      class_path: videoModel?.class_path ?? "tools.VideoGeneratorDoubaoSeedanceYunwuAPI",
      api_key: apiKey,
      base_url: videoModel?.base_url ?? "https://yunwu.ai/volc/v1",
      model: videoModel?.model ?? "doubao-seedance-1-0-lite-t2v-250428",
    },
    input: {
      prompt,
      first_frame_storage_key: firstFrameKey,
      last_frame_storage_key: lastFrameKey,
      duration_sec: effectiveDurationSec,
      resolution: "720p",
      aspect_ratio: effectiveAspectRatio,
      fps: effectiveFps,
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

  const data = node.data as { transition?: string };
  const transition = data.transition ?? "default";

  const db = getDb();
  // Resolve every clip's storage key + sha256 in a single query.
  const clipRows = await db
    .select({ id: assets.id, storageKey: assets.storageKey, sha256: assets.sha256 })
    .from(assets)
    .where(inArray(assets.id, upstreamAssetIds));
  const clipById = new Map(clipRows.map((r) => [r.id, r]));
  // Preserve upstream order so the concatenated sequence is deterministic.
  const storageKeys: string[] = [];
  const clipSha256s: string[] = [];
  for (const assetId of upstreamAssetIds) {
    const row = clipById.get(assetId);
    if (row) {
      storageKeys.push(row.storageKey);
      clipSha256s.push(row.sha256);
    }
  }

  if (storageKeys.length < 2) {
    throw new Error("canvas.concat_needs_upstream_videos");
  }

  // Content-based cache: same clips, same order, same transition → reuse.
  const cacheKey = buildConcatCacheKey({ clip_sha256s: clipSha256s, transition });
  const cached = await findCachedJob(cacheKey);
  if (cached?.outputAssetId) return applyCacheHit(node, cached);

  const jobId = randomUUID();
  const jobType = "concat.videos";
  const queueName = "q.concat.std";

  const inputSnapshot = {
    upstream_asset_ids: upstreamAssetIds,
    storage_key_count: storageKeys.length,
    transition,
    _canvas: {
      canvas_id: node.canvasId,
      node_id: node.id,
    },
  };

  await assertNoInFlightNodeJob(node.canvasId, node.id);
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

  await enqueueConcatJob({
    job_id: jobId,
    job_type: "concat.videos",
    input: { storage_keys: storageKeys },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("generated", jobId),
    },
    cache_key: cacheKey,
    timeout_ms: 120_000,
  });

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

  await assertNoInFlightNodeJob(canvasId, nodeId);
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

  const textModel = await getDefaultModel("default", "text");
  const apiKey = textModel.apiKey?.trim();
  if (!apiKey) throw new Error("provider.invalid_key");
  const characterRows = await db
    .select({ type: canvasNodes.type, data: canvasNodes.data })
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.type, "character")));
  const characters = mapCanvasCharactersToPayload(
    characterRows.map((row) => ({
      type: row.type,
      data: row.data as Record<string, unknown>,
    })),
  );

  const jobId = randomUUID();
  const jobType = "pipeline.script2storyboard";
  const queueName = "q.pipeline.full";

  const inputSnapshot = {
    content: data.content,
    characters,
    _canvas: { canvas_id: canvasId, node_id: nodeId },
  };

  await assertNoInFlightNodeJob(canvasId, nodeId);
  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:s2s:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Script-to-storyboard queued", node_id: nodeId },
  });

  await enqueuePipelineJob({
    job_id: jobId,
    job_type: jobType,
    credential: {
      class_path: "agents.StoryboardArtist",
      api_key: apiKey,
      base_url: textModel.baseUrl ?? undefined,
      model: textModel.vendorModelId ?? textModel.id,
      model_provider: textModel.provider,
    },
    input: {
      content: data.content,
      characters,
      user_requirement: buildStoryboardUserRequirement("script"),
    },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("pipeline", jobId),
    },
    cache_key: `canvas:s2s:${jobId}`,
    timeout_ms: 120_000,
  });

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

  const upstreamAssetIds = await collectUpstreamAssetIds(canvasId, nodeId);
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

  await assertNoInFlightNodeJob(canvasId, nodeId);
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

  await assertNoInFlightNodeJob(canvasId, nodeId);
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

  await assertNoInFlightNodeJob(canvasId, nodeId);
  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:push:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Story push 4-grid queued", node_id: nodeId },
  });

  await enqueuePipelineJob({
    job_id: jobId,
    job_type: jobType,
    credential: { class_path: "agents.StoryboardArtist", api_key: apiKey ?? "" },
    input: { content: `Predict next 4 frames: ${(data.ffDesc ?? "")}. Motion: ${(data.motionDesc ?? "")}` },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("pipeline", jobId),
    },
    cache_key: `canvas:push:${jobId}`,
    timeout_ms: 120_000,
  });

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Standalone audio node executor (音效/配乐节点) ───────────────────

async function runAudioNode(
  node: typeof canvasNodes.$inferSelect,
  _upstreamAssetIds: string[],
): Promise<NodeRunOutput> {
  const data = node.data as { prompt?: string };
  if (!data.prompt?.trim()) throw new Error("canvas.audio_desc_empty");

  const db = getDb();
  void db;

  const jobId = randomUUID();
  const jobType = "audio.generate";
  const queueName = "q.audio.std";

  const inputSnapshot = {
    audio_desc: data.prompt,
    _canvas: { canvas_id: node.canvasId, node_id: node.id },
  };

  await assertNoInFlightNodeJob(node.canvasId, node.id);
  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:audio:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Audio node generation queued", node_id: node.id },
  });

  await enqueueAudioJob({
    job_id: jobId,
    job_type: jobType,
    input: { prompt: data.prompt },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("audio", jobId),
    },
    cache_key: `canvas:audio:${jobId}`,
    timeout_ms: 180_000,
  });

  return { job_id: jobId, node_id: node.id, job_type: jobType, queue_name: queueName };
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

  await assertNoInFlightNodeJob(canvasId, nodeId);
  await db.insert(jobs).values({
    id: jobId, jobType, queueName, bullmqJobId: jobId,
    inputSnapshot, cacheKey: `canvas:audio:${jobId}`, status: "queued",
  });
  await db.insert(jobEvents).values({
    jobId, eventType: "queued",
    payload: { message: "Audio generation queued", node_id: nodeId },
  });

  await enqueueAudioJob({
    job_id: jobId,
    job_type: jobType,
    input: { prompt: data.audioDesc },
    callback: {
      event_channel: jobEventChannel(jobId),
      upload_bucket: getBucket(),
      upload_prefix: buildStorageKey("audio", jobId),
    },
    cache_key: `canvas:audio:${jobId}`,
    timeout_ms: 60_000,
  });

  return { job_id: jobId, node_id: nodeId, job_type: jobType, queue_name: queueName };
}

// ── Storyboard cell → Shot executor (分镜格转镜头) ──────────────────
//
// Synchronous counterpart to idea2video's decompose_visual_description:
// expand one storyboard cell into a fully-populated shot node. Runs inline
// (the product is a node, not an asset), so it bypasses the job queue and
// the asset-oriented completion hook in job-event.service.

export interface Storyboard2ShotResult {
  shot_node_id: string;
  source_node_id: string;
  edge_id: string;
  /** The freshly-created shot node, so the client can append it to the canvas
   * without a snapshot refetch. */
  shot_node: {
    id: string;
    type: "shot";
    position: { x: number; y: number };
    data: Record<string, unknown>;
  };
  /** The cell → shot edge, same purpose. */
  edge: {
    id: string;
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
  };
}

export async function runStoryboard2Shot(
  canvasId: string,
  nodeId: string,
): Promise<Storyboard2ShotResult> {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node || node.type !== "storyboard_cell") throw new Error("canvas.node_not_found");

  const data = node.data as StoryboardCellNodeData;
  if (!data.shotBrief?.trim()) throw new Error("canvas.storyboard_cell_empty");

  const response = await generateText({
    system: STORYBOARD_DECOMPOSE_SYSTEM_PROMPT,
    prompt: buildDecomposeUserPrompt(data.shotBrief, data.audioDesc),
    temperature: 0.6,
    maxTokens: 2048,
  });

  const decomp = parseDecomposition(response.text);
  if (!decomp) throw new Error("canvas.storyboard_decompose_failed");
  const shotData = buildShotNodeData(decomp);

  const shotNodeId = randomUUID();
  const edgeId = randomUUID();
  const cellPosition = node.position as { x: number; y: number };

  await db.insert(canvasNodes).values({
    id: shotNodeId,
    canvasId,
    type: "shot",
    position: { x: cellPosition.x + 320, y: cellPosition.y },
    data: { ...shotData, status: "idle" },
    status: "idle",
  });
  await db.insert(canvasEdges).values({
    id: edgeId,
    canvasId,
    sourceNodeId: nodeId,
    targetNodeId: shotNodeId,
    sourceHandle: "output",
    targetHandle: "reference",
  });

  // Mark the cell done so the storyboard reads as expanded.
  await setNodeStatus(canvasId, nodeId, "done");
  broadcastNodeStatus(canvasId, nodeId, "done");

  return {
    shot_node_id: shotNodeId,
    source_node_id: nodeId,
    edge_id: edgeId,
    shot_node: {
      id: shotNodeId,
      type: "shot",
      position: { x: cellPosition.x + 320, y: cellPosition.y },
      data: { ...shotData, status: "idle" },
    },
    edge: {
      id: edgeId,
      source: nodeId,
      target: shotNodeId,
      sourceHandle: "output",
      targetHandle: "reference",
    },
  };
}
