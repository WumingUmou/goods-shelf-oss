import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Search, Sparkles, X } from "lucide-react";
import { api, previewSrc, type SearchCandidate, type SearchResult } from "../api";
import { Button, cx, inputCls } from "./ui";

/**
 * Auto image search: server fetches + verifies up to 10 candidates; the first is
 * pre-selected. Only one auto-picked image is kept — picking another replaces it.
 */
export function ImageSearchPanel({
  defaultQuery,
  autoRun,
  selectedId,
  onSelect,
  onClose,
}: {
  defaultQuery: string;
  autoRun: boolean;
  selectedId: string | null;
  onSelect: (c: SearchCandidate | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const ran = useRef(false);

  const run = async (q = query) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    try {
      const r = await api.imageSearch(q.trim());
      setResult(r);
      // default: first candidate
      onSelect(r.candidates[0] ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoRun && !ran.current) {
      ran.current = true;
      run(defaultQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cands = result?.candidates ?? [];

  return (
    <div className="mt-3 rounded-xl border border-gold/40 bg-surface p-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={15} className="text-gold shrink-0" />
        <span className="text-sm">自动搜图</span>
        <span className="text-xs text-muted truncate">· 默认选第一张，只保留一张</span>
        <div className="flex-1" />
        <button type="button" aria-label="收起自动搜图" onClick={onClose} className="p-1 text-muted hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          className={cx(inputCls, "h-10")}
          placeholder="搜索关键词"
          aria-label="搜索关键词"
        />
        <Button type="button" variant="outline" onClick={() => run()} disabled={busy || !query.trim()} className="shrink-0">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          搜索
        </Button>
      </div>

      {busy && (
        <div className="mt-3">
          <p className="text-xs text-muted mb-2">正在搜索并下载候选图片… {elapsed}s（通常 3–10 秒）</p>
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="shrink-0 w-24 aspect-[3/4] rounded-lg well animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {!busy && error && <p className="mt-3 text-sm text-accent">搜索失败：{error}。可以稍后重试，或手动上传。</p>}

      {!busy && result && cands.length === 0 && (
        <p className="mt-3 text-sm text-muted">没找到可用图片（尝试了 {result.tried} 张），请修改关键词或手动上传。</p>
      )}

      {!busy && cands.length > 0 && (
        <>
          <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar pb-1" role="listbox" aria-label="候选图片">
            {cands.map((c, i) => {
              const on = c.id === selectedId;
              return (
                <button
                  type="button"
                  key={c.id}
                  role="option"
                  aria-selected={on}
                  onClick={() => onSelect(on ? null : c)}
                  title={`${c.title ?? ""}\n${c.source_host}`}
                  className={cx(
                    "relative shrink-0 w-24 aspect-[3/4] rounded-lg overflow-hidden well border-2 transition-colors",
                    on ? "border-gold" : "border-transparent hover:border-line",
                  )}
                >
                  <img src={previewSrc(c)} alt={`候选 ${i + 1}`} className="absolute inset-0 size-full object-contain p-1" loading="lazy" />
                  {on && (
                    <span className="absolute left-1 top-1 size-5 rounded-full bg-gold text-canvas grid place-items-center">
                      <Check size={13} />
                    </span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-ink/60 text-canvas text-[11px] leading-4 px-1 truncate tabular-nums">
                    {c.width}×{c.height}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted truncate">
            {selectedId
              ? `已选：${cands.find((c) => c.id === selectedId)?.source_host ?? ""}（保存时加入图片）`
              : "未选择 —— 点击候选图片选用"}
          </p>
        </>
      )}
    </div>
  );
}
