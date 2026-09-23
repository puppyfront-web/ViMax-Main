"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { PageContainer, Badge, EmptyState, SkeletonList, cn } from "@vimax/ui";
import { Search, Eye, Sparkles, Play, Film, Image, Grid3X3, Clock, TrendingUp } from "lucide-react";

// ── Mock Data for Explore ──────────────────────────────────────────

interface ExploreItem {
  id: string;
  title: string;
  author: string;
  type: "video" | "image" | "project";
  thumbnail: string;
  views: number;
  tags: string[];
  createdAt: string;
}

const MOCK_ITEMS: ExploreItem[] = [
  { id: "1", title: "赛博朋克城市 - AI 短片", author: "ViMax AI", type: "video", thumbnail: "🌆", views: 12400, tags: ["科幻", "短片", "3D"], createdAt: "2026-06-01" },
  { id: "2", title: "水墨山水动画", author: "水墨工作室", type: "video", thumbnail: "🏔️", views: 8900, tags: ["水墨", "中国传统", "2D"], createdAt: "2026-06-02" },
  { id: "3", title: "产品宣传片模板", author: "商业创作", type: "project", thumbnail: "📦", views: 6700, tags: ["模板", "商业", "宣传"], createdAt: "2026-06-03" },
  { id: "4", title: "AI 角色设计集", author: "角色工坊", type: "image", thumbnail: "👤", views: 15200, tags: ["角色", "设计", "动漫"], createdAt: "2026-06-04" },
  { id: "5", title: "科幻太空站场景", author: "星际创作", type: "image", thumbnail: "🚀", views: 11300, tags: ["科幻", "场景", "概念"], createdAt: "2026-06-05" },
  { id: "6", title: "日式动画短片", author: "AnimeAI", type: "video", thumbnail: "🎌", views: 21000, tags: ["动画", "日式", "短片"], createdAt: "2026-05-28" },
  { id: "7", title: "奇幻森林冒险", author: "奇幻工作室", type: "video", thumbnail: "🌲", views: 9800, tags: ["奇幻", "自然", "冒险"], createdAt: "2026-05-30" },
  { id: "8", title: "UI/UX 概念设计", author: "设计思维", type: "image", thumbnail: "🎨", views: 5600, tags: ["设计", "UI", "概念"], createdAt: "2026-05-31" },
  { id: "9", title: "恐怖短片 - 午夜", author: "暗夜创作", type: "video", thumbnail: "👻", views: 7800, tags: ["恐怖", "短片", "氛围"], createdAt: "2026-05-29" },
  { id: "10", title: "美食广告模板", author: "味觉视觉", type: "project", thumbnail: "🍜", tags: ["美食", "商业", "模板"], views: 4500, createdAt: "2026-05-27" },
  { id: "11", title: "赛博忍者角色", author: "忍者工坊", type: "image", thumbnail: "🥷", views: 13500, tags: ["角色", "赛博朋克", "日本"], createdAt: "2026-05-26" },
  { id: "12", title: "极光下的城市", author: "北极光AI", type: "image", thumbnail: "🌌", views: 19200, tags: ["风景", "极光", "城市"], createdAt: "2026-05-25" },
];

type FilterType = "all" | "video" | "image" | "project";
type SortType = "latest" | "popular" | "trending";

const TYPE_LABELS: Record<FilterType, string> = { all: "全部", video: "视频", image: "图片", project: "项目" };
const TYPE_ICONS: Record<FilterType, React.ReactNode> = { all: <Grid3X3 className="size-3.5" />, video: <Film className="size-3.5" />, image: <Image className="size-3.5" />, project: <Sparkles className="size-3.5" /> };
const SORT_LABELS: Record<SortType, string> = { latest: "最新", popular: "最热", trending: "趋势" };
const SORT_ICONS: Record<SortType, React.ReactNode> = { latest: <Clock className="size-3.5" />, popular: <Eye className="size-3.5" />, trending: <TrendingUp className="size-3.5" /> };

// ── Page ────────────────────────────────────────────────────────────

export default function ExplorePage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [sort, setSort] = useState<SortType>("latest");

  const filtered = useMemo(() => {
    let items = [...MOCK_ITEMS];
    if (typeFilter !== "all") items = items.filter((i) => i.type === typeFilter);
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(
        (i) => i.title.toLowerCase().includes(s) || i.author.toLowerCase().includes(s) || i.tags.some((t) => t.toLowerCase().includes(s)),
      );
    }
    switch (sort) {
      case "popular": items.sort((a, b) => b.views - a.views); break;
      case "trending": items.sort((a, b) => b.views / (Date.now() - new Date(b.createdAt).getTime()) - a.views / (Date.now() - new Date(a.createdAt).getTime())); break;
      default: items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return items;
  }, [search, typeFilter, sort]);

  return (
    <PageContainer maxWidth="xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--color-text)] tracking-tight">发现</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">浏览社区创作的精彩视频和项目，获取灵感</p>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--color-text-dim)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索作品、创作者…"
            className="w-full h-10 pl-9 pr-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/30 focus-visible:border-[var(--color-accent)] transition-all"
          />
        </div>

        <div className="flex gap-1.5">
          {(Object.entries(TYPE_LABELS) as [FilterType, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTypeFilter(k)}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                typeFilter === k
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-elevated)]",
              )}
            >
              {TYPE_ICONS[k]}
              {label}
            </button>
          ))}
        </div>

        <div className="flex gap-0.5 ml-auto">
          {(Object.entries(SORT_LABELS) as [SortType, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={cn(
                "flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors",
                sort === k ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              )}
            >
              {SORT_ICONS[k]}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Gallery Grid */}
      {filtered.length === 0 ? (
        <EmptyState title="没有找到匹配的作品" description="尝试调整筛选条件或搜索关键词" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => router.push(`/canvas/${item.id}`)}
              className="group text-left rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-border-hover)] hover:shadow-md transition-all duration-200"
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-[var(--color-bg)] flex items-center justify-center text-5xl relative overflow-hidden">
                <span className="group-hover:scale-110 transition-transform duration-300">{item.thumbnail}</span>
                {item.type === "video" && (
                  <div className="absolute bottom-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium">
                    <Play className="size-2.5 fill-white" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3 space-y-1.5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">
                  {item.title}
                </h3>
                <p className="text-xs text-[var(--color-text-muted)]">作者 {item.author}</p>
                <div className="flex items-center justify-between">
                  <div className="flex gap-1 flex-wrap">
                    {item.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-dim)]">
                    <Eye className="size-3" />
                    {item.views > 1000 ? `${(item.views / 1000).toFixed(1)}k` : item.views}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
