"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { ImageSize } from "@vimax/contracts";
import { trpc } from "@/lib/trpc/client";
import { SegmentedControl } from "@vimax/ui";
import { NegativePromptChips, ThesaurusChips } from "@/features/prompt-words/PromptWordChips";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

// ---------------------------------------------------------------------------
// Types (local to this page; contracts are imported via tRPC inference)
// ---------------------------------------------------------------------------

interface HistoryItem {
  job_id: string;
  status: string;
  prompt: string;
  mode?: string;
  model_id?: string;
  thumbnail_url?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ModelSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { data } = trpc.model.listImageModels.useQuery();
  const models = data?.items ?? [];

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function SizeSelect({
  value,
  onChange,
  sizes,
}: {
  value: ImageSize;
  onChange: (v: ImageSize) => void;
  sizes: ImageSize[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ImageSize)}
      className="w-full rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
    >
      {sizes.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function ReferenceUploader({
  assetIds,
  onUpload,
  onRemove,
}: {
  assetIds: string[];
  onUpload: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations("studio");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestUpload = trpc.asset.requestUpload.useMutation();
  const confirmUpload = trpc.asset.confirmUpload.useMutation();

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        // 1. Request presigned URL
        const req = await requestUpload.mutateAsync({
          mime_type: file.type as "image/png" | "image/jpeg" | "image/webp",
          size_bytes: file.size,
        });

        // 2. Upload directly to MinIO
        await fetch(req.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });

        // 3. Compute sha256 client-side + confirm
        const buf = await file.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", buf);
        const sha256 = Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        // 4. Get dimensions from an Image element
        const dims = await new Promise<{ w: number; h: number }>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.src = URL.createObjectURL(file);
        });

        await confirmUpload.mutateAsync({
          asset_id: req.asset_id,
          sha256,
          width: dims.w,
          height: dims.h,
        });

        onUpload(req.asset_id);
      } catch (err) {
        console.error("Upload failed", err);
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [requestUpload, confirmUpload, onUpload],
  );

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {assetIds.map((id) => (
          <div
            key={id}
            className="relative w-14 h-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center text-xs text-[var(--color-text-muted)]"
          >
            <button
              type="button"
              onClick={() => onRemove(id)}
              aria-label={t("refRemove")}
              className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-danger)] text-[10px] text-white"
            >
              ×
            </button>
            {t("refThumb")}
          </div>
        ))}
        {assetIds.length < 4 && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            aria-label={t("refUpload")}
            className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)] text-2xl text-[var(--color-ink-subtle)] transition-colors hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            {uploading ? "…" : "+"}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
      <div
        className="h-full bg-[var(--color-accent)] transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function StudioImagePage() {
  const t = useTranslations("studio");
  const [mode, setMode] = useState<"t2i" | "i2i">("t2i");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [negativeOpen, setNegativeOpen] = useState(false);
  const [modelId, setModelId] = useState("doubao-seedream-4-0");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [refAssetIds, setRefAssetIds] = useState<string[]>([]);

  // Current job tracking
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sseRef = useRef<EventSource | null>(null);

  // Mutations
  const generateMutation = trpc.image.generate.useMutation();
  const getJobQuery = trpc.image.getJob.useQuery(
    { job_id: activeJobId! },
    { enabled: !!activeJobId, refetchInterval: false },
  );

  // History
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const historyQuery = trpc.image.listHistory.useQuery(
    { limit: 20, cursor: historyCursor },
    { refetchInterval: 10_000 },
  );

  // Model info for sizes
  const { data: modelData } = trpc.model.listImageModels.useQuery();
  const currentModel = modelData?.items?.find((m) => m.id === modelId);
  const availableSizes: ImageSize[] = (currentModel?.sizes as ImageSize[] | undefined) ?? ["1024x1024"];

  // Keep size valid when model changes
  useEffect(() => {
    if (!availableSizes.includes(size)) {
      setSize(availableSizes[0]);
    }
  }, [modelId, availableSizes, size]);

  // SSE subscription
  const subscribeSSE = useCallback(
    (jobId: string) => {
      // Close previous connection to prevent leaks on rapid re-generate
      sseRef.current?.close();

      const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace("/trpc", "") ?? "http://localhost:3001";
      const es = new EventSource(`${apiBase}/sse/jobs/${jobId}`);
      sseRef.current = es;

      es.addEventListener("started", () => {
        setJobStatus("running");
      });
      es.addEventListener("progress", (e) => {
        const d = JSON.parse(e.data);
        setJobProgress(d.percent ?? 0);
      });
      es.addEventListener("completed", (e) => {
        const d = JSON.parse(e.data);
        setJobStatus("succeeded");
        setJobProgress(100);
        es.close();
        // Fetch output URL via tRPC
        getJobQuery.refetch().then((res) => {
          if (res.data?.output_url) setOutputUrl(res.data.output_url);
        }).catch((err) => {
          console.error("Failed to fetch output URL:", err);
          setErrorMessage("图片已生成，但获取下载链接失败，请刷新页面重试");
        });
      });
      es.addEventListener("failed", (e) => {
        const d = JSON.parse(e.data);
        setJobStatus("failed");
        setErrorMessage(d.error_message ?? "Unknown error");
        es.close();
      });
      es.onerror = () => {
        es.close();
      };
    },
    [getJobQuery],
  );

  // Generate
  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setOutputUrl(null);
    setErrorMessage(null);
    setJobProgress(0);
    setJobStatus("queued");

    try {
      const res = await generateMutation.mutateAsync({
        mode,
        prompt: prompt.trim(),
        model_id: modelId,
        size: size as ImageSize,
        negative_prompt: negativePrompt.trim() || undefined,
        reference_asset_ids: mode === "i2i" ? refAssetIds : undefined,
        force: false,
      });

      setActiveJobId(res.job_id);

      if (res.cache_hit && res.output_asset_id) {
        setJobStatus("cached");
        setJobProgress(100);
        // Fetch output URL
        const job = await getJobQuery.refetch();
        if (job.data?.output_url) setOutputUrl(job.data.output_url);
      } else {
        subscribeSSE(res.job_id);
      }
    } catch (err) {
      setJobStatus("failed");
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
    }
  };

  // Reuse a history item's prompt
  const reuseHistory = (item: HistoryItem) => {
    setPrompt(item.prompt);
    if (item.mode === "t2i" || item.mode === "i2i") setMode(item.mode);
    if (item.model_id) setModelId(item.model_id);
  };

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => sseRef.current?.close();
  }, []);

  const isGenerating = jobStatus === "queued" || jobStatus === "running";

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center border-b border-[var(--color-hairline)] px-4">
        <h1 className="text-sm font-semibold tracking-wide text-[var(--color-ink)]">
          {t("brand")}
        </h1>
      </header>

      {/* Body — stacked on mobile, three panes on desktop */}
      <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Left: Parameters (320px) */}
        <aside className="flex shrink-0 flex-col gap-4 border-b border-[var(--color-hairline)] p-4 lg:w-80 lg:border-b-0 lg:border-r lg:overflow-y-auto">
          <SegmentedControl
            ariaLabel={t("modeT2I")}
            fullWidth
            value={mode}
            onChange={(v) => setMode(v as "t2i" | "i2i")}
            items={[
              { value: "t2i", label: t("modeT2I") },
              { value: "i2i", label: t("modeI2I") },
            ]}
          />

          <div>
            <label className="mb-1 block text-xs text-[var(--color-ink-subtle)]">
              {t("promptLabel")}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === "t2i" ? t("promptPlaceholderT2I") : t("promptPlaceholderI2I")
              }
              rows={4}
              className="w-full resize-none rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-ink-tertiary)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-focus)]"
            />
          </div>

          {/* 联想词：维度 tab + 词条 chips，点击追加到提示词 */}
          <div>
            <span className="mb-1.5 block text-xs text-[var(--color-ink-subtle)]">
              {t("associationLabel")}
            </span>
            <ThesaurusChips
              onAppend={(fragment) =>
                setPrompt((p) => [p.trim(), fragment].filter(Boolean).join(", "))
              }
            />
          </div>

          {/* 限制词：预设 chips + 自由输入，折叠收纳 */}
          <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-1)] p-2">
            <button
              type="button"
              onClick={() => setNegativeOpen((v) => !v)}
              className="flex w-full items-center justify-between"
            >
              <span className="text-xs text-[var(--color-ink-subtle)]">
                {t("negativeLabel")}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-ink-tertiary)]">
                {negativeOpen ? "−" : "+"}
              </span>
            </button>
            {negativeOpen && (
              <div className="mt-2 flex flex-col gap-2">
                <NegativePromptChips value={negativePrompt} onChange={setNegativePrompt} />
                <input
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder={t("negativePlaceholder")}
                  className="w-full rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)] px-2.5 py-1.5 text-xs text-[var(--color-ink-subtle)] placeholder-[var(--color-ink-tertiary)] focus:border-[var(--color-accent)] focus:text-[var(--color-ink)] focus:outline-none"
                />
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--color-ink-subtle)]">
              {t("modelLabel")}
            </label>
            <ModelSelect value={modelId} onChange={setModelId} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--color-ink-subtle)]">
              {t("sizeLabel")}
            </label>
            <SizeSelect value={size} onChange={setSize} sizes={availableSizes} />
          </div>

          {mode === "i2i" && (
            <div>
              <label className="mb-1 block text-xs text-[var(--color-ink-subtle)]">
                {t("refLabel")}
              </label>
              <ReferenceUploader
                assetIds={refAssetIds}
                onUpload={(id) => setRefAssetIds((prev) => [...prev, id])}
                onRemove={(id) => setRefAssetIds((prev) => prev.filter((x) => x !== id))}
              />
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || isGenerating}
            aria-label={isGenerating ? t("generating") : t("generate")}
            className="mt-auto w-full rounded-lg bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-[var(--color-accent-on)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isGenerating ? t("generating") : t("generate")}
          </button>
        </aside>

        {/* Center: Preview */}
        <main className="flex flex-1 flex-col items-center justify-center p-6">
          {!activeJobId && (
            <p className="text-sm text-[var(--color-ink-subtle)]">
              {t("emptyHint")}
            </p>
          )}

          {activeJobId && (
            <div className="w-full max-w-2xl flex flex-col items-center gap-4">
              {/* Status bar */}
              <div className="flex w-full items-center gap-3">
                <div
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    jobStatus === "succeeded" || jobStatus === "cached"
                      ? "bg-[var(--color-success)]"
                      : jobStatus === "failed"
                        ? "bg-[var(--color-danger)]"
                        : "animate-pulse bg-[var(--color-accent)]"
                  }`}
                  aria-hidden
                />
                <span className="text-sm text-[var(--color-ink-subtle)]" role="status">
                  {jobStatus === "queued" && t("statusQueued")}
                  {jobStatus === "running" && t("statusRunning", { percent: jobProgress })}
                  {jobStatus === "succeeded" && t("statusSucceeded")}
                  {jobStatus === "cached" && t("statusCached")}
                  {jobStatus === "failed" && t("statusFailed")}
                </span>
                {activeJobId && (
                  <span className="ml-auto font-mono text-xs text-[var(--color-ink-tertiary)]">
                    {activeJobId.slice(0, 8)}
                  </span>
                )}
              </div>

              {isGenerating && <ProgressBar percent={jobProgress} />}

              {/* Error */}
              {errorMessage && (
                <div
                  role="alert"
                  className="w-full rounded-lg border px-4 py-2 text-sm"
                  style={{
                    borderColor: "color-mix(in srgb, var(--color-danger) 35%, transparent)",
                    backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
                    color: "var(--color-danger)",
                  }}
                >
                  {errorMessage}
                </div>
              )}

              {/* Output image */}
              {outputUrl && (
                <div className="w-full overflow-hidden rounded-xl border border-[var(--color-hairline-strong)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={outputUrl}
                    alt={t("generatedImageAlt")}
                    className="h-auto w-full"
                  />
                </div>
              )}

              {/* Actions */}
              {outputUrl && (
                <div className="flex gap-3">
                  <a
                    href={outputUrl}
                    download
                    className="rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)] px-4 py-1.5 text-sm text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    {t("download")}
                  </a>
                  <button
                    type="button"
                    aria-label={t("copyLink")}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(outputUrl);
                        toast.success(t("copyLinkSuccess"));
                      } catch {
                        toast.error(t("copyLinkFailed"));
                      }
                    }}
                    className="rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)] px-4 py-1.5 text-sm text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    {t("copyLink")}
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right: History (280px) */}
        <aside className="flex shrink-0 flex-col border-t border-[var(--color-hairline)] lg:w-72 lg:border-t-0 lg:border-l lg:overflow-y-auto">
          <div className="sticky top-0 z-10 border-b border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-3">
            <span className="text-xs font-semibold text-[var(--color-ink-subtle)]">
              {t("history")}
            </span>
          </div>

          {historyQuery.isLoading && (
            <p className="p-3 text-xs text-[var(--color-ink-subtle)]">{t("historyLoading")}</p>
          )}
          {!historyQuery.isLoading && historyQuery.data?.items?.length === 0 && (
            <p className="p-3 text-xs text-[var(--color-ink-subtle)]">{t("historyEmpty")}</p>
          )}

          {historyQuery.data?.items?.map((item: HistoryItem) => (
            <button
              key={item.job_id}
              onClick={() => reuseHistory(item)}
              title={t("reuseHint")}
              className="group w-full border-b border-[var(--color-hairline)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-focus)]"
            >
              <div className="flex items-start gap-2">
                {item.thumbnail_url ? (
                  // 缩略图签名 URL 在资产被本地化 offload 后失效——隐藏破图
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbnail_url}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded object-cover"
                    onError={(e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-[var(--color-hairline-strong)] bg-[var(--color-surface-1)]">
                    {item.status === "succeeded" ? (
                      <Check className="size-3.5 text-[var(--color-success)]" />
                    ) : item.status === "failed" ? (
                      <X className="size-3.5 text-[var(--color-danger)]" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin text-[var(--color-ink-tertiary)]" />
                    )}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-[var(--color-ink)] transition-colors group-hover:text-[var(--color-accent)]">
                    {item.prompt.slice(0, 40)}
                    {item.prompt.length > 40 ? "…" : ""}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[var(--color-ink-tertiary)]">
                    {item.status === "succeeded"
                      ? t("statusSucceeded")
                      : item.status === "failed"
                        ? t("statusFailed")
                        : item.status}{" "}
                    · {new Date(item.created_at).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
