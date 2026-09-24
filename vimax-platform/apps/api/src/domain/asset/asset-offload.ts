import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client.js";
import { assets } from "../../infrastructure/db/schema.js";
import { deleteObject } from "../../infrastructure/storage/s3.js";

// ── 本地化存储策略 ────────────────────────────────────────────────
// 云端对象存储只做瞬时中转：worker 产物先上传（传输通道），客户端把
// 二进制确认写入本地 IndexedDB 后调用 offloadAsset 删除远端对象；
// sweepGeneratedAssets 是兜底——超过 TTL 仍未被认领的生成资产同样
// 清除二进制。元数据行始终保留（节点引用不断链）。用户手动上云
// （source=upload）的资产永不自动清除。

export type OffloadDecision =
  | { action: "offload" }
  | { action: "skip"; reason: "already_offloaded" | "upload_protected" };

export function resolveOffloadPolicy(asset: {
  source: string;
  offloadedAt: Date | null;
}): OffloadDecision {
  if (asset.offloadedAt !== null) return { action: "skip", reason: "already_offloaded" };
  if (asset.source === "upload") return { action: "skip", reason: "upload_protected" };
  return { action: "offload" };
}

/** 客户端确认本地落库后，删除远端二进制并记录时间。幂等。 */
export async function offloadAsset(assetId: string) {
  const db = getDb();
  const [asset] = await db
    .select({ source: assets.source, offloadedAt: assets.offloadedAt, storageKey: assets.storageKey })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset) {
    throw new Error("input.asset_not_found");
  }

  const decision = resolveOffloadPolicy(asset);
  if (decision.action === "skip") {
    return { asset_id: assetId, offloaded: false, reason: decision.reason };
  }

  await deleteObject(asset.storageKey);
  await db.update(assets).set({ offloadedAt: new Date() }).where(eq(assets.id, assetId));
  return { asset_id: assetId, offloaded: true };
}

/** TTL 兜底清扫：删除超时未认领的 generated 二进制。返回清除数量。 */
export async function sweepGeneratedAssets(ttlHours: number, batchSize = 500) {
  const db = getDb();
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000);
  const stale = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(
      and(
        eq(assets.source, "generated"),
        isNull(assets.offloadedAt),
        lt(assets.createdAt, cutoff),
      ),
    )
    .limit(batchSize);

  let swept = 0;
  for (const asset of stale) {
    await deleteObject(asset.storageKey);
    const updated = await db
      .update(assets)
      .set({ offloadedAt: sql`now()` })
      .where(and(eq(assets.id, asset.id), isNull(assets.offloadedAt)))
      .returning({ id: assets.id });
    swept += updated.length;
  }
  return { swept, cutoff: cutoff.toISOString() };
}
