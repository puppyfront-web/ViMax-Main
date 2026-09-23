"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Textarea, ConfirmDialog, SkeletonList, EmptyState, useToast, cn } from "@vimax/ui";
import { useTranslations } from "next-intl";
import { WelcomeOverlay } from "@/features/onboarding/WelcomeOverlay";
import { GenerationOverlay } from "@/features/generation/GenerationOverlay";
import { ModelSelect } from "@/features/models/ModelSelect";
import { Sparkles, Film, Palette, BookOpen, UserRound, LayoutGrid, ChevronRight, Clock, Trash2 } from "lucide-react";

type CreateMode = "idea" | "script";

const MODES = {
  idea: { label: "灵感生视频", icon: "💡", desc: "描述创意想法，AI 自动编剧、分镜、生成视频", placeholder: "例如：一个孤独的宇航员在火星上发现了一扇通往异世界的门…", hint: "描述越详细效果越好。可指定美术风格、角色外貌、场景氛围。", submit: "✨ 开始生成" },
  script: { label: "剧本生视频", icon: "📝", desc: "粘贴剧本内容，AI 根据剧本分镜和视频生成", placeholder: "例如：\n第1场 - 咖啡厅 日内\n角色A推门走进咖啡厅…", hint: "建议包含场景标题、角色对话和动作描述。", submit: "🎬 开始生成" },
};

const FEATURES = [
  { icon: Palette, label: "美术风格", desc: "anime/写实/水墨", color: "#c0a8dd" },
  { icon: BookOpen, label: "故事类型", desc: "动作/爱情/科幻", color: "#9fbbe0" },
  { icon: UserRound, label: "角色设计", desc: "AI 自动提取角色", color: "#dfa88f" },
  { icon: LayoutGrid, label: "智能分镜", desc: "自动镜头拆解", color: "#9fc9a2" },
];

