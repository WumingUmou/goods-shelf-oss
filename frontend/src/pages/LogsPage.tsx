import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, Pencil, RefreshCw, X } from "lucide-react";
import { logsApi, type HostInfo, type LogEntry, type LogFilter } from "../api";
import { cx, IconButton, useToast } from "../components/ui";

/** Hidden operation-log page — reachable only via /logs. */

const RANGES: [string, string, number | null][] = [
  ["1h", "1 小时", 3600e3],
  ["24h", "24 小时", 86400e3],
  ["7d", "7 天", 7 * 86400e3],
  ["30d", "30 天", 30 * 86400e3],
  ["all", "全部", null],
];

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function ago(iso: string | null | undefined) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const VIA: Record<HostInfo["via"], string> = { tailscale: "Tailscale", lan: "局域网", alias: "自定义", unknown: "未知" };

export default function LogsPage() {
  const [ip, setIp] = useState("");
  const [action, setAction] = useState("");
  const [range, setRange] = useState("7d");
  const [limit, setLimit] = useState(200);
  const [auto, setAuto] = useState(true);
  // advance the time window every minute so "last 1h" keeps sliding
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const filter: LogFilter = useMemo(() => {
    const ms = RANGES.find((r) => r[0] === range)?.[2];
    // round to the minute so the query key stays stable between renders
    const since = ms ? new Date(Math.floor((Date.now() - ms) / 60000) * 60000).toISOString() : undefined;
    return { ip: ip || undefined, action: action || undefined, since };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ip, action, range, tick]);

  const refetchInterval = auto ? 30_000 : false;
  const hosts = useQuery({ queryKey: ["logs", "hosts"], queryFn: logsApi.hosts, refetchInterval });
  const summary = useQuery({ queryKey: ["logs", "summary", filter], queryFn: () => logsApi.summary(filter), refetchInterval });
  const recent = useQuery({ queryKey: ["logs", "recent", filter, limit], queryFn: () => logsApi.recent(filter, limit), refetchInterval });
  const qc = useQueryClient();
  const s = summary.data;
  const writeKey = hosts.data?.write_key ?? "__write";
  const readSet = new Set(hosts.data?.read_actions ?? []);
  const maxAction = Math.max(1, ...(s?.by_action.map((a) => a.count) ?? [1]));
  const fetching = summary.isFetching || recent.isFetching;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 safe-top safe-x app-bar">
        <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3">
          <Activity size={20} className="text-gold" />
          <h1 className="font-display text-lg">操作日志</h1>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--accent)]" />
            每 30 秒刷新
          </label>
          <IconButton label="刷新" onClick={() => qc.invalidateQueries({ queryKey: ["logs"] })}>
            <RefreshCw size={17} className={cx(fetching && "animate-spin")} />
          </IconButton>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 pb-16 space-y-6">
        {/* filters */}
        <section className="flex flex-wrap items-center gap-2">
          <select value={ip} onChange={(e) => setIp(e.target.value)} className="h-9 rounded-lg bg-surface border border-line px-2 text-sm max-w-full" aria-label="设备">
            <option value="">全部设备</option>
            {hosts.data?.hosts.map((h) => (
              <option key={h.ip} value={h.ip}>
                {h.name ?? h.ip}
                {h.name ? ` (${h.ip})` : ""}
              </option>
            ))}
          </select>
          <select value={action} onChange={(e) => setAction(e.target.value)} className="h-9 rounded-lg bg-surface border border-line px-2 text-sm" aria-label="类别">
            <option value="">全部类别</option>
            <option value={writeKey}>仅写操作</option>
            {hosts.data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <div className="flex rounded-lg border border-line p-0.5 bg-surface">
            {RANGES.map(([k, label]) => (
              <button key={k} onClick={() => setRange(k)} className={cx("h-8 px-2.5 rounded-md text-sm", range === k ? "bg-ink text-canvas" : "text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
          {(ip || action) && (
            <button onClick={() => { setIp(""); setAction(""); }} className="h-9 px-3 text-sm text-accent hover:underline">
              清除筛选
            </button>
          )}
        </section>

        {summary.error && <p className="text-accent text-sm">加载失败：{(summary.error as Error).message}</p>}

        {/* stat tiles */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="总操作数" value={s?.total ?? "—"} sub={s ? `写操作 ${s.writes} · 失败 ${s.errors}` : ""} />
          <Tile
            label="上次操作"
            value={ago(s?.last?.ts)}
            sub={s?.last ? `${s.last.action} · ${s.last.host ?? s.last.ip}` : "暂无"}
            title={s?.last ? fmtTime(s.last.ts) : undefined}
          />
          <Tile
            label="上次写操作"
            value={ago(s?.last_write?.ts)}
            sub={s?.last_write ? `${s.last_write.action}${s.last_write.detail ? ` · ${s.last_write.detail}` : ""}` : "暂无"}
            title={s?.last_write ? `${fmtTime(s.last_write.ts)} · ${s.last_write.host ?? s.last_write.ip}` : undefined}
          />
          <Tile label="活跃设备" value={s?.by_ip.length ?? "—"} sub={s?.first_ts ? `最早记录 ${fmtTime(s.first_ts)}` : ""} />
        </section>

        <section className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          {/* by device */}
          <Panel title="按设备">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-normal">设备</th>
                    <th className="py-2 pr-3 font-normal text-right whitespace-nowrap">操作</th>
                    <th className="py-2 pr-3 font-normal text-right">写</th>
                    <th className="py-2 pr-3 font-normal">最近</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s?.by_ip.map((h) => (
                    <tr key={h.ip} className={cx("align-top", ip === h.ip && "bg-accent/5")}>
                      <td className="py-2 pr-3">
                        <HostCell ip={h.ip} info={h} onPick={() => setIp(ip === h.ip ? "" : h.ip)} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{h.count}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted">{h.writes}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <div title={fmtTime(h.last_ts)}>{ago(h.last_ts)}</div>
                        <div className="text-xs text-muted">{h.last_action}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s && s.by_ip.length === 0 && <Empty />}
            </div>
          </Panel>

          {/* by action */}
          <Panel title="按类别">
            <ul className="space-y-2">
              {s?.by_action.map((a) => (
                <li key={a.action}>
                  <button onClick={() => setAction(action === a.action ? "" : a.action)} className={cx("w-full text-left group", action === a.action && "text-accent")}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span>{a.action}</span>
                      <span className="tabular-nums text-muted text-xs">
                        {a.count} · {ago(a.last_ts)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-ink/5 overflow-hidden">
                      <div
                        className={cx("h-full rounded-full", readSet.has(a.action) ? "bg-ink/30" : "bg-accent/80")}
                        style={{ width: `${(a.count / maxAction) * 100}%` }}
                      />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {s && s.by_action.length === 0 && <Empty />}
          </Panel>
        </section>

        {/* history */}
        <Panel
          title={`操作记录 · 最新 ${recent.data?.length ?? 0} 条`}
          right={
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="h-8 rounded-md bg-canvas border border-line px-2 text-xs" aria-label="条数">
              <option value={100}>100 条</option>
              <option value={200}>200 条</option>
            </select>
          }
        >
          <div className="max-h-[70dvh] overflow-y-auto -mx-4 px-4">
            <ul className="divide-y divide-line">
              {recent.data?.map((l) => <LogRow key={l.id} l={l} read={readSet.has(l.action)} />)}
            </ul>
            {recent.data && recent.data.length === 0 && <Empty />}
          </div>
        </Panel>
      </main>
    </div>
  );
}

function Tile({ label, value, sub, title }: { label: string; value: React.ReactNode; sub?: string; title?: string }) {
  return (
    <div className="rounded-xl bg-surface border border-line p-4 min-w-0" title={title}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-display text-2xl tabular-nums truncate">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted truncate">{sub}</div>}
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-surface border border-line p-4 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm tracking-wide text-muted">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const Empty = () => <p className="py-8 text-center text-sm text-muted">这个范围内没有记录</p>;

function HostCell({ ip, info, onPick }: { ip: string; info: HostInfo; onPick: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(info.alias ?? "");
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    try {
      await logsApi.setAlias(ip, val);
      await qc.invalidateQueries({ queryKey: ["logs"] });
      setEditing(false);
      toast(val.trim() ? `已命名为「${val.trim()}」` : "已清除自定义名称");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  if (editing)
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          placeholder="设备名（留空清除）"
          className="h-8 w-40 rounded-md bg-canvas border border-line px-2 text-sm"
        />
        <IconButton label="保存" className="size-8" onClick={save}><Check size={15} /></IconButton>
        <IconButton label="取消" className="size-8" onClick={() => setEditing(false)}><X size={15} /></IconButton>
      </div>
    );
  return (
    <div className="flex items-start gap-1 min-w-0">
      <button onClick={onPick} className="text-left min-w-0" title="按此设备筛选">
        <div className="truncate hover:text-accent">{info.name ?? <span className="text-muted">未知设备</span>}</div>
        <div className="text-xs text-muted tabular-nums">
          {ip} · {VIA[info.via]}
          {info.os ? ` · ${info.os}` : ""}
        </div>
      </button>
      <button aria-label="命名" title="自定义名称" onClick={() => setEditing(true)} className="p-1 text-muted hover:text-ink shrink-0">
        <Pencil size={13} />
      </button>
    </div>
  );
}

function LogRow({ l, read }: { l: LogEntry; read: boolean }) {
  const failed = l.status >= 400;
  const what = l.detail ?? l.item_name ?? (l.item_id ? `#${l.item_id}` : "");
  const host = l.host ?? l.ip;
  const hostTitle = `${l.ip}${l.user_agent ? `\n${l.user_agent}` : ""}`;
  const action = <span className={cx("whitespace-nowrap", read ? "text-muted" : "text-accent")}>{l.action}</span>;
  const result = (
    <span className={cx("text-xs tabular-nums whitespace-nowrap text-right", failed ? "text-accent font-semibold" : "text-muted")}>
      {failed ? `失败 ${l.status}` : `${l.duration_ms}ms`}
    </span>
  );
  return (
    <li className="py-2.5 text-sm">
      {/* phones: two compact lines */}
      <div className="sm:hidden">
        <div className="flex justify-between gap-3 text-xs text-muted">
          <span className="tabular-nums whitespace-nowrap">{fmtTime(l.ts)}</span>
          <span className="truncate" title={hostTitle}>{host}</span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {action}
          <span className="flex-1 truncate text-ink/90" title={what}>{what}</span>
          {result}
        </div>
      </div>
      {/* wider screens: one row */}
      <div className="hidden sm:grid grid-cols-[9.5rem_10rem_6.5rem_1fr_auto] gap-x-3 items-baseline">
        <span className="text-xs text-muted tabular-nums whitespace-nowrap">{fmtTime(l.ts)}</span>
        <span className="truncate" title={hostTitle}>{host}</span>
        {action}
        <span className="truncate text-ink/90" title={what}>{what}</span>
        {result}
      </div>
    </li>
  );
}
