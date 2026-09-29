import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, ArrowLeft, Check, Copy, ImagePlus, Loader2, Plus, Rows3, SlidersHorizontal, Trash2, Upload, X,
} from "lucide-react";
import { api, type ItemInput, type Kind } from "../api";
import { OptionPicker } from "../components/OptionPicker";
import { useOptionCreators } from "../components/useOptionCreators";
import { Button, ConfirmDialog, cx, Dialog, Field, IconButton, inputCls, useToast } from "../components/ui";
import { defaultCharacterIds, storage, useItems, useMeta } from "../hooks";

/** Desktop bulk add: drop many photos → one row per photo → fill a table → save all. */

// checkbox · 图片 · 名称 · 系列 · 种类 · 角色 · 规格 · 自封袋 · 状态 · 数量 · 备注 · 操作
const COL_WIDTHS = [48, 150, 196, 200, 150, 130, 104, 90, 116, 64, 92, 88];

type Img = { key: string; file: File; url: string; previewable: boolean };
type RowState = "draft" | "saving" | "saved" | "error";
type Row = {
  key: string;
  images: Img[];
  name: string;
  series: number[];
  kinds: number[];
  characters: number[];
  bag: number[];
  spec: string;
  status: string;
  quantity: number;
  note: string;
  selected: boolean;
  state: RowState;
  error?: string;
  savedId?: number; // item created — a retry only uploads the remaining images
  uploaded: number;
};
type Defaults = Pick<Row, "series" | "kinds" | "characters" | "bag" | "status">;

let seq = 0;
const nextKey = () => `r${++seq}`;
const isImage = (f: File) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);
// browsers other than Safari can't render HEIC; the server converts it on upload
const previewable = (f: File) => !/heic|heif/i.test(f.type) && !/\.(heic|heif)$/i.test(f.name);
const toImg = (file: File): Img => ({ key: nextKey(), file, url: URL.createObjectURL(file), previewable: previewable(file) });
const nameFromFile = (f: File) => f.name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();

function readDefaults(defaultChars: number[]): Defaults {
  try {
    const l = JSON.parse(storage.read("lastEntry") || "{}");
    return {
      series: l.series_id ? [l.series_id] : [],
      kinds: l.kind_ids ?? [],
      characters: l.character_ids?.length ? l.character_ids : defaultChars,
      bag: l.bag_size_id ? [l.bag_size_id] : [],
      status: l.status ?? "已入库",
    };
  } catch {
    return { series: [], kinds: [], characters: defaultChars, bag: [], status: "已入库" };
  }
}

function makeRow(d: Defaults, file?: File): Row {
  return {
    key: nextKey(),
    images: file ? [toImg(file)] : [],
    name: file ? nameFromFile(file) : "",
    series: [...d.series],
    kinds: [...d.kinds],
    characters: [...d.characters],
    bag: [...d.bag],
    spec: "",
    status: d.status,
    quantity: 1,
    note: "",
    selected: false,
    state: "draft",
    uploaded: 0,
  };
}

const missing = (r: Row) => [!r.name.trim() && "名称", !r.series.length && "系列", !r.kinds.length && "种类"].filter(Boolean) as string[];

