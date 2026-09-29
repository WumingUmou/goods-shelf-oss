import { useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { api, type AppSettings, type BrandKind, type SettingsInput } from "../api";
import { useMeta } from "../hooks";
import { Button, cx, inputCls, useToast } from "./ui";

/** Neutral defaults — must match SETTING_DEFAULTS in backend/app/models.py. */
const DEFAULT_COLOURS = {
  bar_light_bg: "#f3eee6",
  bar_light_ink: "#3a2d24",
  bar_dark_bg: "#1f1a16",
  bar_dark_ink: "#efe5d6",
} as const;
type ColourKey = keyof typeof DEFAULT_COLOURS;
type TextKey = "site_title" | "site_subtitle" | "app_name";

const ARTWORK: { kind: BrandKind; label: string; hint: string }[] = [
  { kind: "logo", label: "标题旁的图", hint: "显示在顶部标题左侧；建议透明背景 PNG，会自动裁掉空白、缩放到合适高度。" },
  { kind: "icon", label: "App 图标", hint: "添加到主屏幕时的图标；建议 1024×1024 正方形，会自动生成各种尺寸。" },
  { kind: "pattern_light", label: "背景图案 · 浅色", hint: "平铺在页面背景上；建议透明背景、很淡的图案。" },
  { kind: "pattern_dark", label: "背景图案 · 深色", hint: "深色模式使用；不上传则沿用浅色图案。" },
];

export function AppearanceSettings() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!meta) return null;
  const st = meta.settings;
  const val = <K extends keyof AppSettings>(k: K) => (draft[k] ?? st[k]) as AppSettings[K];
  const set = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = Object.entries(draft).some(([k, v]) => v !== st[k as keyof AppSettings]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["meta"] });
  const save = async () => {
    const body: SettingsInput = {};
    for (const k of ["site_title", "site_subtitle", "app_name", ...Object.keys(DEFAULT_COLOURS)] as (TextKey | ColourKey)[])
      if (draft[k] !== undefined) body[k] = draft[k];
    if (draft.pattern_size !== undefined) body.pattern_size = Number(draft.pattern_size);
    try {
      await api.updateSettings(body);
      await refresh();
      setDraft({});
      toast("外观已保存");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const upload = async (kind: BrandKind, file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    try {
      await api.uploadBrand(kind, file);
      await refresh();
      toast("已上传");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  const remove = async (kind: BrandKind) => {
    setBusy(kind);
    try {
      await api.deleteBrand(kind);
      await refresh();
      toast("已移除");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  const text = (k: TextKey, label: string, hint: string, max: number) => (
    <label className="block">
      <span className="block text-xs tracking-wide text-muted mb-1.5">{label}</span>
      <input value={val(k)} onChange={(e) => set({ [k]: e.target.value })} className={inputCls} maxLength={max} />
      <span className="block text-xs text-muted mt-1">{hint}</span>
    </label>
  );
  const colour = (k: ColourKey, label: string) => (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={val(k)}
        onChange={(e) => set({ [k]: e.target.value })}
        className="size-10 shrink-0 rounded-lg border border-line bg-transparent p-0.5 cursor-pointer"
        aria-label={label}
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted tabular-nums uppercase">{val(k)}</span>
      </span>
    </label>
  );
  const preview = (scheme: "light" | "dark") => {
    const bg = val(scheme === "light" ? "bar_light_bg" : "bar_dark_bg");
    const ink = val(scheme === "light" ? "bar_light_ink" : "bar_dark_ink");
    return (
      <div className="rounded-xl overflow-hidden border border-line">
        <div className="app-bar px-3 py-2.5" style={{ "--bar-bg": bg, "--bar-ink": ink } as CSSProperties}>
          <div className="flex items-center gap-2">
            {meta.brand.logo && <img src={meta.brand.logo} alt="" className="h-7 w-auto" />}
            <span className="font-display font-bold truncate">{val("site_title")}</span>
            {val("site_subtitle") && <span className="text-[12px] text-muted truncate">{val("site_subtitle")}</span>}
          </div>
          <div className="mt-2 flex gap-1 text-[13px]">
            <span className="rounded-full px-2.5 py-0.5 bg-accent text-accent-ink">全部</span>
            <span className="rounded-full px-2.5 py-0.5 text-muted">吧唧</span>
            <span className="rounded-full px-2.5 py-0.5 text-muted">卡片</span>
          </div>
        </div>
        <div className={cx("flex items-center justify-between px-3 py-2 text-xs", scheme === "light" ? "bg-[#f5f1ea] text-[#6b5d52]" : "bg-[#0f0c0a] text-[#a89a8a]")}>
          {scheme === "light" ? "浅色模式" : "深色模式"}
          <span
            className="fab-theme size-8 rounded-full grid place-items-center"
            style={{ "--bar-bg": bg, "--bar-ink": ink } as CSSProperties}
          >
            <Plus size={16} />
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <section className="space-y-4">
        <h3 className="text-sm text-ink">文字</h3>
        {text("site_title", "标题", "顶部栏的大标题。", 40)}
        {text("site_subtitle", "副标题", "标题右侧的小字（电脑宽度显示），可留空。", 40)}
        {text("app_name", "App 名称", "浏览器标签页标题，以及「添加到主屏幕」时的名字。", 30)}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm text-ink">配色</h3>
          <button
            type="button"
            onClick={() => set({ ...DEFAULT_COLOURS })}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
          >
            <RotateCcw size={13} /> 恢复默认配色
          </button>
        </div>
        <p className="text-xs text-muted">顶部栏和「＋」按钮使用这组颜色；手机状态栏也会跟随。</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            {preview("light")}
            <div className="grid grid-cols-2 gap-3">
              {colour("bar_light_bg", "浅色 · 背景")}
              {colour("bar_light_ink", "浅色 · 文字")}
            </div>
          </div>
          <div className="space-y-3">
            {preview("dark")}
            <div className="grid grid-cols-2 gap-3">
              {colour("bar_dark_bg", "深色 · 背景")}
              {colour("bar_dark_ink", "深色 · 文字")}
            </div>
          </div>
        </div>
      </section>

      <div className="sticky bottom-3 z-10">
        <Button variant="primary" onClick={save} disabled={!dirty} className="shadow-lg">
          保存更改
        </Button>
      </div>

      <section className="space-y-4">
        <h3 className="text-sm text-ink">图片</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {ARTWORK.map((a) => (
            <ArtworkSlot
              key={a.kind}
              {...a}
              url={a.kind === "icon" ? `/icons/icon-192.png?v=${st.asset_icon || "0"}` : meta.brand[a.kind as "logo" | "pattern_light" | "pattern_dark"]}
              isSet={!!st[`asset_${a.kind}` as keyof AppSettings]}
              busy={busy === a.kind}
              onUpload={(f) => upload(a.kind, f)}
              onRemove={() => remove(a.kind)}
            />
          ))}
        </div>
        <label className="block">
          <span className="block text-xs tracking-wide text-muted mb-1.5">背景图案大小：{val("pattern_size")}px（手机上显示为一半）</span>
          <input
            type="range"
            min={160}
            max={1280}
            step={40}
            value={Number(val("pattern_size"))}
            onChange={(e) => set({ pattern_size: e.target.value })}
            className="w-full accent-[var(--accent)]"
          />
        </label>
      </section>
    </div>
  );
}

function ArtworkSlot({
  label, hint, url, isSet, busy, onUpload, onRemove,
}: {
  kind: BrandKind;
  label: string;
  hint: string;
  url: string | null;
  isSet: boolean;
  busy: boolean;
  onUpload: (f: File | undefined) => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-xl border border-line bg-surface p-3 flex gap-3">
      <div className="well size-20 shrink-0 rounded-lg grid place-items-center overflow-hidden">
        {url ? <img src={url} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted">未设置</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        <p className="text-xs text-muted mt-0.5 leading-snug">{hint}</p>
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="outline" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => ref.current?.click()}>
            <Upload size={13} /> {busy ? "处理中…" : isSet ? "更换" : "上传"}
          </Button>
          {isSet && (
            <Button type="button" variant="ghost" className="h-8 px-2.5 text-xs" disabled={busy} onClick={onRemove}>
              <Trash2 size={13} /> 移除
            </Button>
          )}
        </div>
        <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}
