import { randomUUID } from "crypto";
import type { Script2StoryboardCell } from "@vimax/contracts";
import { getDb } from "../../infrastructure/db/client.js";
import { canvasEdges, canvasNodes } from "../../infrastructure/db/schema.js";

export const STORYBOARD_ZONE = { x: 720, y: 60 };
export const STORYBOARD_ROW_HEIGHT = 240;

export interface SpawnedStoryboardNode {
  id: string;
  type: "storyboard_cell";
  position: { x: number; y: number };
  data: {
    shotBrief: string;
    cameraIdx: number;
    audioDesc: string;
    status: "idle";
  };
}

export interface SpawnedStoryboardEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: null;
  targetHandle: null;
}

export function buildStoryboardSpawnGraph(
  scriptNodeId: string,
  cells: Script2StoryboardCell[],
): { nodes: SpawnedStoryboardNode[]; edges: SpawnedStoryboardEdge[] } {
  const nodes: SpawnedStoryboardNode[] = [];
  const edges: SpawnedStoryboardEdge[] = [];

  cells.forEach((cell, index) => {
    const nodeId = randomUUID();
    nodes.push({
      id: nodeId,
      type: "storyboard_cell",
      position: {
        x: STORYBOARD_ZONE.x,
        y: STORYBOARD_ZONE.y + index * STORYBOARD_ROW_HEIGHT,
      },
      data: {
        shotBrief: cell.shotBrief,
        cameraIdx: cell.cameraIdx,
        audioDesc: cell.audioDesc ?? "",
        status: "idle",
      },
    });
    edges.push({
      id: randomUUID(),
      sourceNodeId: scriptNodeId,
      targetNodeId: nodeId,
      sourceHandle: null,
      targetHandle: null,
    });
  });

  return { nodes, edges };
}

export async function persistStoryboardSpawn(
  canvasId: string,
  scriptNodeId: string,
  cells: Script2StoryboardCell[],
): Promise<string[]> {
  if (cells.length === 0) return [];

  const { nodes, edges } = buildStoryboardSpawnGraph(scriptNodeId, cells);
  const db = getDb();

  await db.insert(canvasNodes).values(
    nodes.map((node) => ({
      id: node.id,
      canvasId,
      type: node.type,
      position: node.position,
      data: node.data,
      status: "idle" as const,
    })),
  );

  await db.insert(canvasEdges).values(
    edges.map((edge) => ({
      id: edge.id,
      canvasId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    })),
  );

  return nodes.map((node) => node.id);
}
