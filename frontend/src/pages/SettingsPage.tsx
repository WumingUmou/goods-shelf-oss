import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, Download, FileSpreadsheet, GripVertical, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, imgSrc, type AppSettings, type ImportPreview, type Kind, type Option, type OptionType, type Series } from "../api";
import { Button, ConfirmDialog, cx, IconButton, inputCls, useToast } from "../components/ui";
import { useItems, useMeta } from "../hooks";
import { buildLabel } from "../components/UpdateBanner";
import { AppearanceSettings } from "../components/AppearanceSettings";

const TABS = [
  ["options", "选项管理"],
  ["appearance", "外观"],
  ["import", "Excel 导入"],
  ["lowres", "待换高清图"],
  ["search", "默认值"],
  ["backup", "备份"],
] as const;

const TYPES: [OptionType, string][] = [
  ["series", "系列"],
  ["group", "大类"],
  ["kind", "种类"],
  ["character", "角色"],
  ["bag_size", "自封袋"],
];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "options";
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 safe-top safe-x app-bar">
        <div className="mx-auto max-w-3xl px-2 md:px-4 h-14 flex items-center gap-2">
          <IconButton label="返回" onClick={() => navigate("/")}>
            <ArrowLeft size={20} />
          </IconButton>
          <h1 className="font-display text-lg">设置</h1>
        </div>
        <nav className="mx-auto max-w-3xl px-4 flex flex-wrap gap-1 pb-2">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setParams({ tab: k }, { replace: true })}
              className={cx("shrink-0 h-8 px-3 rounded-full text-sm", tab === k ? "bg-ink text-canvas" : "text-muted hover:bg-ink/5")}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-5 pb-24">
        {tab === "options" && <OptionsManager />}
        {tab === "import" && <ImportPanel />}
        {tab === "lowres" && <LowResList />}
        {tab === "appearance" && <AppearanceSettings />}
        {tab === "search" && <SearchSettings />}
        {tab === "backup" && <BackupPanel />}
      </main>
    </div>
  );
}

// ---- options -------------------------------------------------------------

