"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageSize } from "@vimax/contracts";
import { trpc } from "@/lib/trpc/client";

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

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "t2i" | "i2i";
  onChange: (m: "t2i" | "i2i") => void;
}) {
  return (
    <div className="flex rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      {(["t2i", "i2i"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-4 py-1.5 text-sm font-medium transition ${
            mode === m
              ? "bg-[var(--color-accent)] text-white"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          {m === "t2i" ? "文生图" : "图生图"}
        </button>
      ))}
    </div>
  );
}

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
              onClick={() => onRemove(id)}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center"
            >
              ×
            </button>
            图
          </div>
        ))}
        {assetIds.length < 4 && (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="w-14 h-14 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)] hover:border-[var(--color-accent)] transition text-2xl disabled:opacity-50"
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
  const [mode, setMode] = useState<"t2i" | "i2i">("t2i");
  const [prompt, setPrompt] = useState("");
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
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="h-12 flex items-center px-4 border-b border-[var(--color-border)] shrink-0">
        <h1 className="text-sm font-semibold tracking-wide">
          ViMax Studio · 生图工坊
        </h1>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Parameters (320px) */}
        <aside className="w-80 shrink-0 border-r border-[var(--color-border)] flex flex-col p-4 gap-4 overflow-y-auto">
          <ModeToggle mode={mode} onChange={setMode} />

          <div>
            <label className="text-xs text-[var(--color-text-muted)] mb-1 block">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === "t2i"
                  ? "描述你想要的画面…"
                  : "描述你想要的画面，可引用参考图的元素…"
              }
              rows={4}
              className="w-full rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
            />
          </div>

          <div>
            <label className="text-xs text-[var(--color-text-muted)] mb-1 block">
              模型
            </label>
            <ModelSelect value={modelId} onChange={setModelId} />
          </div>

          <div>
            <label className="text-xs text-[var(--color-text-muted)] mb-1 block">
              尺寸
            </label>
            <SizeSelect value={size} onChange={setSize} sizes={availableSizes} />
          </div>

          {mode === "i2i" && (
            <div>
              <label className="text-xs text-[var(--color-text-muted)] mb-1 block">
                参考图 (最多 4 张)
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
            className="mt-auto w-full rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white py-2.5 text-sm font-semibold transition"
          >
            {isGenerating ? "生成中…" : "生成"}
          </button>
        </aside>

        {/* Center: Preview */}
        <main className="flex-1 flex flex-col items-center justify-center p-6 overflow-y-auto">
          {!activeJobId && (
            <p className="text-[var(--color-text-muted)] text-sm">
              输入 Prompt，点击「生成」开始
            </p>
          )}

          {activeJobId && (
            <div className="w-full max-w-2xl flex flex-col items-center gap-4">
              {/* Status bar */}
              <div className="w-full flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    jobStatus === "succeeded" || jobStatus === "cached"
                      ? "bg-green-400"
                      : jobStatus === "failed"
                        ? "bg-red-400"
                        : "bg-[var(--color-accent)] animate-pulse"
                  }`}
                />
                <span className="text-sm text-[var(--color-text-muted)]">
                  {jobStatus === "queued" && "排队中…"}
                  {jobStatus === "running" && `生成中 ${jobProgress}%`}
                  {jobStatus === "succeeded" && "已完成"}
                  {jobStatus === "cached" && "缓存命中"}
                  {jobStatus === "failed" && "失败"}
                </span>
                {activeJobId && (
                  <span className="text-xs text-[var(--color-text-muted)] ml-auto font-mono">
                    {activeJobId.slice(0, 8)}
                  </span>
                )}
              </div>

              {isGenerating && <ProgressBar percent={jobProgress} />}

              {/* Error */}
              {errorMessage && (
                <div className="w-full rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400">
                  {errorMessage}
                </div>
              )}

              {/* Output image */}
              {outputUrl && (
                <div className="w-full rounded-xl overflow-hidden border border-[var(--color-border)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={outputUrl}
                    alt="Generated"
                    className="w-full h-auto"
                  />
                </div>
              )}

              {/* Actions */}
              {outputUrl && (
                <div className="flex gap-3">
                  <a
                    href={outputUrl}
                    download
                    className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-4 py-1.5 text-sm hover:border-[var(--color-accent)] transition"
                  >
                    下载
                  </a>
                  <button
                    onClick={() => navigator.clipboard.writeText(outputUrl)}
                    className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-4 py-1.5 text-sm hover:border-[var(--color-accent)] transition"
                  >
                    复制链接
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right: History (280px) */}
        <aside className="w-72 shrink-0 border-l border-[var(--color-border)] flex flex-col overflow-y-auto">
          <div className="sticky top-0 bg-[var(--color-bg)] px-3 py-3 border-b border-[var(--color-border)]">
            <span className="text-xs font-semibold text-[var(--color-text-muted)]">
              生成历史
            </span>
          </div>

          {historyQuery.isLoading && (
            <p className="text-xs text-[var(--color-text-muted)] p-3">加载中…</p>
          )}
          {!historyQuery.isLoading && historyQuery.data?.items?.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] p-3">暂无记录</p>
          )}

          {historyQuery.data?.items?.map((item: HistoryItem) => (
            <button
              key={item.job_id}
              onClick={() => reuseHistory(item)}
              className="w-full text-left px-3 py-2.5 border-b border-[var(--color-border)] hover:bg-[var(--color-surface)] transition group"
            >
              <div className="flex items-start gap-2">
                {item.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbnail_url}
                    alt=""
                    className="w-10 h-10 rounded object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-[var(--color-surface)] border border-[var(--color-border)] shrink-0 flex items-center justify-center text-[10px] text-[var(--color-text-muted)]">
                    {item.status === "succeeded"
                      ? "✓"
                      : item.status === "failed"
                        ? "✗"
                        : "…"}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs truncate text-[var(--color-text)] group-hover:text-[var(--color-accent-hover)]">
                    {item.prompt.slice(0, 40)}
                    {item.prompt.length > 40 ? "…" : ""}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {item.status} · {new Date(item.created_at).toLocaleTimeString("zh-CN")}
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