export default function BulkAddPage() {
  const { data: meta } = useMeta();
  const { data: items } = useItems();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { createOpt, createKind, kindDialog } = useOptionCreators();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState<{ row: number; total: number; imgs: string } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // ---- row helpers ---------------------------------------------------------
  const lastDefaults = (rs: Row[]): Defaults => {
    const prev = [...rs].reverse().find((r) => r.state !== "saved");
    return prev
      ? { series: prev.series, kinds: prev.kinds, characters: prev.characters, bag: prev.bag, status: prev.status }
      : readDefaults(defaultCharacterIds(meta));
  };
  const addFiles = (files: File[]) => {
    const imgs = files.filter(isImage);
    if (!imgs.length) return toast("没有可用的图片文件", "err");
    setRows((rs) => {
      const d = lastDefaults(rs);
      return [...rs, ...imgs.map((f) => makeRow(d, f))];
    });
    toast(`已添加 ${imgs.length} 行`);
  };
  const addEmpty = () => setRows((rs) => [...rs, makeRow(lastDefaults(rs))]);
  const patch = (key: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p, ...(r.state === "error" ? { state: "draft" as const, error: undefined } : {}) } : r)));
  const removeRows = (keys: Set<string>) =>
    setRows((rs) => {
      rs.filter((r) => keys.has(r.key)).forEach((r) => r.images.forEach((i) => URL.revokeObjectURL(i.url)));
      return rs.filter((r) => !keys.has(r.key));
    });
  const duplicateRow = (key: string) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const src = rs[i];
      const copy: Row = { ...src, key: nextKey(), images: [], selected: false, state: "draft", error: undefined, savedId: undefined, uploaded: 0 };
      return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
    });
  const addImagesToRow = (key: string, files: File[]) => {
    const imgs = files.filter(isImage).map(toImg);
    if (imgs.length) setRows((rs) => rs.map((r) => (r.key === key ? { ...r, images: [...r.images, ...imgs] } : r)));
  };
  const removeImage = (rowKey: string, imgKey: string) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== rowKey) return r;
        r.images.filter((i) => i.key === imgKey).forEach((i) => URL.revokeObjectURL(i.url));
        return { ...r, images: r.images.filter((i) => i.key !== imgKey) };
      }),
    );

  // ---- page-level drag & drop ---------------------------------------------
  // the window listener is registered once, so it must call the *latest* addFiles (fresh meta/defaults)
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFilesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // warn before leaving with unsaved rows; free object URLs on unmount
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (rowsRef.current.some((r) => r.state !== "saved")) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => {
      window.removeEventListener("beforeunload", onBefore);
      rowsRef.current.forEach((r) => r.images.forEach((i) => URL.revokeObjectURL(i.url)));
    };
  }, []);

  // ---- derived -------------------------------------------------------------
  const existingNames = useMemo(() => new Set((items ?? []).map((i) => i.name)), [items]);
  const nameCounts = useMemo(() => {
    const c = new Map<string, number>();
    rows.forEach((r) => r.name.trim() && c.set(r.name.trim(), (c.get(r.name.trim()) ?? 0) + 1));
    return c;
  }, [rows]);
  const pending = rows.filter((r) => r.state !== "saved");
  const incomplete = pending.filter((r) => missing(r).length);
  const ready = pending.filter((r) => !missing(r).length);
  const selected = rows.filter((r) => r.selected && r.state !== "saved");
  const allSelected = pending.length > 0 && selected.length === pending.length;
  const savedCount = rows.length - pending.length;
  const imageCount = pending.reduce((n, r) => n + r.images.length, 0);
  const groupName = useMemo(() => new Map((meta?.groups ?? []).map((g) => [g.id, g.name])), [meta]);

  // ---- save ----------------------------------------------------------------
  const saveAll = async () => {
    const todo = rowsRef.current.filter((r) => r.state !== "saved" && !missing(r).length);
    if (!todo.length) return toast(incomplete.length ? "请先补全标红的必填项" : "没有需要保存的行", "err");
    let ok = 0, failed = 0;
    for (const [i, r] of todo.entries()) {
      const set = (p: Partial<Row>) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, ...p } : x)));
      set({ state: "saving", error: undefined });
      setSaving({ row: i, total: todo.length, imgs: "" });
      let savedId = r.savedId;
      let uploaded = r.uploaded;
      try {
        const body: ItemInput = {
          name: r.name.trim(), series_id: r.series[0], kind_ids: r.kinds, character_ids: r.characters,
          bag_size_id: r.bag[0] ?? null, spec: r.spec.trim() || null, status: r.status, quantity: r.quantity,
          note: r.note.trim() || null,
        };
        if (!savedId) {
          savedId = (await api.createItem(body)).id;
          set({ savedId });
        }
        for (let k = uploaded; k < r.images.length; k++) {
          const label = `图片 ${k + 1} / ${r.images.length}`;
          setSaving({ row: i, total: todo.length, imgs: label });
          await api.uploadImages(savedId, [r.images[k].file], (p) =>
            setSaving({ row: i, total: todo.length, imgs: `${label} · ${Math.round(p * 100)}%` }),
          );
          uploaded = k + 1;
          set({ uploaded });
        }
        set({ state: "saved", selected: false });
        ok++;
      } catch (e) {
        set({ state: "error", error: (e as Error).message, savedId, uploaded });
        failed++;
      }
    }
    setSaving(null);
    const last = todo[todo.length - 1];
    storage.write("lastEntry", JSON.stringify({
      series_id: last.series[0], kind_ids: last.kinds, character_ids: last.characters,
      bag_size_id: last.bag[0] ?? null, spec: null, status: last.status,
    }));
    await Promise.all([qc.invalidateQueries({ queryKey: ["items"] }), qc.invalidateQueries({ queryKey: ["meta"] })]);
    toast(failed ? `已保存 ${ok} 行，${failed} 行失败（可修改后重试）` : `已保存 ${ok} 行`, failed ? "err" : "ok");
  };

  const clearSaved = () =>
    setRows((rs) => {
      rs.filter((r) => r.state === "saved").forEach((r) => r.images.forEach((i) => URL.revokeObjectURL(i.url)));
      return rs.filter((r) => r.state !== "saved");
    });

  if (!meta) return null;
  const busy = !!saving;

  return (
    <div className="min-h-dvh pb-28">
      <header className="sticky top-0 z-30 safe-top safe-x app-bar">
        <div className="px-3 md:px-6 h-14 flex items-center gap-2">
          <IconButton label="返回" onClick={() => navigate("/")}>
            <ArrowLeft size={20} />
          </IconButton>
          <h1 className="font-display text-lg whitespace-nowrap">批量添加</h1>
          <div className="flex-1" />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            <ImagePlus size={16} /> <span className="hidden sm:inline">选择图片</span>
          </Button>
          <Button variant="outline" onClick={addEmpty} disabled={busy}>
            <Plus size={16} /> <span className="hidden sm:inline">空行</span>
          </Button>
          <Button variant="outline" onClick={() => setBatchOpen(true)} disabled={busy || !pending.length}>
            <SlidersHorizontal size={16} /> <span className="hidden sm:inline">批量设置{selected.length ? `（${selected.length}）` : ""}</span>
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy || !selected.length}>
            <Trash2 size={16} /> <span className="hidden sm:inline">删除所选</span>
          </Button>
        </div>
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </header>

      <p className="md:hidden mx-3 mt-3 text-xs text-muted">提示：批量添加为电脑设计，手机上可以用但表格需要横向滑动。</p>

      {rows.length === 0 ? (
        <button
          onClick={() => fileRef.current?.click()}
          className="mx-3 md:mx-6 mt-6 w-[calc(100%-1.5rem)] md:w-[calc(100%-3rem)] flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line py-24 text-muted hover:border-gold/60 hover:text-ink transition-colors"
        >
          <Upload size={36} strokeWidth={1.3} className="text-gold" />
          <span className="text-lg text-ink">把图片拖到这里</span>
          <span className="text-sm">每张图片生成一行 · 名称默认取文件名 · 也可以点击选择</span>
        </button>
      ) : (
        // own scroll area (both axes) so the header row can stick inside it
        <div data-no-swipe-back className="mt-3 overflow-auto max-h-[calc(100dvh-8.5rem-var(--sat)-var(--sab))]">
          <table className="table-fixed w-[1428px] min-w-full text-sm border-separate border-spacing-0">
            <colgroup>
              {COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead className="sticky top-0 z-20 bg-canvas">
              <tr className="text-left text-xs text-muted">
                <th className="pl-3 md:pl-6 pr-2 py-2 w-8 font-normal border-b border-line">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={allSelected}
                    onChange={(e) => setRows((rs) => rs.map((r) => (r.state === "saved" ? r : { ...r, selected: e.target.checked })))}
                    className="size-4 accent-[var(--accent)]"
                  />
                </th>
                {["图片", "名称 *", "系列 *", "种类 *", "角色", "尺寸 / 规格", "自封袋", "状态", "数量", "备注", ""].map((h, i) => (
                  <th key={i} className="px-2 py-2 font-normal border-b border-line whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const miss = missing(r);
                const locked = r.state === "saved" || r.state === "saving";
                const dupExisting = !!r.name.trim() && existingNames.has(r.name.trim()) && r.state !== "saved";
                const dupBatch = (nameCounts.get(r.name.trim()) ?? 0) > 1;
                return (
                  <tr key={r.key} className={cx("align-top", r.state === "saved" && "opacity-50", r.selected && "bg-accent/5", r.state === "error" && "bg-accent/5")}>
                    <td className="pl-3 md:pl-6 pr-2 py-2 border-b border-line">
                      <div className="flex flex-col items-center gap-1 pt-2">
                        <input
                          type="checkbox"
                          aria-label={`选择第 ${idx + 1} 行`}
                          checked={r.selected}
                          disabled={locked}
                          onChange={(e) => patch(r.key, { selected: e.target.checked })}
                          className="size-4 accent-[var(--accent)]"
                        />
                        <span className="text-[11px] text-muted tabular-nums">{idx + 1}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <ImageCell row={r} disabled={locked} onAdd={(fs) => addImagesToRow(r.key, fs)} onRemove={(k) => removeImage(r.key, k)} />
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <input
                        value={r.name}
                        disabled={locked}
                        onChange={(e) => patch(r.key, { name: e.target.value })}
                        className={cx(inputCls, "h-9 text-sm px-2", !r.name.trim() && "border-accent/70")}
                        placeholder="名称"
                        aria-label="名称"
                      />
                      {(dupExisting || dupBatch) && (
                        <p className="mt-1 text-[12px] text-gold">{dupExisting ? "已有同名谷子" : "本批中有重名"}</p>
                      )}
                      <RowStatus r={r} miss={miss} />
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <Locked on={locked}>
                        <OptionPicker compact invalid={!r.series.length} label="系列" options={meta.series} value={r.series} onChange={(v) => patch(r.key, { series: v })} onCreate={createOpt("series")} />
                      </Locked>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <Locked on={locked}>
                        <OptionPicker<Kind> compact multi invalid={!r.kinds.length} label="种类" options={meta.kinds} value={r.kinds} onChange={(v) => patch(r.key, { kinds: v })} onCreate={createKind} groupLabel={(k) => groupName.get(k.group_id) ?? ""} />
                      </Locked>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <Locked on={locked}>
                        <OptionPicker compact multi label="角色" options={meta.characters} value={r.characters} onChange={(v) => patch(r.key, { characters: v })} onCreate={createOpt("character")} placeholder="—" />
                      </Locked>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <input value={r.spec} disabled={locked} onChange={(e) => patch(r.key, { spec: e.target.value })} list="bulk-spec-list" className={cx(inputCls, "h-9 text-sm px-2")} placeholder="—" aria-label="尺寸规格" />
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <Locked on={locked}>
                        <OptionPicker compact label="自封袋尺寸" options={meta.bag_sizes} value={r.bag} onChange={(v) => patch(r.key, { bag: v })} onCreate={createOpt("bag_size")} placeholder="—" />
                      </Locked>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <select value={r.status} disabled={locked} onChange={(e) => patch(r.key, { status: e.target.value })} className={cx(inputCls, "h-9 text-sm px-2")} aria-label="状态">
                        {meta.statuses.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <input
                        inputMode="numeric"
                        value={r.quantity}
                        disabled={locked}
                        onChange={(e) => patch(r.key, { quantity: Math.min(9999, Math.max(1, parseInt(e.target.value) || 1)) })}
                        className={cx(inputCls, "h-9 text-sm px-2 text-center tabular-nums")}
                        aria-label="数量"
                      />
                    </td>
                    <td className="px-2 py-2 border-b border-line">
                      <input value={r.note} disabled={locked} onChange={(e) => patch(r.key, { note: e.target.value })} className={cx(inputCls, "h-9 text-sm px-2")} placeholder="—" aria-label="备注" />
                    </td>
                    <td className="px-2 pr-3 md:pr-6 py-2 border-b border-line whitespace-nowrap">
                      {r.state === "saved" && r.savedId ? (
                        <Link to={`/item/${r.savedId}`} className="text-xs text-gold hover:underline">查看</Link>
                      ) : (
                        <>
                          <IconButton label="复制本行（不含图片）" className="size-8" disabled={locked} onClick={() => duplicateRow(r.key)}><Copy size={15} /></IconButton>
                          <IconButton label="删除本行" className="size-8 hover:text-accent" disabled={locked} onClick={() => removeRows(new Set([r.key]))}><X size={16} /></IconButton>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="bulk-spec-list">{meta.specs.map((s) => <option key={s} value={s} />)}</datalist>
          <p className="px-3 md:px-6 py-3 text-xs text-muted">继续把图片拖进页面可追加行；拖到某行的图片格可给该行追加图片（第一张为封面）。</p>
        </div>
      )}

      {/* footer */}
      {rows.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 safe-x bg-canvas/95 backdrop-blur-md border-t border-line">
          <div className="px-3 md:px-6 pt-3 pb-safe flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted tabular-nums">
              待保存 {pending.length} 行 · {imageCount} 张图
              {incomplete.length > 0 && <span className="text-accent"> · {incomplete.length} 行待补全</span>}
              {savedCount > 0 && <span className="text-gold"> · 已保存 {savedCount}</span>}
            </span>
            {saving && (
              <span className="text-sm inline-flex items-center gap-2">
                <Loader2 size={15} className="animate-spin text-accent" />
                正在保存第 {saving.row + 1} / {saving.total} 行{saving.imgs && ` · ${saving.imgs}`}
                <span className="w-32 h-1.5 rounded-full bg-ink/10 overflow-hidden inline-block">
                  <span className="block h-full bg-accent transition-[width]" style={{ width: `${(saving.row / saving.total) * 100}%` }} />
                </span>
              </span>
            )}
            <div className="flex-1" />
            {savedCount > 0 && !busy && (
              <Button variant="ghost" onClick={clearSaved}>清除已保存</Button>
            )}
            <Button variant="primary" onClick={saveAll} disabled={busy || !ready.length}>
              {busy ? "保存中…" : `保存 ${ready.length} 行`}
            </Button>
          </div>
        </div>
      )}

      {dragging && (
        <div className="fixed inset-0 z-40 bg-scrim backdrop-blur-sm grid place-items-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-gold bg-surface px-10 py-8 text-center">
            <Rows3 size={32} className="mx-auto text-gold" />
            <p className="mt-2 text-lg">松开以添加（每张图一行）</p>
          </div>
        </div>
      )}

      <BatchDialog
        open={batchOpen}
        count={selected.length || pending.length}
        scope={selected.length ? "所选" : "全部未保存"}
        onClose={() => setBatchOpen(false)}
        onApply={(p) => {
          const target = new Set((selected.length ? selected : pending).map((r) => r.key));
          setRows((rs) => rs.map((r) => (target.has(r.key) ? { ...r, ...p, ...(r.state === "error" ? { state: "draft" as const, error: undefined } : {}) } : r)));
          setBatchOpen(false);
          toast(`已更新 ${target.size} 行`);
        }}
        createOpt={createOpt}
        createKind={createKind}
        groupName={groupName}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`删除所选 ${selected.length} 行？`}
        message="只删除表格中的行，不会影响已保存的谷子。"
        confirmLabel="删除"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          removeRows(new Set(selected.map((r) => r.key)));
          setConfirmDelete(false);
        }}
      />
      {kindDialog}
    </div>
  );
}

function Locked({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <div className={cx(on && "pointer-events-none")}>{children}</div>;
}

function RowStatus({ r, miss }: { r: Row; miss: string[] }) {
  if (r.state === "saving") return <p className="mt-1 text-[12px] text-accent inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" />保存中…</p>;
  if (r.state === "saved") return <p className="mt-1 text-[12px] text-gold inline-flex items-center gap-1"><Check size={12} />已保存</p>;
  if (r.state === "error")
    return (
      <p className="mt-1 text-[12px] text-accent inline-flex items-start gap-1">
        <AlertCircle size={12} className="mt-0.5 shrink-0" />
        失败：{r.error}
        {r.savedId ? `（条目已建，已传 ${r.uploaded}/${r.images.length} 张图，重试会继续上传）` : ""}
      </p>
    );
  if (miss.length) return <p className="mt-1 text-[12px] text-accent">缺少：{miss.join("、")}</p>;
  return null;
}

function ImageCell({ row, disabled, onAdd, onRemove }: { row: Row; disabled: boolean; onAdd: (fs: File[]) => void; onRemove: (k: string) => void }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onAdd([...e.dataTransfer.files]);
      }}
      className={cx("flex items-center gap-1.5 min-h-[76px] rounded-lg p-1 border border-dashed", over ? "border-gold bg-gold/10" : "border-transparent")}
    >
      {row.images.slice(0, 3).map((img, i) => (
        <div key={img.key} className={cx("relative shrink-0 w-12 h-16 rounded-md overflow-hidden well border", i === 0 ? "border-gold/60" : "border-line")}>
          {img.previewable ? (
            <img src={img.url} alt="" className="absolute inset-0 size-full object-contain" />
          ) : (
            <span className="absolute inset-0 grid place-items-center text-[10px] text-muted">HEIC</span>
          )}
          {!disabled && (
            <button type="button" aria-label="移除图片" onClick={() => onRemove(img.key)} className="absolute right-0 top-0 size-4 grid place-items-center rounded-bl bg-ink/60 text-canvas">
              <X size={10} />
            </button>
          )}
        </div>
      ))}
      {row.images.length > 3 && <span className="text-xs text-muted tabular-nums">+{row.images.length - 3}</span>}
      {!disabled && (
        <button type="button" onClick={() => ref.current?.click()} aria-label="给本行添加图片" className="shrink-0 w-9 h-16 rounded-md border border-dashed border-line grid place-items-center text-muted hover:text-accent hover:border-accent/50">
          <Plus size={14} />
        </button>
      )}
      <input ref={ref} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { onAdd([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
  );
}

function BatchDialog({
  open, count, scope, onClose, onApply, createOpt, createKind, groupName,
}: {
  open: boolean;
  count: number;
  scope: string;
  onClose: () => void;
  onApply: (p: Partial<Row>) => void;
  createOpt: ReturnType<typeof useOptionCreators>["createOpt"];
  createKind: ReturnType<typeof useOptionCreators>["createKind"];
  groupName: Map<number, string>;
}) {
  const { data: meta } = useMeta();
  const [series, setSeries] = useState<number[]>([]);
  const [kinds, setKinds] = useState<number[]>([]);
  const [characters, setCharacters] = useState<number[]>([]);
  const [bag, setBag] = useState<number[]>([]);
  const [status, setStatus] = useState("");
  const reset = () => { setSeries([]); setKinds([]); setCharacters([]); setBag([]); setStatus(""); };
  if (!meta) return null;
  const p: Partial<Row> = {
    ...(series.length ? { series } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(characters.length ? { characters } : {}),
    ...(bag.length ? { bag } : {}),
    ...(status ? { status } : {}),
  };
  const n = Object.keys(p).length;
  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={`批量设置 · ${scope} ${count} 行`}>
      <div className="px-5 pb-5 space-y-4">
        <p className="text-xs text-muted">只会覆盖填写了的字段，留空的字段保持各行原值。</p>
        <Field label="系列"><OptionPicker label="系列" options={meta.series} value={series} onChange={setSeries} onCreate={createOpt("series")} placeholder="不修改" /></Field>
        <Field label="种类"><OptionPicker<Kind> label="种类" multi options={meta.kinds} value={kinds} onChange={setKinds} onCreate={createKind} groupLabel={(k) => groupName.get(k.group_id) ?? ""} placeholder="不修改" /></Field>
        <Field label="角色"><OptionPicker label="角色" multi options={meta.characters} value={characters} onChange={setCharacters} onCreate={createOpt("character")} placeholder="不修改" /></Field>
        <Field label="自封袋尺寸"><OptionPicker label="自封袋尺寸" options={meta.bag_sizes} value={bag} onChange={setBag} onCreate={createOpt("bag_size")} placeholder="不修改" /></Field>
        <Field label="状态">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            <option value="">不修改</option>
            {meta.statuses.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>取消</Button>
          <Button variant="primary" disabled={!n} onClick={() => { onApply(p); reset(); }}>应用到 {count} 行</Button>
        </div>
      </div>
    </Dialog>
  );
}
