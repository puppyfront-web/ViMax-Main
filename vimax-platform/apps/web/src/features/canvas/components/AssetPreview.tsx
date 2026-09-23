"use client";

import { trpc } from "@/lib/trpc/client";

interface AssetPreviewProps {
  assetId: string;
  kind?: "image" | "video";
  className?: string;
  /** Rendered height in px (default 120). */
  height?: number;
}

export function AssetPreview({
  assetId,
  kind = "video",
  className,
  height = 120,
}: AssetPreviewProps) {
  const { data, isLoading, error } = trpc.canvas.getAssetUrl.useQuery(
    { asset_id: assetId },
    { staleTime: 300_000 },
  );

  if (isLoading) {
    return (
      <div
        className={className}
        style={{
          height,
          borderRadius: 6,
          backgroundColor: "var(--color-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "var(--color-text-muted)",
        }}
      >
        加载预览…
      </div>
    );
  }

  if (error || !data?.url) {
    return (
      <div
        className={className}
        style={{
          height: 80,
          borderRadius: 6,
          backgroundColor: "var(--color-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "var(--color-text-muted)",
        }}
      >
        预览不可用
      </div>
    );
  }

  if (kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={data.url}
        alt="preview"
        loading="lazy"
        className={className}
        style={{
          width: "100%",
          height,
          objectFit: "cover",
          borderRadius: 6,
          backgroundColor: "var(--color-bg)",
        }}
      />
    );
  }

  return (
    <video
      src={data.url}
      controls
      preload="metadata"
      className={className}
      style={{
        width: "100%",
        height,
        borderRadius: 6,
        backgroundColor: "#000",
        objectFit: "contain",
      }}
    />
  );
}
