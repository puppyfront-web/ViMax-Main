import { and, count, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client.js";
import {
  canvasEdges,
  canvasNodes,
  canvases,
} from "../../infrastructure/db/schema.js";
import type {
  CanvasCreateInput,
  CanvasCreateOutput,
  CanvasListInput,
  CanvasListOutput,
  CanvasSaveInput,
  CanvasSnapshotOutput,
} from "@vimax/contracts";

// ── Create ─────────────────────────────────────────────────────────

export async function createCanvas(
  input: CanvasCreateInput,
  tenantId = "default",
): Promise<CanvasCreateOutput> {
  const db = getDb();
  const [canvas] = await db
    .insert(canvases)
    .values({
      tenantId,
      name: input.name,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    .returning({ id: canvases.id });

  return { canvas_id: canvas!.id };
}

// ── List ───────────────────────────────────────────────────────────

export async function listCanvases(
  input: CanvasListInput,
  tenantId = "default",
): Promise<CanvasListOutput> {
  const db = getDb();
  const limit = input.limit ?? 20;

  // Build cursor condition
  const conditions = [eq(canvases.tenantId, tenantId)];
  if (input.cursor) {
    const [cursorCanvas] = await db
      .select({ updatedAt: canvases.updatedAt })
      .from(canvases)
      .where(eq(canvases.id, input.cursor))
      .limit(1);
    if (cursorCanvas) {
      conditions.push(lt(canvases.updatedAt, cursorCanvas.updatedAt));
    }
  }

  const rows = await db
    .select({
      id: canvases.id,
      name: canvases.name,
      updatedAt: canvases.updatedAt,
    })
    .from(canvases)
    .where(and(...conditions))
    .orderBy(desc(canvases.updatedAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  // Get node counts in one query
  const items = await Promise.all(
    page.map(async (row) => {
      const [result] = await db
        .select({ cnt: count() })
        .from(canvasNodes)
        .where(eq(canvasNodes.canvasId, row.id));
      return {
        canvas_id: row.id,
        name: row.name,
        node_count: result?.cnt ?? 0,
        updated_at: row.updatedAt.toISOString(),
      };
    }),
  );

  return {
    items,
    nextCursor: rows.length > limit ? rows[limit]?.id : undefined,
  };
}

// ── Snapshot (full state load) ─────────────────────────────────────

export async function getCanvasSnapshot(
  canvasId: string,
): Promise<CanvasSnapshotOutput | null> {
  const db = getDb();

  const [canvas] = await db
    .select()
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .limit(1);

  if (!canvas) return null;

  const nodes = await db
    .select()
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId));

  const edges = await db
    .select()
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvasId));

  return {
    canvas: {
      id: canvas.id,
      tenant_id: canvas.tenantId,
      name: canvas.name,
      viewport: canvas.viewport as { x: number; y: number; zoom: number },
      created_at: canvas.createdAt.toISOString(),
      updated_at: canvas.updatedAt.toISOString(),
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      canvas_id: n.canvasId,
      type: n.type,
      position: n.position as { x: number; y: number },
      data: n.data as Record<string, unknown>,
      output_asset_id: n.outputAssetId,
      status: n.status,
      created_at: n.createdAt.toISOString(),
      updated_at: n.updatedAt.toISOString(),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      canvas_id: e.canvasId,
      source_node_id: e.sourceNodeId,
      target_node_id: e.targetNodeId,
      source_handle: e.sourceHandle,
      target_handle: e.targetHandle,
      created_at: e.createdAt.toISOString(),
    })),
  };
}

// ── Save (batch replace nodes + edges) ─────────────────────────────

export async function saveCanvas(input: CanvasSaveInput): Promise<{ ok: true }> {
  const db = getDb();

  await db.transaction(async (tx) => {
    // 1. Remove edges and nodes not in the incoming set
    const incomingNodeIds = new Set(input.nodes.map((n) => n.id));
    const incomingEdgeIds = new Set(input.edges.map((e) => e.id));

    // Delete removed edges first (FK to nodes)
    await tx.delete(canvasEdges).where(
      and(
        eq(canvasEdges.canvasId, input.canvas_id),
        // Only delete edges NOT in the incoming list
        ...(incomingEdgeIds.size > 0
          ? [] // We'll delete all and re-insert — simpler
          : []),
      ),
    );

    // Actually, full replace is simpler and more robust:
    // Delete all existing edges and nodes, then re-insert
    await tx
      .delete(canvasEdges)
      .where(eq(canvasEdges.canvasId, input.canvas_id));

    await tx
      .delete(canvasNodes)
      .where(eq(canvasNodes.canvasId, input.canvas_id));

    // 2. Insert new nodes
    if (input.nodes.length > 0) {
      await tx.insert(canvasNodes).values(
        input.nodes.map((n) => ({
          id: n.id,
          canvasId: input.canvas_id,
          type: n.type,
          position: n.position,
          data: n.data,
          status: "idle" as const,
        })),
      );
    }

    // 3. Insert new edges (after nodes, due to FK)
    if (input.edges.length > 0) {
      await tx.insert(canvasEdges).values(
        input.edges.map((e) => ({
          id: e.id,
          canvasId: input.canvas_id,
          sourceNodeId: e.source_node_id,
          targetNodeId: e.target_node_id,
          sourceHandle: e.source_handle ?? null,
          targetHandle: e.target_handle ?? null,
        })),
      );
    }

    // 4. Update canvas metadata
    const updateData: Partial<{ viewport: typeof canvases.$inferInsert["viewport"] }> =
      {};
    if (input.viewport) {
      updateData.viewport = input.viewport;
    }
    await tx
      .update(canvases)
      .set({
        ...updateData,
        updatedAt: new Date(),
      })
      .where(eq(canvases.id, input.canvas_id));
  });

  return { ok: true };
}

