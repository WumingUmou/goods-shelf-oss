import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, Camera, Check, ImagePlus, Minus, Plus, Rows3, Sparkles, X } from "lucide-react";
import {
  api, buildSearchQuery, imgSrc, previewSrc, type Item, type ItemImage, type ItemInput, type Kind, type SearchCandidate,
} from "../api";
import { ImageSearchPanel } from "../components/ImageSearchPanel";
import { useOptionCreators } from "../components/useOptionCreators";
import { OptionPicker } from "../components/OptionPicker";
import { Button, cx, Field, IconButton, inputCls, useToast } from "../components/ui";
import { defaultCharacterIds, storage, useItems, useMeta } from "../hooks";

/** server = already stored · file = local upload · cand = auto-search pick (at most one, key "auto") */
type Entry = { key: string; server?: ItemImage; file?: File; cand?: SearchCandidate; url: string; lowRes?: boolean };
const AUTO_KEY = "auto";

const LAST_KEY = "lastEntry";
let localSeq = 0;
type Last = Pick<ItemInput, "series_id" | "kind_ids" | "character_ids" | "bag_size_id" | "spec" | "status">;

function readLast(): Partial<Last> {
  try {
    return JSON.parse(storage.read(LAST_KEY) || "{}");
  } catch {
    return {};
  }
}

type FormState = {
  name: string;
  series: number[];
  kinds: number[];
  characters: number[];
  bag: number[];
  spec: string;
  status: string;
  quantity: number;
  note: string;
};

function initial(item: Item | undefined, defaultStatus: string, defaultChars: number[]): FormState {
  if (item)
    return {
      name: item.name,
      series: [item.series_id],
      kinds: item.kind_ids,
      characters: item.character_ids,
      bag: item.bag_size_id ? [item.bag_size_id] : [],
      spec: item.spec ?? "",
      status: item.status,
      quantity: item.quantity,
      note: item.note ?? "",
    };
  const l = readLast();
  return {
    name: "",
    series: l.series_id ? [l.series_id] : [],
    kinds: l.kind_ids ?? [],
    characters: l.character_ids?.length ? l.character_ids : defaultChars,
    bag: l.bag_size_id ? [l.bag_size_id] : [],
    spec: l.spec ?? "",
    status: l.status ?? defaultStatus,
    quantity: 1,
    note: "",
  };
}

export default function ItemFormPage() {
  const { id } = useParams();
  const editing = id !== undefined;
  const { data: meta } = useMeta();
  const { data: items, isLoading } = useItems();
  const item = editing ? items?.find((i) => i.id === Number(id)) : undefined;
  if (!meta || (editing && isLoading)) return null;
  if (editing && !item) return <p className="p-10 text-center text-muted">条目不存在</p>;
  return <Form key={id ?? "new"} item={item} />;
}

