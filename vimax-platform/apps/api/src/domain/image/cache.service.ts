import { createHash } from "node:crypto";
import type { ImageGenerateInput } from "@vimax/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client.js";
import { assets, jobs } from "../../infrastructure/db/schema.js";
import type { Asset } from "../../infrastructure/db/schema.js";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildImageCacheKey(input: {
  mode: ImageGenerateInput["mode"];
  prompt: string;
  model_id: string;
  size: ImageGenerateInput["size"];
  reference_sha256s: string[];
}): string {
  const canonical = {
    mode: input.mode,
    prompt: input.prompt.trim(),
    model_id: input.model_id,
    size: input.size,
    refs: [...input.reference_sha256s].sort(),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export async function findCachedImageJob(cacheKey: string) {
  const db = getDb();
  const [hit] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.cacheKey, cacheKey), eq(jobs.status, "succeeded")))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  return hit ?? null;
}

export async function collectReferenceSha256s(assetIds: string[] | undefined): Promise<{
  assets: Asset[];
  sha256s: string[];
}> {
  if (!assetIds?.length) {
    return { assets: [], sha256s: [] };
  }

  const db = getDb();
  const rows = await db.select().from(assets).where(inArray(assets.id, assetIds));

  if (rows.length !== assetIds.length) {
    throw new Error("input.asset_not_found");
  }

  return {
    assets: rows,
    sha256s: rows.map((row: Asset) => row.sha256).sort(),
  };
}
