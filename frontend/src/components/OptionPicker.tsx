import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import type { Option } from "../api";
import { Button, cx, Dialog, inputCls } from "./ui";

/**
 * Searchable single/multi select that can create a new option by typing it.
 * Opens as a bottom sheet on phones / dialog on desktop.
 */
export function OptionPicker<T extends Option>({
  label,
  options,
  value,
  onChange,
  multi,
  onCreate,
  hint,
  placeholder = "请选择",
  groupLabel,
  compact,
  invalid,
}: {
  label: string;
  options: T[];
  value: number[];
  onChange: (ids: number[]) => void;
  multi?: boolean;
  onCreate?: (name: string) => Promise<T | null>;
  hint?: (o: T) => string | undefined;
  placeholder?: string;
  groupLabel?: (o: T) => string;
  /** dense trigger for table cells */
  compact?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selected = value.map((id) => byId.get(id)).filter(Boolean) as T[];

  const needle = q.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  const exact = options.some((o) => o.name === q.trim());

  const grouped = useMemo(() => {
    if (!groupLabel) return [["", filtered] as const];
    const m = new Map<string, T[]>();
    filtered.forEach((o) => {
      const g = groupLabel(o);
      m.set(g, [...(m.get(g) ?? []), o]);
    });
    return [...m.entries()];
  }, [filtered, groupLabel]);

  const pick = (id: number) => {
    if (multi) onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    else {
      onChange(value[0] === id ? [] : [id]);
      setOpen(false);
      setQ("");
    }
  };

  const create = async () => {
    if (!onCreate || !q.trim()) return;
    setBusy(true);
    try {
      const o = await onCreate(q.trim());
      if (o) {
        onChange(multi ? [...value, o.id] : [o.id]);
        setQ("");
        if (!multi) setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          inputCls,
          "relative flex items-center gap-1.5 text-left h-auto flex-wrap",
          compact ? "min-h-9 py-1 pl-2 pr-7 text-sm" : "min-h-11 py-1.5 pr-9",
          invalid && "border-accent/70",
        )}
      >
        {selected.length === 0 && <span className="text-muted/70 flex-1 min-w-0 truncate">{placeholder}</span>}
        {selected.map((o) =>
          multi ? (
            <span key={o.id} className={cx("inline-flex items-center gap-1 rounded-md bg-ink/5 border border-line pl-2 pr-1 text-sm", compact ? "h-6" : "h-7")}>
              {o.name}
              <span
                role="button"
                aria-label={`移除 ${o.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== o.id));
                }}
                className="p-0.5 text-muted hover:text-accent"
              >
                <X size={13} />
              </span>
            </span>
          ) : (
            <span key={o.id} className="flex-1 min-w-0 truncate">{o.name}</span>
          ),
        )}
        {/* pinned right so it never wraps onto its own line under the chips */}
        <ChevronDown size={16} className={cx("absolute top-1/2 -translate-y-1/2 text-muted pointer-events-none", compact ? "right-2" : "right-3")} />
      </button>

      <Dialog open={open} onClose={() => { setOpen(false); setQ(""); }} title={label}>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered.length === 1 && !onCreate) pick(filtered[0].id);
                  else if (!exact && onCreate) create();
                  else if (filtered[0]) pick(filtered[0].id);
                }
              }}
              placeholder={onCreate ? "搜索或输入新名称" : "搜索"}
              className={cx(inputCls, "pl-9")}
            />
          </div>
        </div>
        <div className="px-3 pb-4 max-h-[55dvh] overflow-y-auto">
          {onCreate && q.trim() && !exact && (
            <button
              type="button"
              disabled={busy}
              onClick={create}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-accent hover:bg-accent/10 text-left"
            >
              <Plus size={16} /> 新建「{q.trim()}」
            </button>
          )}
          {grouped.map(([g, opts]) => (
            <div key={g}>
              {g && <div className="px-3 pt-3 pb-1 text-[13px] tracking-[0.2em] text-gold">{g}</div>}
              {opts.map((o) => {
                const on = value.includes(o.id);
                return (
                  <button
                    type="button"
                    key={o.id}
                    onClick={() => pick(o.id)}
                    className={cx("w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left hover:bg-ink/5", on && "text-accent")}
                  >
                    <span className="flex-1">{o.name}</span>
                    {hint?.(o) && <span className="text-xs text-muted">{hint(o)}</span>}
                    {on && <Check size={16} />}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && !onCreate && <p className="px-3 py-6 text-center text-sm text-muted">无匹配项</p>}
        </div>
        {multi && (
          <div className="px-5 pb-5 border-t border-line pt-3">
            <Button variant="primary" className="w-full" onClick={() => { setOpen(false); setQ(""); }}>
              完成（已选 {value.length}）
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
