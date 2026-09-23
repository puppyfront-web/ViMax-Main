// ── Dagre Auto-Layout Utility ────────────────────────────────────────
// Provides automatic graph layout using Dagre algorithm.
// Adapted from Toonflow-web's dagre.ts (Vue Flow → React Flow adaptation).

import Dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import type { CanvasNodeType } from "@vimax/contracts";

// ── Layout Direction ────────────────────────────────────────────────

export type LayoutDirection = "LR" | "TB";

// ── Node dimensions per type (approximate rendered size) ────────────

const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  script: { width: 260, height: 180 },
  character: { width: 220, height: 200 },
  storyboard_cell: { width: 240, height: 160 },
  shot: { width: 280, height: 220 },
  image: { width: 240, height: 200 },
  video: { width: 240, height: 180 },
  concat: { width: 240, height: 160 },
};

const DEFAULT_DIMENSION = { width: 260, height: 180 };

// ── Compute Dagre Layout ────────────────────────────────────────────

export function computeDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = "LR",
): Node[] {
  if (nodes.length === 0) return nodes;

  const g = new Dagre.graphlib.Graph()
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({
      rankdir: direction,
      nodesep: 80,
      ranksep: 120,
      marginx: 40,
      marginy: 40,
    });

  // Add nodes with their dimensions
  for (const node of nodes) {
    const dims = NODE_DIMENSIONS[node.type ?? ""] ?? DEFAULT_DIMENSION;
    g.setNode(node.id, dims);
  }

  // Add edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  // Run layout
  Dagre.layout(g);

  // Apply computed positions
  return nodes.map((node) => {
    const nodeWithPosition = g.node(node.id);
    if (!nodeWithPosition) return node;

    const dims = NODE_DIMENSIONS[node.type ?? ""] ?? DEFAULT_DIMENSION;

    // Dagre gives center positions, but React Flow uses top-left
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - dims.width / 2,
        y: nodeWithPosition.y - dims.height / 2,
      },
    };
  });
}

// ── Zone-based layout (existing ViMax pattern) ──────────────────────
// Kept as an alternative for users who prefer the spatial zone view.

export const ZONE_LAYOUT: Record<CanvasNodeType, { x: number; y: number }> = {
  script: { x: 40, y: 60 },
  character: { x: 40, y: 300 },
  storyboard_cell: { x: 360, y: 60 },
  shot: { x: 680, y: 160 },
  image: { x: 1020, y: 60 },
  video: { x: 1360, y: 160 },
  concat: { x: 1020, y: 420 },
};

const ZONE_OFFSET = 280;

export function computeZoneLayout(nodes: Node[]): Node[] {
  const typeCounts: Record<string, number> = {};
  return nodes.map((n) => {
    const type = (n.type ?? "image") as CanvasNodeType;
    const zone = ZONE_LAYOUT[type] ?? { x: 100, y: 100 };
    const idx = typeCounts[type] ?? 0;
    typeCounts[type] = idx + 1;
    return {
      ...n,
      position: {
        x: zone.x + (idx % 3) * 20,
        y: zone.y + Math.floor(idx / 3) * ZONE_OFFSET,
      },
    };
  });
}
