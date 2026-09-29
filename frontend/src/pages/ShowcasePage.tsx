import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpDown, Check, Grid2x2, Grid3x3, LayoutGrid, ListFilter, Monitor, Moon, Plus, Rows3, Search, Settings, Sun, X,
} from "lucide-react";
import { api, type Item, type Option } from "../api";
import { ItemCard } from "../components/ItemCard";
import { SortableSeriesGrid } from "../components/SortableSeriesGrid";
import { cx, Dialog, IconButton, useToast } from "../components/ui";
import {
  searchText, useDensity, useIsDesktop, useItems, useLookups, useMeta, useTheme, type Density,
} from "../hooks";

const GRID: Record<Density, string> = {
  s: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2",
  m: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4",
  l: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6",
};


/** URL id-list param: absent = all selected, "none" = explicitly cleared. */
function parseIds(v: string | null): Set<number> | null {
  return v === null ? null : new Set(v.split(",").map(Number).filter((n) => !Number.isNaN(n)));
}

export default function ShowcasePage() {
  const { data: meta } = useMeta();
  const { data: items, isLoading, error } = useItems();
  const lk = useLookups(meta);
  const [params, setParams] = useSearchParams();
  const [density, setDensity] = useDensity();
  const theme = useTheme();
  const isDesktop = useIsDesktop();
  const [drawer, setDrawer] = useState(false);
  const [arranging, setArranging] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  /** Save a new in-series order. `visibleIds` may be a filtered subset: hidden items keep their slots. */
  const reorder = async (seriesId: number, visibleIds: number[]) => {
    const current = (qc.getQueryData<Item[]>(["items"]) ?? []).filter((i) => i.series_id === seriesId).map((i) => i.id);
    const shown = new Set(visibleIds);
    let k = 0;
    const merged = current.map((id) => (shown.has(id) ? visibleIds[k++] : id));
    const pos = new Map(merged.map((id, i) => [id, i + 1]));
    qc.setQueryData<Item[]>(["items"], (old) =>
      old
        ?.map((it) => (pos.has(it.id) ? { ...it, sort: pos.get(it.id)! } : it))
        .sort((a, b) => a.sort - b.sort || a.id - b.id),
    );
    try {
      await api.orderSeriesItems(seriesId, merged);
    } catch (e) {
      toast(`排序未保存：${(e as Error).message}`, "err");
      qc.invalidateQueries({ queryKey: ["items"] });
    }
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // The search box keeps its own text. Writing every keystroke straight into the URL re-rendered
  // the page mid-composition and broke IMEs (Microsoft Pinyin committed "xxixin心…").
  // So: never sync while composing, and debounce ordinary typing.
  const [boxText, setBoxText] = useState(() => params.get("q") ?? "");
  const composing = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pushSearch = (v: string, delay = 200) => {
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => update({ q: v.trim() ? v : null }), delay);
  };

  const groupId = params.get("g") ? Number(params.get("g")) : null;
  const q = params.get("q") ?? "";
  const status = params.get("st") ?? "";
  const seriesParam = params.get("s");
  const kindParam = params.get("k");
  const selectedSeries = useMemo(() => parseIds(seriesParam), [seriesParam]);
  const selectedKinds = useMemo(() => parseIds(kindParam), [kindParam]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!composing.current && q !== boxText.trim() && !(q === "" && !boxText.trim())) setBoxText(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => () => clearTimeout(syncTimer.current), []);

  const statusOk = useMemo(() => (status ? (i: Item) => i.status === status : () => true), [status]);

  const itemGroups = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const it of items ?? []) {
      m.set(it.id, new Set(it.kind_ids.map((k) => lk.kind.get(k)?.group_id).filter((g): g is number => g != null)));
    }
    return m;
  }, [items, lk]);

  const base = useMemo(() => (items ?? []).filter(statusOk), [items, statusOk]);

  // tabs: only groups that currently hold items
  const tabs = useMemo(() => {
    const used = new Set<number>();
    base.forEach((it) => itemGroups.get(it.id)?.forEach((g) => used.add(g)));
    return (meta?.groups ?? []).filter((g) => used.has(g.id));
  }, [base, itemGroups, meta]);

  const seriesCounts = useMemo(() => {
    const c = new Map<number, number>();
    base.forEach((it) => c.set(it.series_id, (c.get(it.series_id) ?? 0) + 1));
    return c;
  }, [base]);
  const seriesList = useMemo(
    () => (meta?.series ?? []).filter((s) => seriesCounts.has(s.id)),
    [meta, seriesCounts],
  );

  // second-level kinds of the selected group, with counts
  const kindCounts = useMemo(() => {
    const c = new Map<number, number>();
    if (groupId === null) return c;
    base.forEach((it) =>
      it.kind_ids.forEach((k) => {
        if (lk.kind.get(k)?.group_id === groupId) c.set(k, (c.get(k) ?? 0) + 1);
      }),
    );
    return c;
  }, [base, groupId, lk]);
  const kindList = useMemo(
    () => (meta?.kinds ?? []).filter((k) => kindCounts.has(k.id)),
    [meta, kindCounts],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return base.filter((it) => {
      if (groupId !== null) {
        if (!itemGroups.get(it.id)?.has(groupId)) return false;
        if (selectedKinds && !it.kind_ids.some((k) => selectedKinds.has(k))) return false;
      } else if (selectedSeries && !selectedSeries.has(it.series_id)) return false;
      if (needle && !searchText(it, lk).includes(needle)) return false;
      return true;
    });
  }, [base, groupId, selectedSeries, selectedKinds, q, itemGroups, lk]);

  const sections = useMemo(() => {
    const by = new Map<number, Item[]>();
    visible.forEach((it) => {
      const arr = by.get(it.series_id) ?? [];
      arr.push(it);
      by.set(it.series_id, arr);
    });
    return (meta?.series ?? [])
      .filter((s) => by.has(s.id))
      .map((s) => ({ series: s, items: by.get(s.id)! }));
  }, [visible, meta]);

  const totalQty = visible.reduce((n, i) => n + i.quantity, 0);

  // 「全部」→ sidebar filters series; a group tab → sidebar filters that group's kinds
  const byKind = groupId !== null;
  const filterKey = byKind ? "k" : "s";
  const filterLabel = byKind ? "种类" : "系列";
  const filterOptions = byKind ? kindList : seriesList;
  const filterSelected = byKind ? selectedKinds : selectedSeries;

  const toggleFilter = (id: number) => {
    const next = new Set(filterSelected ?? filterOptions.map((o) => o.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ [filterKey]: next.size === filterOptions.length ? null : [...next].join(",") || "none" });
  };

  const sidebar = (
    <FilterList
      title={filterLabel}
      options={filterOptions}
      counts={byKind ? kindCounts : seriesCounts}
      selected={filterSelected}
      onToggle={toggleFilter}
      onAll={() => update({ [filterKey]: null })}
      onNone={() => update({ [filterKey]: "none" })}
    />
  );

  const ThemeIcon = theme.pref === "system" ? Monitor : theme.pref === "light" ? Sun : Moon;

  return (
    <div className="min-h-dvh">
      {/* ── header ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 safe-top safe-x app-bar">
        <div className="mx-auto max-w-[1600px] px-4 md:px-6">
          {/* mobile search: the field overlays the row on a transparent background (the bar's gradient
              shows through) and the other controls are hidden instead of painted over */}
          <div className={cx("relative flex items-center gap-2 h-14", searchOpen && !isDesktop && "[&>*:not(.search-slot)]:invisible")}>
            <Link to="/" onClick={() => setParams({}, { replace: true })} className="flex items-center gap-2 min-w-0">
              {meta?.brand.logo && (
                <img src={meta.brand.logo} alt="" aria-hidden className="h-10 md:h-11 w-auto shrink-0 -ml-1 drop-shadow-[0_1px_2px_rgb(0_0_0/0.25)]" />
              )}
              <h1 className="font-display font-bold text-lg sm:text-xl md:text-2xl tracking-wide whitespace-nowrap truncate">
                {meta?.settings.site_title ?? " "}
              </h1>
              {meta?.settings.site_subtitle && (
                <span className="hidden sm:inline text-[13px] text-muted tracking-[0.2em] whitespace-nowrap">{meta.settings.site_subtitle}</span>
              )}
            </Link>
            <div className="flex-1" />
            <div className={cx("search-slot items-center", isDesktop ? "flex" : searchOpen ? "flex absolute inset-0 z-10" : "hidden")}>
              <div className="relative w-full md:w-64">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  ref={searchRef}
                  value={boxText}
                  onChange={(e) => {
                    setBoxText(e.target.value);
                    if (!composing.current) pushSearch(e.target.value);
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                    clearTimeout(syncTimer.current);
                  }}
                  onCompositionEnd={(e) => {
                    composing.current = false;
                    setBoxText(e.currentTarget.value);
                    pushSearch(e.currentTarget.value, 0);
                  }}
                  placeholder="搜索名称、角色、系列…"
                  className="w-full h-9 rounded-full bg-surface border border-line pl-9 pr-8 text-sm outline-none focus:border-gold/60"
                />
                {(boxText || !isDesktop) && (
                  <button
                    aria-label="清除搜索"
                    onClick={() => {
                      clearTimeout(syncTimer.current);
                      setBoxText("");
                      update({ q: null });
                      if (!isDesktop) setSearchOpen(false);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            {!isDesktop && (
              <IconButton label="搜索" onClick={() => setSearchOpen(true)}>
                <Search size={19} />
              </IconButton>
            )}
            <DensitySwitch value={density} onChange={setDensity} />
            <IconButton label="主题" onClick={theme.cycle}>
              <ThemeIcon size={18} />
            </IconButton>
            {isDesktop && (
              <Link to="/bulk" aria-label="批量添加" title="批量添加" className="inline-flex items-center justify-center size-10 rounded-full text-ink/80 hover:bg-ink/5">
                <Rows3 size={18} />
              </Link>
            )}
            <Link to="/settings" aria-label="设置" title="设置" className="inline-flex items-center justify-center size-10 rounded-full text-ink/80 hover:bg-ink/5">
              <Settings size={18} />
            </Link>
          </div>

          {/* tabs */}
          <nav className="flex items-center gap-1 -mx-1 overflow-x-auto no-scrollbar pb-2">
            {!isDesktop && (
              <button
                onClick={() => setDrawer(true)}
                className={cx(
                  "shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-full text-sm border",
                  filterSelected ? "border-accent/50 text-accent" : "border-line text-muted",
                )}
              >
                <ListFilter size={14} /> {filterLabel}{filterSelected ? ` ${filterSelected.size}` : ""}
              </button>
            )}
            <Tab active={groupId === null} onClick={() => update({ g: null, k: null })}>全部</Tab>
            {tabs.map((g) => (
              <Tab key={g.id} active={groupId === g.id} onClick={() => update({ g: String(g.id), s: null, k: null })}>
                {g.name}
              </Tab>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 md:px-6 flex gap-8">
        {isDesktop && (
          <aside className="w-56 shrink-0 sticky top-[104px] self-start max-h-[calc(100dvh-120px)] overflow-y-auto py-5 no-scrollbar">
            {sidebar}
          </aside>
        )}

        <main className="flex-1 min-w-0 pb-28">
          <div className="flex items-center justify-between py-3 text-xs text-muted">
            <span className="tabular-nums">
              {visible.length} 款 · {totalQty} 件
            </span>
            <span className="flex-1" />
            <button
              onClick={() => setArranging((v) => !v)}
              aria-pressed={arranging}
              className={cx(
                "mr-2 inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs",
                arranging ? "border-accent bg-accent text-accent-ink" : "border-line text-muted hover:text-ink",
              )}
            >
              {arranging ? <Check size={13} /> : <ArrowUpDown size={13} />}
              {arranging ? "完成整理" : "整理"}
            </button>
            <select
              value={status}
              onChange={(e) => update({ st: e.target.value })}
              className="bg-transparent text-xs text-muted border border-line rounded-full h-7 px-2 outline-none"
              aria-label="状态筛选"
            >
              <option value="">全部状态</option>
              {meta?.statuses.map((s) => (
                <option key={s} value={s}>
                  仅{s}
                </option>
              ))}
            </select>
          </div>

          {arranging && (
            <div className="sticky top-[calc(6.5rem+var(--sat))] z-20 mb-4 flex items-center gap-3 rounded-xl border border-gold/50 bg-surface/95 backdrop-blur px-4 py-2.5 shadow-[var(--shadow)]">
              <ArrowUpDown size={16} className="text-gold shrink-0" />
              <p className="flex-1 text-sm leading-snug">
                {isDesktop ? "拖动卡片调整同系列内的顺序" : "长按拖动卡片"}
                <span className="text-muted">，松手即保存</span>
              </p>
              <button onClick={() => setArranging(false)} className="shrink-0 h-8 px-3 rounded-full bg-accent text-accent-ink text-sm">
                完成
              </button>
            </div>
          )}

          {error && <p className="py-20 text-center text-accent">加载失败：{String((error as Error).message)}</p>}
          {isLoading && <SkeletonGrid density={density} />}
          {!isLoading && !error && sections.length === 0 && (
            <div className="py-24 text-center text-muted">
              <p className="font-display text-lg text-ink/80">展柜空空</p>
              <p className="mt-2 text-sm">
                {items?.length ? "没有符合条件的谷子" : <>还没有谷子，点右下角 ＋ 添加，或在 <Link className="text-accent underline" to="/settings?tab=import">设置</Link> 中导入 Excel</>}
              </p>
            </div>
          )}

          <div className="space-y-8 md:space-y-10">
            {sections.map(({ series, items: its }, i) => (
              <section key={series.id} aria-label={series.name}>
                {/* ── 展区标题 ── centred in the divider; falls back to the series name */}
                <div className={cx("flex items-center gap-3 md:gap-4", i > 0 ? "mb-4 md:mb-5" : "mb-3 md:mb-4")}>
                  <div className="gold-rule flex-1" />
                  <h2 className="max-w-[70%] truncate font-display text-[13px] md:text-[15px] tracking-[0.18em] text-gold">
                    {series.section_title || series.name}
                  </h2>
                  <div className="gold-rule flex-1" />
                </div>
                {arranging ? (
                  <>
                    <SortableSeriesGrid
                      items={its}
                      lk={lk}
                      density={density}
                      gridClass={GRID[density]}
                      onReorder={(ids) => reorder(series.id, ids)}
                    />
                  </>
                ) : (
                  <div className={cx("grid", GRID[density])}>
                    {its.map((it) => (
                      <ItemCard key={it.id} item={it} lk={lk} density={density} modal={isDesktop} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </main>
      </div>

      <Link
        to="/add"
        aria-label="添加谷子"
        hidden={arranging}
        className="fab-theme fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-30 size-14 rounded-full grid place-items-center hover:brightness-110 transition"
      >
        <Plus size={26} />
      </Link>

      <Dialog open={drawer && !isDesktop} onClose={() => setDrawer(false)} title={`选择${filterLabel}`}>
        <div className="px-5 pb-6">{sidebar}</div>
      </Dialog>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "shrink-0 relative h-8 px-3 rounded-full text-sm transition-colors whitespace-nowrap",
        active ? "bg-ink text-canvas" : "text-muted hover:text-ink hover:bg-ink/5",
      )}
    >
      {children}
    </button>
  );
}

function DensitySwitch({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  const opts: [Density, typeof Grid3x3, string][] = [
    ["s", Grid3x3, "小格"],
    ["m", LayoutGrid, "中格"],
    ["l", Grid2x2, "大格"],
  ];
  return (
    <div className="hidden sm:flex items-center rounded-full border border-line p-0.5">
      {opts.map(([d, Icon, label]) => (
        <button
          key={d}
          aria-label={label}
          title={label}
          onClick={() => onChange(d)}
          className={cx("size-8 grid place-items-center rounded-full", value === d ? "bg-ink text-canvas" : "text-muted hover:text-ink")}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

function FilterList({
  title,
  options,
  counts,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  title: string;
  options: Option[];
  counts: Map<number, number>;
  selected: Set<number> | null;
  onToggle: (id: number) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] tracking-[0.2em] text-muted">{title}</span>
        <span className="flex gap-2 text-xs">
          <button className="text-muted hover:text-accent" onClick={onAll}>全选</button>
          <button className="text-muted hover:text-accent" onClick={onNone}>清空</button>
        </span>
      </div>
      <ul className="space-y-0.5">
        {options.map((s) => {
          const on = !selected || selected.has(s.id);
          return (
            <li key={s.id}>
              <button
                onClick={() => onToggle(s.id)}
                className={cx(
                  "w-full flex items-center gap-2.5 rounded-lg px-2 py-2 md:py-1.5 text-left text-sm transition-colors",
                  on ? "text-ink" : "text-muted/70",
                  "hover:bg-ink/5",
                )}
              >
                <span
                  className={cx(
                    "size-4 shrink-0 rounded-[4px] border grid place-items-center transition-colors",
                    on ? "bg-accent border-accent" : "border-line",
                  )}
                >
                  {on && <svg viewBox="0 0 12 12" className="size-3 text-accent-ink"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </span>
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-xs text-muted tabular-nums">{counts.get(s.id)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SkeletonGrid({ density }: { density: Density }) {
  return (
    <div className={cx("grid", GRID[density])}>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="rounded-xl bg-surface border border-line overflow-hidden animate-pulse">
          <div className="well" style={{ aspectRatio: "var(--card-ratio)" }} />
          <div className="h-12" />
        </div>
      ))}
    </div>
  );
}