export default function HomePage() {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations("home");
  const tc = useTranslations("common");

  const [mode, setMode] = useState<CreateMode>("idea");
  const [input, setInput] = useState("");
  const [canvasName, setCanvasName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  // Generation overlay state — shows AI generation process on home page
  const [generationState, setGenerationState] = useState<{
    canvasId: string;
    conversationId: string;
    prompt: string;
    mode: CreateMode;
  } | null>(null);

  // Model selection state
  const [textModelId, setTextModelId] = useState("");
  const [imageModelId, setImageModelId] = useState("");
  const [videoModelId, setVideoModelId] = useState("");

  // Fetch defaults
  const { data: textModels } = trpc.modelConfig.list.useQuery({ type: "text" }, { staleTime: 60_000 });
  const { data: imageModels } = trpc.modelConfig.list.useQuery({ type: "image" }, { staleTime: 60_000 });
  const { data: videoModels } = trpc.modelConfig.list.useQuery({ type: "video" }, { staleTime: 60_000 });

  // Set default model IDs when data loads
  useEffect(() => {
    const textDef = textModels?.items?.find((m) => m.isDefault);
    if (textDef && !textModelId) setTextModelId(textDef.id);
  }, [textModels, textModelId]);
  useEffect(() => {
    const imgDef = imageModels?.items?.find((m) => m.isDefault);
    if (imgDef && !imageModelId) setImageModelId(imgDef.id);
  }, [imageModels, imageModelId]);
  useEffect(() => {
    const vidDef = videoModels?.items?.find((m) => m.isDefault);
    if (vidDef && !videoModelId) setVideoModelId(vidDef.id);
  }, [videoModels, videoModelId]);

  const createCanvas = trpc.canvas.create.useMutation();
  const createConversation = trpc.chat.createConversation.useMutation();
  const deleteCanvas = trpc.canvas.delete.useMutation();
  const listCanvases = trpc.canvas.list.useQuery({ limit: 20 });
  const utils = trpc.useUtils();

  const config = MODES[mode];
  const projects = listCanvases.data?.items ?? [];

  const handleCreate = async () => {
    if (!input.trim()) return;
    try {
      const name = canvasName.trim() || `${config.label} - ${new Date().toLocaleDateString("zh-CN")}`;
      const canvas = await createCanvas.mutateAsync({ name });
      const conv = await createConversation.mutateAsync({ canvasId: canvas.canvas_id });
      // Open generation overlay instead of navigating immediately
      setGenerationState({
        canvasId: canvas.canvas_id,
        conversationId: conv.conversation.id,
        prompt: input.trim(),
        mode,
      });
      setInput("");
      setCanvasName("");
    } catch { toast.error(t("createFailed")); }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try { await deleteCanvas.mutateAsync({ canvas_id: deleteTarget.id }); utils.canvas.list.invalidate(); toast.success(t("deleteSuccess", { name: deleteTarget.name })); }
    catch { toast.error(t("deleteFailed")); }
    setDeleteTarget(null);
  };

  return (
    <>
      <div className="flex flex-col min-h-full bg-[var(--color-canvas)]">
        {/* ═══ Hero — Cursor editorial voice × Linear surface ═══ */}
        <section className="relative flex flex-col items-center px-6 pt-28 pb-16 overflow-hidden">
          <div className="absolute inset-0 bg-[var(--gradient-hero)] pointer-events-none" />
          <div className="absolute top-[-5%] left-1/2 -translate-x-1/2 w-[900px] h-[450px] bg-[var(--color-accent)]/4 rounded-full blur-[200px] pointer-events-none" />

          <div className="relative z-10 text-center max-w-[680px]">
            {/* Eyebrow — Linear-style eyebrow with positive tracking */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-8 rounded-full border border-[var(--color-hairline)] bg-[var(--color-surface-1)] text-[11px] font-semibold text-[var(--color-ink-subtle)] tracking-[var(--tracking-eyebrow)] uppercase">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-50" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent)]" />
              </span>
              {t("badge")}
            </div>

            {/* Display — Cursor editorial: 400-600 weight, negative tracking */}
            <h1 className="text-[var(--hero-title-size)] font-[var(--hero-title-weight)] text-[var(--color-ink)] leading-[var(--hero-title-leading)] tracking-[var(--hero-title-tracking)]">
              {t("title")}
            </h1>
            <p className="text-[var(--text-body-lg)] text-[var(--color-ink-muted)] mt-5 max-w-[520px] mx-auto leading-[var(--leading-relaxed)]">
              {t("subtitle")}
            </p>
          </div>

          {/* Mode toggle — Linear pill segment */}
          <div className="relative z-10 mt-12 inline-flex bg-[var(--color-surface-1)] rounded-full p-1 border border-[var(--color-hairline)]">
            {(Object.entries(MODES) as [CreateMode, typeof config][]).map(([m, mc]) => {
              const active = mode === m;
              return (
                <button key={m} onClick={() => setMode(m)} className={cn(
                  "relative flex items-center gap-2.5 px-6 py-2.5 rounded-full text-sm font-medium transition-all duration-200",
                  active ? "bg-[var(--color-accent)] text-[var(--color-accent-on)] shadow-[var(--shadow-accent-sm)]" : "text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]",
                )}>
                  <span className="text-base">{mc.icon}</span>
                  {mc.label}
                </button>
              );
            })}
          </div>

          <p className="relative z-10 text-xs text-[var(--color-ink-subtle)] text-center mt-5 max-w-[440px] leading-relaxed">{config.desc}</p>

          {/* Model selectors */}
          <div className="relative z-10 w-full max-w-[680px] mt-6 flex items-center gap-3 justify-center">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-[var(--color-ink-subtle)]">💬</span>
              <ModelSelect
                type="text"
                value={textModelId}
                onChange={setTextModelId}
                placeholder="选择文本模型"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-[var(--color-ink-subtle)]">🖼️</span>
              <ModelSelect
                type="image"
                value={imageModelId}
                onChange={setImageModelId}
                placeholder="选择图像模型"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-[var(--color-ink-subtle)]">▶️</span>
              <ModelSelect
                type="video"
                value={videoModelId}
                onChange={setVideoModelId}
                placeholder="选择视频模型"
              />
            </div>
          </div>

          {/* Input area — Linear card */}
          <div className="relative z-10 w-full max-w-[680px] mt-8 space-y-3">
            <div>
              <label className="text-[11px] font-medium text-[var(--color-ink-subtle)] block mb-2 ml-2">{t("canvasNameLabel")}</label>
              <Input value={canvasName} onChange={(e) => setCanvasName(e.target.value)} placeholder={t("canvasNamePlaceholder")} />
            </div>

            {/* Prompt card — Linear: hairline border, no shadow */}
            <div className="relative rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface-1)] transition-all duration-200 hover:border-[var(--color-hairline-strong)] group">
              <div className="absolute top-0 left-4 right-4 h-px bg-[var(--gradient-brand)] opacity-0 group-hover:opacity-40 transition-opacity duration-500 rounded-full" />
              <div className="p-5">
                <Textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleCreate(); }} placeholder={config.placeholder} rows={mode === "idea" ? 3 : 8} className="min-h-[80px] border-0 bg-transparent resize-none focus-visible:ring-0 p-0 text-sm leading-relaxed placeholder:text-[var(--color-ink-tertiary)]" style={mode === "script" ? { minHeight: 180 } : undefined} />
                <div className="flex items-center justify-between mt-5 pt-4 border-t border-[var(--color-hairline)]">
                  <div className="flex items-center gap-2">
                    <kbd className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-md bg-[var(--color-surface-2)] text-[10px] font-mono text-[var(--color-ink-subtle)] border border-[var(--color-hairline)]">Ctrl + ↵</kbd>
                    <span className="text-[11px] text-[var(--color-ink-tertiary)]">{t("ctrlEnterHint")}</span>
                  </div>
                  <Button onClick={handleCreate} loading={createCanvas.isPending} disabled={!input.trim()} size="lg" leftIcon={<Sparkles className="size-3.5" />}>{config.submit}</Button>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-[var(--color-ink-subtle)] ml-2 leading-relaxed opacity-60">{config.hint}</p>
          </div>

          {/* Feature cards — Cursor AI pastel icons on Linear cards */}
          <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-[680px] mt-12">
            {FEATURES.map((item) => { const Icon = item.icon; return (
              <div key={item.label} className="group flex flex-col items-center gap-3 p-5 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface-1)] hover:border-[var(--color-hairline-strong)] transition-all duration-200 cursor-pointer">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl group-hover:scale-110 transition-transform duration-200" style={{ backgroundColor: `${item.color}18` }}>
                  <Icon className="size-4.5" style={{ color: item.color }} />
                </div>
                <div className="text-center">
                  <div className="text-xs font-semibold text-[var(--color-ink)]">{item.label}</div>
                  <div className="text-[10px] text-[var(--color-ink-subtle)] mt-0.5">{item.desc}</div>
                </div>
              </div>
            )})}
          </div>
        </section>

        {/* ═══ Projects — Linear card grid ═══ */}
        <section className="flex flex-col items-center px-6 pb-24 max-w-[900px] mx-auto w-full">
          {listCanvases.isLoading ? (
            <div className="w-full max-w-[680px]"><SkeletonList count={3} /></div>
          ) : projects.length > 0 ? (
            <div className="w-full max-w-[680px]">
              <div className="flex items-end justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--color-ink)] tracking-tight">{t("recentProjects")}</h2>
                  <p className="text-xs text-[var(--color-ink-subtle)] mt-1">{t("xProjects", { count: projects.length })}</p>
                </div>
                <a href="/explore" className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:opacity-80 transition-opacity no-underline">查看全部 <ChevronRight className="size-3" /></a>
              </div>
              <div className="grid gap-2">
                {projects.map((p) => (
                  <div key={p.canvas_id} className="group flex items-center gap-4 px-5 py-3.5 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface-1)] hover:border-[var(--color-hairline-strong)] hover:bg-[var(--color-surface-2)] transition-all duration-200">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent-subtle)] shrink-0 group-hover:bg-[var(--color-accent-muted)] transition-colors">
                      <Film className="size-4 text-[var(--color-accent)]" />
                    </div>
                    <a href={`/canvas/${p.canvas_id}`} className="flex-1 flex items-center justify-between no-underline text-inherit min-w-0">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--color-ink)] truncate group-hover:text-[var(--color-accent)] transition-colors">{p.name}</div>
                        <div className="flex items-center gap-3 text-[11px] text-[var(--color-ink-subtle)] mt-0.5">
                          <span>{p.node_count} 节点</span><span className="w-1 h-1 rounded-full bg-[var(--color-ink-tertiary)]" />
                          <span className="flex items-center gap-1"><Clock className="size-2.5" />{new Date(p.updated_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      </div>
                      <ChevronRight className="size-4 text-[var(--color-ink-tertiary)] opacity-0 group-hover:opacity-100 transition-all" />
                    </a>
                    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget({ id: p.canvas_id, name: p.name }); }} title={t("confirmDelete")} className="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-ink-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] transition-colors shrink-0 opacity-0 group-hover:opacity-100">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : <EmptyState title={t("noProjects")} description={t("noProjectsDesc")} />}
        </section>

        <footer className="flex items-center justify-center gap-6 py-6 border-t border-[var(--color-hairline)] bg-[var(--color-surface-1)] shrink-0 mt-auto">
          <span className="text-[11px] text-[var(--color-ink-subtle)]">{t("footer")}</span>
          <span className="w-1 h-1 rounded-full bg-[var(--color-ink-tertiary)] opacity-40" />
          <span className="text-[11px] text-[var(--color-ink-tertiary)]">{t("footerPowered")}</span>
        </footer>
      </div>

      <WelcomeOverlay />
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={handleConfirmDelete} title={t("confirmDelete")} description={t("confirmDeleteDesc", { name: deleteTarget?.name ?? "" })} confirmLabel={tc("delete")} cancelLabel={tc("cancel")} variant="danger" />

      {/* Generation overlay — shows AI streaming response after clicking generate */}
      {generationState && (
        <GenerationOverlay
          open={!!generationState}
          canvasId={generationState.canvasId}
          conversationId={generationState.conversationId}
          prompt={generationState.prompt}
          mode={generationState.mode}
          modelId={textModelId || undefined}
          onClose={() => setGenerationState(null)}
          onNavigate={(canvasId) => {
            setGenerationState(null);
            utils.canvas.list.invalidate();
            router.push(`/canvas/${canvasId}`);
          }}
        />
      )}
    </>
  );
}
