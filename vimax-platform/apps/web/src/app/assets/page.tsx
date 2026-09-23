"use client";

import { trpc } from "@/lib/trpc/client";
import { PageContainer, Badge, EmptyState, SkeletonList, cn } from "@vimax/ui";
import { Image, Video, Music, File, Search, Grid3X3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

type AssetKind = "image" | "video" | "audio";

const TYPE_ICONS: Record<AssetKind, React.ReactNode> = {
  image: <Image className="size-4" />, video: <Video className="size-4" />, audio: <Music className="size-4" />,
};

export default function AssetsPage() {
  const t = useTranslations("assets");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "">("");

  const assetsQuery = trpc.asset.listAssets.useQuery(kindFilter ? { kind: kindFilter as "image" | "video" | "audio" } : undefined, { staleTime: 30_000 });
  const assets = assetsQuery.data?.items ?? [];

  const filteredAssets = assets.filter((a) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return a.asset_id.toLowerCase().includes(s) || a.mime_type.toLowerCase().includes(s);
  });

  const TYPE_LABELS: Record<AssetKind, string> = { image: t("typeImage"), video: t("typeVideo"), audio: t("typeAudio") };

  return (
    <PageContainer maxWidth="xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">{t("title")}</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">{t("subtitle")}</p>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-8">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-[var(--color-text-quaternary)]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} className="w-full h-10 pl-10 pr-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-quaternary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20 focus-visible:border-[var(--color-accent)] transition-all duration-[var(--duration-fast)]" />
        </div>
        <div className="flex gap-1 bg-[var(--color-surface)] rounded-lg p-1 border border-[var(--color-border-default)]">
          {(["", "image", "video", "audio"] as const).map((k) => {
            const label = k === "" ? t("filterAll") : k in TYPE_LABELS ? TYPE_LABELS[k as AssetKind] : k;
            return (
              <button key={k} onClick={() => setKindFilter(k)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-[var(--duration-fast)]", kindFilter === k ? "bg-[var(--color-accent)] text-white shadow-[var(--shadow-accent-sm)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-inset)]")}>{label}</button>
            );
          })}
        </div>
      </div>

      {assetsQuery.isLoading ? (
        <SkeletonList count={6} />
      ) : filteredAssets.length === 0 ? (
        <EmptyState title={t("noAssets")} description={t("noAssetsDesc")} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredAssets.map((asset) => (
            <div key={asset.asset_id} className="group rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-border-hover)] hover:shadow-[var(--shadow-card-hover)] transition-all duration-[var(--duration-base)]">
              <div className="aspect-square bg-[var(--color-bg-inset)] flex items-center justify-center">
                {(asset.kind in TYPE_ICONS ? TYPE_ICONS[asset.kind as AssetKind] : <File className="size-10 text-[var(--color-text-quaternary)]" />)}
              </div>
              <div className="p-3 space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <Badge variant="default" dot>{asset.kind in TYPE_LABELS ? TYPE_LABELS[asset.kind as AssetKind] : asset.kind}</Badge>
                </div>
                <p className="text-xs text-[var(--color-text-tertiary)] truncate">{asset.asset_id.slice(0, 12)}…</p>
                {asset.size_bytes != null && (
                  <p className="text-[10px] text-[var(--color-text-quaternary)]">{asset.size_bytes > 1024 * 1024 ? `${(asset.size_bytes / (1024 * 1024)).toFixed(1)} MB` : asset.size_bytes > 1024 ? `${(asset.size_bytes / 1024).toFixed(1)} KB` : `${asset.size_bytes} B`}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