function Form({ item }: { item?: Item }) {
  const { data: meta } = useMeta();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<FormState>(() => initial(item, "已入库", defaultCharacterIds(meta)));
  const [entries, setEntries] = useState<Entry[]>(() =>
    (item?.images ?? []).map((img) => ({ key: `s${img.id}`, server: img, url: imgSrc(img, 400), lowRes: img.low_res })),
  );
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const { createOpt, createKind, kindDialog } = useOptionCreators();
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [params] = useSearchParams();
  // auto image search panel; `search.run` bumps to remount it with a fresh query
  const canSearch = !!meta?.features.image_search; // auto image search is optional (SEARXNG_URL)
  const [search, setSearch] = useState(() => {
    const want = canSearch && params.get("search") === "1";
    return { open: want, auto: want, run: 0 };
  });
  const autoTried = useRef(false);
  const [dropLowRes, setDropLowRes] = useState(true);

  // revoke object URLs on unmount
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => () => entriesRef.current.forEach((e) => e.file && URL.revokeObjectURL(e.url)), []);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const groupName = useMemo(() => new Map(meta!.groups.map((g) => [g.id, g.name])), [meta]);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    try {
      // plain counter keys: crypto.randomUUID() only exists on HTTPS/localhost, and this runs on plain LAN http
      const add = [...list].map((file) => ({ key: `l${++localSeq}`, file, url: URL.createObjectURL(file) }));
      setEntries((e) => [...e, ...add]);
      toast(`已添加 ${add.length} 张图片，保存后上传`);
    } catch (e) {
      toast(`无法读取所选图片：${(e as Error).message}`, "err");
    }
  };
  const autoEntry = entries.find((e) => e.key === AUTO_KEY);
  const hasLowRes = !!item?.images.some((i) => i.low_res);

  const defaultQuery = () => {
    const name = (id: number | undefined, m: Map<number, string>) => (id === undefined ? "" : m.get(id) ?? "");
    const seriesMap = new Map(meta!.series.map((x) => [x.id, x.name]));
    const kindMap = new Map(meta!.kinds.map((x) => [x.id, x.name]));
    const charMap = new Map(meta!.characters.map((x) => [x.id, x.name]));
    return buildSearchQuery(
      meta!.settings.search_prefix,
      name(f.series[0], seriesMap),
      f.name,
      f.kinds.map((k) => name(k, kindMap)),
      f.characters.map((c) => name(c, charMap)),
    );
  };
  const openSearch = (auto: boolean) => setSearch((s) => ({ open: true, auto, run: s.run + 1 }));

  // pick replaces the single auto image; it goes first so it becomes the cover
  const selectCandidate = (c: SearchCandidate | null) =>
    setEntries((es) => {
      const rest = es.filter((e) => e.key !== AUTO_KEY);
      return c ? [{ key: AUTO_KEY, cand: c, url: previewSrc(c) }, ...rest] : rest;
    });

  const removeEntry = (key: string) =>
    setEntries((es) => {
      const e = es.find((x) => x.key === key);
      if (e?.file) URL.revokeObjectURL(e.url);
      return es.filter((x) => x.key !== key);
    });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setEntries((es) => {
      const from = es.findIndex((x) => x.key === e.active.id);
      const to = es.findIndex((x) => x.key === e.over!.id);
      return arrayMove(es, from, to);
    });
  };

  const save = async (continueAdding: boolean) => {
    if (!f.name.trim()) return toast("请填写名称", "err");
    if (!f.series.length) return toast("请选择系列", "err");
    if (!f.kinds.length) return toast("请选择至少一个种类", "err");
    const body: ItemInput = {
      name: f.name.trim(),
      series_id: f.series[0],
      kind_ids: f.kinds,
      character_ids: f.characters,
      bag_size_id: f.bag[0] ?? null,
      spec: f.spec.trim() || null,
      status: f.status,
      quantity: f.quantity,
      note: f.note.trim() || null,
    };
    setSaving(true);
    try {
      const saved = item ? await api.updateItem(item.id, body) : await api.createItem(body);
      // "同时删除低清图": drop low-res stored images when an auto-search pick replaces them
      const final = item && autoEntry && dropLowRes ? entries.filter((e) => !(e.server && e.lowRes)) : entries;
      const locals = final.filter((e) => e.file || e.cand);
      // one request per image so progress reads "第 i / N 张" and a failure names the image
      const upMap = new Map<string, number>();
      for (const [i, e] of locals.entries()) {
        const total = locals.length;
        setUpload({ index: i, total, progress: i / total, processing: false });
        if (e.cand) {
          setUpload({ index: i, total, progress: (i + 0.5) / total, processing: true });
          const img = await api.fromSearch(saved.id, e.cand.id);
          upMap.set(e.key, img.id);
        } else {
          const [img] = await api.uploadImages(saved.id, [e.file!], (p) =>
            setUpload({ index: i, total, progress: (i + p) / total, processing: p >= 1 }),
          );
          if (img) upMap.set(e.key, img.id);
        }
      }
      if (locals.length) setUpload({ index: locals.length - 1, total: locals.length, progress: 1, processing: false, done: true });
      const keep = new Set(final.filter((e) => e.server).map((e) => e.server!.id));
      for (const img of item?.images ?? []) if (!keep.has(img.id)) await api.deleteImage(img.id);
      const order = final.map((e) => e.server?.id ?? upMap.get(e.key)).filter((x): x is number => x != null);
      if (order.length) await api.orderImages(saved.id, order);

      if (!item) {
        const last: Last = { series_id: body.series_id, kind_ids: body.kind_ids, character_ids: body.character_ids, bag_size_id: body.bag_size_id, spec: body.spec, status: body.status };
        storage.write(LAST_KEY, JSON.stringify(last));
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["items"] }), qc.invalidateQueries({ queryKey: ["meta"] })]);
      const upMsg = locals.length ? ` · ${locals.length} 张图片上传成功` : "";
      toast((item ? "已保存" : `已添加「${body.name}」`) + upMsg);
      // uploads on LAN finish in a blink — hold the finished bar briefly so it is actually seen
      if (locals.length && !continueAdding) await new Promise((r) => setTimeout(r, 1000));
      if (continueAdding) {
        entries.forEach((e) => e.file && URL.revokeObjectURL(e.url));
        setEntries([]);
        setSearch((s) => ({ ...s, open: false }));
        autoTried.current = false;
        setF((s) => ({ ...s, name: "", quantity: 1, note: "" }));
        window.scrollTo({ top: 0 });
        nameRef.current?.focus();
      } else if (item) navigate(`/item/${item.id}`, { replace: true });
      else navigate("/", { replace: true });
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSaving(false);
      setTimeout(() => setUpload(null), 1200);
    }
  };

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/"));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 safe-top safe-x app-bar">
        <div className="h-14 flex items-center gap-2 px-2">
        <IconButton label="返回" onClick={back}>
          <ArrowLeft size={20} />
        </IconButton>
        <h1 className="font-display text-lg">{item ? "编辑谷子" : "添加谷子"}</h1>
        {!item && (
          <Link to="/bulk" className="ml-auto mr-2 hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line text-sm hover:border-gold/60">
            <Rows3 size={15} /> 批量添加
          </Link>
        )}
        </div>
      </header>

      <form
        className="mx-auto max-w-2xl px-4 py-5 space-y-5 pb-32"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        {/* images */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs tracking-wide text-muted">图片 <span className="opacity-70">· 第一张为封面，长按拖动排序</span></span>
            {canSearch && !search.open && (
              <button type="button" onClick={() => openSearch(!!f.name.trim())} className="inline-flex items-center gap-1 text-xs text-gold hover:underline">
                <Sparkles size={13} /> 自动搜图
              </button>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={entries.map((e) => e.key)} strategy={horizontalListSortingStrategy}>
                {entries.map((e, i) => (
                  <Thumb key={e.key} entry={e} cover={i === 0} onRemove={() => removeEntry(e.key)} />
                ))}
              </SortableContext>
            </DndContext>
            <button type="button" onClick={() => cameraRef.current?.click()} className="shrink-0 w-24 aspect-[3/4] rounded-lg border border-dashed border-line grid place-items-center text-muted hover:text-accent hover:border-accent/50">
              <span className="flex flex-col items-center gap-1 text-xs"><Camera size={22} strokeWidth={1.5} />拍照</span>
            </button>
            <button type="button" onClick={() => albumRef.current?.click()} className="shrink-0 w-24 aspect-[3/4] rounded-lg border border-dashed border-line grid place-items-center text-muted hover:text-accent hover:border-accent/50">
              <span className="flex flex-col items-center gap-1 text-xs"><ImagePlus size={22} strokeWidth={1.5} />相册</span>
            </button>
          </div>
          {search.open && (
            <ImageSearchPanel
              key={search.run}
              defaultQuery={defaultQuery()}
              autoRun={search.auto}
              selectedId={autoEntry?.cand?.id ?? null}
              onSelect={selectCandidate}
              onClose={() => setSearch((s) => ({ ...s, open: false }))}
            />
          )}
          {item && autoEntry && hasLowRes && (
            <label className="mt-2 flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={dropLowRes} onChange={(e) => setDropLowRes(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              同时删除低清图（{item.images.filter((i) => i.low_res).length} 张）
            </label>
          )}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <input ref={albumRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </section>

        <Field label="名称" required>
          <input
            ref={nameRef}
            value={f.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={() => {
              // new item without photos: search once automatically after the name is filled in
              if (canSearch && !item && !autoTried.current && !search.open && entries.length === 0 && f.name.trim()) {
                autoTried.current = true;
                openSearch(true);
              }
            }} className={inputCls} placeholder="例：系列名 - 吧唧" maxLength={100} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="系列" required>
            <OptionPicker label="系列" options={meta!.series} value={f.series} onChange={(v) => set("series", v)} onCreate={createOpt("series")} />
          </Field>
          <Field label="种类" required>
            <OptionPicker<Kind>
              label="种类"
              multi
              options={meta!.kinds}
              value={f.kinds}
              onChange={(v) => set("kinds", v)}
              onCreate={createKind}
              groupLabel={(k) => groupName.get(k.group_id) ?? ""}
            />
          </Field>
          <Field label="角色">
            <OptionPicker label="角色" multi options={meta!.characters} value={f.characters} onChange={(v) => set("characters", v)} onCreate={createOpt("character")} placeholder="可多选" />
          </Field>
          <Field label="自封袋尺寸">
            <OptionPicker label="自封袋尺寸" options={meta!.bag_sizes} value={f.bag} onChange={(v) => set("bag", v)} onCreate={createOpt("bag_size")} placeholder="未指定" />
          </Field>
          <Field label="尺寸 / 规格">
            <input value={f.spec} onChange={(e) => set("spec", e.target.value)} list="spec-list" className={inputCls} placeholder="例：75mm、55*85mm" />
            <datalist id="spec-list">
              {meta!.specs.map((s) => <option key={s} value={s} />)}
            </datalist>
          </Field>
          <Field label="状态">
            <select value={f.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
              {meta!.statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="数量">
            <div className="flex items-center gap-2">
              <IconButton type="button" label="减少" className="border border-line" onClick={() => set("quantity", Math.max(1, f.quantity - 1))}><Minus size={16} /></IconButton>
              <input
                inputMode="numeric"
                value={f.quantity}
                onChange={(e) => set("quantity", Math.min(9999, Math.max(1, parseInt(e.target.value) || 1)))}
                className={cx(inputCls, "w-20 text-center tabular-nums")}
              />
              <IconButton type="button" label="增加" className="border border-line" onClick={() => set("quantity", Math.min(9999, f.quantity + 1))}><Plus size={16} /></IconButton>
            </div>
          </Field>
        </div>

        <Field label="备注">
          <textarea value={f.note} onChange={(e) => set("note", e.target.value)} rows={3} className={cx(inputCls, "h-auto py-2.5 resize-y")} />
        </Field>

        <div className="fixed inset-x-0 bottom-0 z-20 safe-x bg-canvas/90 backdrop-blur-md border-t border-line">
          {upload && <UploadBar state={upload} />}
          <div className="mx-auto max-w-2xl px-4 pt-3 pb-safe flex gap-2">
            {!item && (
              <Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => save(true)}>
                保存并继续添加
              </Button>
            )}
            <Button type="submit" variant="primary" className="flex-1" disabled={saving}>
              {saving ? (upload && !upload.done ? "上传中…" : "保存中…") : "保存"}
            </Button>
          </div>
        </div>
      </form>

      {kindDialog}
    </div>
  );
}

function Thumb({ entry, cover, onRemove }: { entry: Entry; cover: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.key });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx("relative shrink-0 w-24 aspect-[3/4] rounded-lg overflow-hidden well border touch-manipulation", cover ? "border-gold/70" : "border-line", isDragging && "z-10 shadow-xl")}
      {...attributes}
      {...listeners}
    >
      <img src={entry.url} alt="" className="absolute inset-0 size-full object-contain p-1" draggable={false} />
      {cover && <span className="absolute left-1 bottom-1 rounded bg-gold text-canvas text-[12px] px-1 leading-4">封面</span>}
      {entry.cand && <span className="absolute left-1 top-1 rounded bg-ink/70 text-canvas text-[11px] px-1 leading-4">网络</span>}
      {entry.lowRes && <span className="absolute right-1 bottom-1 rounded bg-ink/70 text-canvas text-[12px] px-1 leading-4">低清</span>}
      <button
        type="button"
        aria-label="移除图片"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute right-1 top-1 size-6 grid place-items-center rounded-full bg-ink/60 text-canvas"
      >
        <X size={13} />
      </button>
    </div>
  );
}

type UploadState = { index: number; total: number; progress: number; processing: boolean; done?: boolean };

function UploadBar({ state }: { state: UploadState }) {
  const pct = Math.round(state.progress * 100);
  const label = state.done
    ? `${state.total} 张图片上传成功`
    : state.processing
      ? `第 ${state.index + 1} / ${state.total} 张：服务器处理中…`
      : `正在上传第 ${state.index + 1} / ${state.total} 张`;
  return (
    <div className="mx-auto max-w-2xl px-4 pt-3" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className={cx("inline-flex items-center gap-1", state.done ? "text-gold" : "text-muted")}>
          {state.done && <Check size={14} />}
          {label}
        </span>
        <span className="tabular-nums text-muted">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-ink/10 overflow-hidden">
        <div
          className={cx("h-full rounded-full transition-[width] duration-200", state.done ? "bg-gold" : "bg-accent", state.processing && "animate-pulse")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