function OptionsManager() {
  const [type, setType] = useState<OptionType>("series");
  const { data: meta } = useMeta();
  const [groupFilter, setGroupFilter] = useState<number | "">("");
  const qc = useQueryClient();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [del, setDel] = useState<Option | null>(null);

  const rows: Option[] = useMemo(() => {
    if (!meta) return [];
    const m: Record<OptionType, Option[]> = {
      series: meta.series, group: meta.groups, kind: meta.kinds, character: meta.characters, bag_size: meta.bag_sizes,
    };
    let r = m[type];
    if (type === "kind" && groupFilter !== "") r = (r as Kind[]).filter((k) => k.group_id === groupFilter);
    return r;
  }, [meta, type, groupFilter]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["meta"] });
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      await refresh();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast((e as Error).message, "err");
      await refresh();
      return false;
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = rows.findIndex((r) => r.id === e.active.id);
    const to = rows.findIndex((r) => r.id === e.over!.id);
    const ids = arrayMove(rows, from, to).map((r) => r.id);
    // optimistic
    qc.setQueryData(["meta"], (old: typeof meta) => {
      if (!old) return old;
      const key = ({ series: "series", group: "groups", kind: "kinds", character: "characters", bag_size: "bag_sizes" } as const)[type];
      const list = [...(old[key] as Option[])];
      const pos = new Map(ids.map((id, i) => [id, i]));
      list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
      return { ...old, [key]: list };
    });
    run(() => api.orderOptions(type, ids));
  };

  // "全部大类": kinds are sorted within their own 大类, so show them grouped; dragging only
  // makes sense after picking one 大类.
  const groupedKinds = type === "kind" && groupFilter === "";
  const kindSections = useMemo(() => {
    if (!groupedKinds || !meta) return [];
    return meta.groups
      .map((g) => ({ group: g, kinds: meta.kinds.filter((k) => k.group_id === g.id) }))
      .filter((sec) => sec.kinds.length);
  }, [groupedKinds, meta]);

  const renderRow = (r: Option, draggable: boolean) => (
    <OptionRow
      // type in the key: ids repeat across option types (series 1 ≠ 大类 1), and a reused row
      // would keep the previous type's input text
      key={`${type}-${r.id}`}
      type={type}
      row={r}
      draggable={draggable}
      groups={meta?.groups ?? []}
      onRename={(name) => run(() => api.updateOption(type, r.id, { name }))}
      onPatch={(patch) => run(() => api.updateOption(type, r.id, patch))}
      onDelete={() => setDel(r)}
    />
  );

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const body: Record<string, unknown> = { name };
    if (type === "kind" && groupFilter !== "") body.group_id = groupFilter;
    run(() => api.createOption(type, body), `已添加「${name}」`);
    setNewName("");
  };

  return (
    <div>
      <div className="flex gap-1 flex-wrap mb-4">
        {TYPES.map(([t, label]) => (
          <button key={t} onClick={() => setType(t)} className={cx("h-8 px-3 rounded-lg text-sm border", type === t ? "border-accent text-accent bg-accent/5" : "border-line text-muted")}>
            {label}
          </button>
        ))}
      </div>

      {type === "kind" && (
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value ? Number(e.target.value) : "")} className={cx(inputCls, "mb-3")}>
          <option value="">全部大类</option>
          {meta?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}

      <div className="flex gap-2 mb-4">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="新增名称" className={inputCls} />
        <Button variant="primary" onClick={add}><Plus size={16} /> 添加</Button>
      </div>
      <p className="text-xs text-muted mb-2">
        {groupedKinds ? (
          "按大类分组显示；在上方选择某个大类后可拖动调整该大类内的顺序"
        ) : (
          <>
            拖动 <GripVertical size={12} className="inline" /> 调整顺序
            {type === "series" && "，展示柜按此顺序分段；「展区标题」留空时显示系列名；「卡面」显示在该系列每件谷子的详情页"}
          </>
        )}
      </p>

      {groupedKinds ? (
        <div className="space-y-4">
          {kindSections.map(({ group, kinds }) => (
            <section key={group.id}>
              <h3 className="px-1 pb-1.5 text-[13px] tracking-[0.2em] text-gold">
                {group.name} <span className="text-muted tracking-normal">· {kinds.length}</span>
              </h3>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{kinds.map((r) => renderRow(r, false))}</ul>
            </section>
          ))}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {rows.map((r) => renderRow(r, true))}
              {rows.length === 0 && <li className="p-6 text-center text-sm text-muted">暂无</li>}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={!!del}
        title={`删除「${del?.name}」？`}
        message="仅当没有谷子使用它时才能删除。"
        confirmLabel="删除"
        onClose={() => setDel(null)}
        onConfirm={() => {
          const d = del!;
          setDel(null);
          run(() => api.deleteOption(type, d.id), `已删除「${d.name}」`);
        }}
      />
    </div>
  );
}

function OptionRow({
  type, row, draggable, groups, onRename, onPatch, onDelete,
}: {
  type: OptionType;
  row: Option;
  draggable: boolean;
  groups: Option[];
  onRename: (name: string) => Promise<boolean>;
  onPatch: (p: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: !draggable });
  const series = type === "series" ? (row as Series) : null;
  const [name, setName] = useState(row.name);
  const [title, setTitle] = useState(series?.section_title ?? "");
  const [face, setFace] = useState(series?.card_face ?? "");
  // keep inputs in step with the server copy (after a save, a refetch, or a rejected edit)
  useEffect(() => setName(row.name), [row.name]);
  useEffect(() => setTitle(series?.section_title ?? ""), [series?.section_title]);
  useEffect(() => setFace(series?.card_face ?? ""), [series?.card_face]);
  const commitName = async () => {
    const v = name.trim();
    if (!v) return setName(row.name);
    if (v !== row.name && !(await onRename(v))) setName(row.name); // e.g. 409 duplicate → roll back
  };
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx("flex items-start gap-2 px-2 py-2 bg-surface", isDragging && "relative z-10 shadow-lg rounded-lg")}
    >
      {draggable ? (
        <button {...attributes} {...listeners} aria-label="拖动排序" className="mt-1.5 p-1.5 text-muted cursor-grab touch-none">
          <GripVertical size={16} />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <div className={cx("flex-1 min-w-0 grid gap-1.5", series ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className={cx(inputCls, "h-9 bg-transparent border-transparent hover:border-line")}
          aria-label="名称"
        />
        {series && (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== (series.section_title ?? "") && onPatch({ section_title: title })}
            aria-label="展区标题"
            placeholder="展区标题（默认：系列名）"
            className={cx(inputCls, "h-9")}
          />
        )}
        {series && (
          <input
            value={face}
            onChange={(e) => setFace(e.target.value)}
            onBlur={() => face !== (series.card_face ?? "") && onPatch({ card_face: face })}
            placeholder="卡面（可选）"
            aria-label="卡面"
            className={cx(inputCls, "h-9")}
          />
        )}
        {type === "kind" && (
          <select
            value={(row as Kind).group_id}
            onChange={(e) => onPatch({ group_id: Number(e.target.value) })}
            className={cx(inputCls, "h-9")}
            aria-label="所属大类"
          >
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>
      <IconButton label="删除" onClick={onDelete} className="mt-0.5 size-9 text-muted hover:text-accent">
        <Trash2 size={16} />
      </IconButton>
    </li>
  );
}

// ---- import --------------------------------------------------------------

function ImportPanel() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      setPreview(await api.importPreview(file));
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api.importCommit(preview.token);
      setResult(r);
      setPreview(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ["items"] }), qc.invalidateQueries({ queryKey: ["meta"] })]);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const fresh = rows.filter((r) => !r.duplicate);
  const labels = { series: "系列", kind: "种类", character: "角色", bag_size: "自封袋" } as const;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted leading-relaxed">
        支持「谷子名称 / 图片 / 角色 / 种类 / 属性(自封袋) / 尺寸规格 / 状态 / 数量 / 备注」列。
        没有「系列」列时，取名称中「 - 」前的部分作为系列。同名条目会跳过。
      </p>
      <label className={cx("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line py-10 cursor-pointer hover:border-gold/60", busy && "opacity-60 pointer-events-none")}>
        <FileSpreadsheet size={28} strokeWidth={1.3} className="text-gold" />
        <span className="text-sm">{busy ? "处理中…" : "选择 .xlsx 文件"}</span>
        <input type="file" accept=".xlsx" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      </label>

      {result && (
        <div className="rounded-xl border border-gold/40 bg-surface p-4 text-sm">
          导入完成：新增 <b>{result.created}</b> 条，跳过 {result.skipped} 条重复。 <Link to="/" className="text-accent underline">去展示柜</Link>
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat n={rows.length} label="总行数" />
            <Stat n={fresh.length} label="将新增" />
            <Stat n={rows.length - fresh.length} label="重复跳过" />
          </div>
          {(Object.keys(labels) as (keyof typeof labels)[]).map((k) =>
            preview.new_options[k].length ? (
              <div key={k}>
                <p className="text-xs text-muted mb-1.5">将新建{labels[k]}（{preview.new_options[k].length}）</p>
                <div className="flex flex-wrap gap-1">
                  {preview.new_options[k].map((n) => (
                    <span key={n} className={cx("rounded-md border px-2 py-0.5 text-xs", k === "kind" && preview.new_kinds_to_other.includes(n) ? "border-accent/40 text-accent" : "border-line")}>{n}</span>
                  ))}
                </div>
              </div>
            ) : null,
          )}
          {preview.new_kinds_to_other.length > 0 && (
            <p className="text-xs text-accent">红色标出的种类将归入「其他」大类，导入后可在选项管理中调整。</p>
          )}
          <div className="rounded-xl border border-line overflow-hidden">
            <div className="max-h-[50dvh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-canvas sticky top-0">
                  <tr className="text-left text-muted">
                    <th className="p-2 font-normal">行</th><th className="p-2 font-normal">名称</th><th className="p-2 font-normal">系列</th><th className="p-2 font-normal">种类</th><th className="p-2 font-normal">图</th><th className="p-2 font-normal">提示</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={r.row} className={cx(r.duplicate && "opacity-40")}>
                      <td className="p-2 tabular-nums text-muted">{r.row}</td>
                      <td className="p-2">{r.name}</td>
                      <td className="p-2 whitespace-nowrap">{r.series}</td>
                      <td className="p-2">{r.kinds.join("、")}</td>
                      <td className="p-2 whitespace-nowrap tabular-nums">{r.image_size ? <span className={cx(r.low_res && "text-gold")}>{r.image_size.join("×")}</span> : "—"}</td>
                      <td className="p-2 text-accent">{[r.duplicate && "重复", ...r.warnings].filter(Boolean).join("；")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setPreview(null)}>取消</Button>
            <Button variant="primary" disabled={busy || fresh.length === 0} onClick={commit}>
              {busy ? "导入中…" : `确认导入 ${fresh.length} 条`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-xl bg-surface border border-line py-3">
      <div className="font-display text-2xl tabular-nums">{n}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

// ---- low-res -------------------------------------------------------------

function LowResList() {
  const { data: items } = useItems();
  const { data: meta } = useMeta();
  const canSearch = !!meta?.features.image_search;
  const list = (items ?? []).filter((i) => i.images.some((img) => img.low_res));
  return (
    <div>
      <p className="text-sm text-muted mb-4">
        以下 {list.length} 件谷子含长边小于 600px 的图片。
        {canSearch ? "点击进入编辑页并自动搜图，选中后保存即可替换（可勾选同时删除低清图）；也可以手动上传。" : "点击进入编辑页，上传清晰的图片后删除低清图即可。"}
      </p>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
        {list.map((i) => {
          const img = i.images.find((x) => x.low_res)!;
          return (
            <Link key={i.id} to={`/item/${i.id}/edit${canSearch ? "?search=1" : ""}`} className="rounded-lg bg-surface border border-line overflow-hidden hover:border-gold/50">
              <div className="well relative" style={{ aspectRatio: "var(--card-ratio)" }}>
                <img src={imgSrc(img, 400)} alt="" loading="lazy" className="absolute inset-0 size-full object-contain p-2" />
                <span className="absolute right-1 bottom-1 rounded bg-ink/70 text-canvas text-[12px] px-1 tabular-nums">{Math.max(img.width, img.height)}px</span>
              </div>
              <div className="p-1.5 text-[13px] line-clamp-1">{i.name}</div>
              {canSearch && <div className="px-1.5 pb-1.5 text-[12px] text-gold inline-flex items-center gap-1"><Sparkles size={12} /> 搜图替换</div>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ---- search settings -----------------------------------------------------

function SearchSettings() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const current = meta?.settings ?? { search_prefix: "", default_character: "" };
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const prefix = draft.search_prefix ?? current.search_prefix;
  const character = draft.default_character ?? current.default_character;
  const dirty = prefix !== current.search_prefix || character !== current.default_character;
  const charKnown = !character.trim() || !!meta?.characters.some((c) => c.name === character.trim());
  const save = async () => {
    try {
      await api.updateSettings({ search_prefix: prefix, default_character: character });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      setDraft({});
      toast("已保存");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <label className="block text-xs tracking-wide text-muted mb-1.5" htmlFor="default-character">默认角色</label>
        <input id="default-character" value={character} onChange={(e) => setDraft((d) => ({ ...d, default_character: e.target.value }))} list="settings-characters" className={inputCls} placeholder="留空则不预填" maxLength={50} />
        <datalist id="settings-characters">{meta?.characters.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        <p className="mt-1.5 text-sm text-muted">单条添加和批量添加的新条目，在没有「上次录入的角色」时预填这个角色。</p>
        {!charKnown && <p className="mt-1 text-sm text-accent">角色列表中没有「{character.trim()}」，请先在「选项管理 → 角色」中添加。</p>}
      </div>
      {meta?.features.image_search ? (
      <div>
        <label className="block text-xs tracking-wide text-muted mb-1.5" htmlFor="search-prefix">自动搜图 · 搜索前缀</label>
        <input id="search-prefix" value={prefix} onChange={(e) => setDraft((d) => ({ ...d, search_prefix: e.target.value }))} className={inputCls} placeholder="例：作品名" maxLength={50} />
        <p className="mt-1.5 text-sm text-muted leading-relaxed">
          关键词 = 搜索前缀 + 系列 + 名称 + 种类 + 角色（重复的词只保留一次）。前缀通常填作品名，能明显提高准确度。
          例：<span className="text-ink">{[prefix, "系列名", "吧唧", character].filter(Boolean).join(" ")}</span>
        </p>
      </div>
      ) : (
        <p className="text-sm text-muted leading-relaxed">自动搜图未启用。启用方法见 README「自动搜图（可选）」：运行 SearXNG 并设置 <code className="text-xs">SEARXNG_URL</code>。</p>
      )}
      <Button variant="primary" onClick={save} disabled={!dirty}>保存</Button>
    </div>
  );
}

// ---- backup --------------------------------------------------------------

function BackupPanel() {
  return (
    <div className="space-y-6 max-w-xl">
      <section className="space-y-2">
        <h3 className="text-sm text-ink">手动导出</h3>
        <p className="text-sm text-muted leading-relaxed">下载一个包含数据库与全部原图的 zip，可自行另存。</p>
        <a href="/api/export" className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-accent text-accent-ink text-sm">
          <Download size={16} /> 下载备份
        </a>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm text-ink">定时备份（可选）</h3>
        <p className="text-sm text-muted leading-relaxed">
          服务器上的全部数据在 <code className="text-xs">data/</code> 目录（数据库 + 图片）。项目自带 <code className="text-xs">scripts/backup.sh</code>，
          可用 cron 定时把它加密增量备份到另一台机器（restic），并可推送结果到 Uptime Kuma；恢复用 <code className="text-xs">scripts/restore.sh</code>。
          配置方法见 README「备份」。
        </p>
      </section>
      <p className="pt-2 text-xs text-muted">当前版本：{buildLabel()}</p>
    </div>
  );
}