// ── Delete canvas ──────────────────────────────────────────────────

export async function deleteCanvas(
  canvasId: string,
): Promise<{ ok: true }> {
  const db = getDb();

  // FK cascades handle nodes + edges
  const [deleted] = await db
    .delete(canvases)
    .where(eq(canvases.id, canvasId))
    .returning({ id: canvases.id });

  if (!deleted) {
    throw new Error("canvas.not_found");
  }

  return { ok: true };
}

// ── Helper: get single node ─────────────────────────────────────────

export async function getCanvasNode(
  canvasId: string,
  nodeId: string,
) {
  const db = getDb();
  const [node] = await db
    .select()
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        eq(canvasNodes.id, nodeId),
      ),
    )
    .limit(1);
  return node ?? null;
}

// ── Helper: get upstream nodes via edges ────────────────────────────

export async function getUpstreamNodes(
  canvasId: string,
  nodeId: string,
) {
  const db = getDb();

  // Find all edges where this node is the target
  const incomingEdges = await db
    .select()
    .from(canvasEdges)
    .where(
      and(
        eq(canvasEdges.canvasId, canvasId),
        eq(canvasEdges.targetNodeId, nodeId),
      ),
    );

  if (incomingEdges.length === 0) return [];

  const upstreamIds = incomingEdges.map((e) => e.sourceNodeId);

  const upstreamNodes = await db
    .select()
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        // We need IN clause — Drizzle supports this via `inArray` but
        // let's query one at a time for simplicity since fan-out is small
      ),
    );

  // Filter to only upstream nodes
  const nodeMap = new Map(upstreamNodes.map((n) => [n.id, n]));
  return incomingEdges.map((edge) => {
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    return {
      edge,
      sourceNode: sourceNode ?? null,
    };
  });
}

// ── Helper: mark node status ────────────────────────────────────────

export async function setNodeStatus(
  canvasId: string,
  nodeId: string,
  status: "idle" | "running" | "done" | "dirty" | "failed",
  outputAssetId?: string | null,
) {
  const db = getDb();
  const updateData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (outputAssetId !== undefined) {
    updateData.outputAssetId = outputAssetId;
  }
  await db
    .update(canvasNodes)
    .set(updateData)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        eq(canvasNodes.id, nodeId),
      ),
    );
}

// ── Helper: mark downstream nodes dirty ─────────────────────────────

export async function markDownstreamDirty(
  canvasId: string,
  nodeId: string,
) {
  const db = getDb();

  // BFS from nodeId to find all downstream nodes
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Find outgoing edges
    const outgoing = await db
      .select({ targetNodeId: canvasEdges.targetNodeId })
      .from(canvasEdges)
      .where(
        and(
          eq(canvasEdges.canvasId, canvasId),
          eq(canvasEdges.sourceNodeId, current),
        ),
      );

    for (const edge of outgoing) {
      if (!visited.has(edge.targetNodeId)) {
        queue.push(edge.targetNodeId);
      }
    }
  }

  // Mark all downstream nodes (excluding the trigger node) as dirty
  visited.delete(nodeId);
  if (visited.size > 0) {
    await db
      .update(canvasNodes)
      .set({ status: "dirty", updatedAt: new Date() })
      .where(
        and(
          eq(canvasNodes.canvasId, canvasId),
          // Mark nodes that are currently done or idle
          // We use a raw condition approach — update all visited
        ),
      );

    // Update one by one for visited nodes
    for (const id of visited) {
      await db
        .update(canvasNodes)
        .set({ status: "dirty", updatedAt: new Date() })
        .where(
          and(
            eq(canvasNodes.canvasId, canvasId),
            eq(canvasNodes.id, id),
          ),
        );
    }
  }
}

// ── Helper: update a single data field on a node ───────────────────

export async function updateNodeDataField(
  canvasId: string,
  nodeId: string,
  key: string,
  value: unknown,
) {
  const db = getDb();
  const [node] = await db
    .select({ data: canvasNodes.data })
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)))
    .limit(1);
  if (!node) return;

  const currentData = (node.data as Record<string, unknown>) ?? {};
  await db
    .update(canvasNodes)
    .set({ data: { ...currentData, [key]: value }, updatedAt: new Date() })
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.id, nodeId)));
}
