export type Option = { id: number; name: string; sort: number };
export type Group = Option;
export type Kind = Option & { group_id: number };
export type Series = Option & { section_title: string | null; card_face: string | null; theme_color: string | null };
export type OptionType = "group" | "kind" | "series" | "character" | "bag_size";

export type Meta = {
  groups: Group[];
  kinds: Kind[];
  series: Series[];
  characters: Option[];
  bag_sizes: Option[];
  statuses: string[];
  specs: string[];
  settings: AppSettings;
  /** uploaded artwork URLs (null = not set) */
  brand: { logo: string | null; pattern_light: string | null; pattern_dark: string | null };
  features: { image_search: boolean };
};

export type AppSettings = {
  site_title: string;
  site_subtitle: string;
  app_name: string;
  bar_light_bg: string;
  bar_light_ink: string;
  bar_dark_bg: string;
  bar_dark_ink: string;
  pattern_size: string;
  asset_logo: string;
  asset_icon: string;
  asset_pattern_light: string;
  asset_pattern_dark: string;
  search_prefix: string;
  default_character: string;
};
export type BrandKind = "logo" | "icon" | "pattern_light" | "pattern_dark";
export type SettingsInput = Partial<Omit<AppSettings, "pattern_size" | `asset_${string}`>> & { pattern_size?: number };

export type SearchCandidate = {
  id: string;
  width: number;
  height: number;
  engine: string;
  source_host: string;
  source_url: string;
  page_url: string | null;
  title: string | null;
};
export type SearchResult = { query: string; candidates: SearchCandidate[]; tried: number; unresponsive: string[] };
export const previewSrc = (c: SearchCandidate) => `/api/image-search/preview/${c.id}.webp`;

export type ItemImage = {
  id: number;
  sha256: string;
  ext: string;
  width: number;
  height: number;
  sort: number;
  low_res: boolean;
};

export type Item = {
  id: number;
  name: string;
  series_id: number;
  bag_size_id: number | null;
  spec: string | null;
  status: string;
  quantity: number;
  note: string | null;
  sort: number; // position within its series
  created_at: string;
  updated_at: string;
  kind_ids: number[];
  character_ids: number[];
  images: ItemImage[];
};

export type ItemInput = {
  name: string;
  series_id: number;
  kind_ids: number[];
  character_ids: number[];
  bag_size_id: number | null;
  spec: string | null;
  status: string;
  quantity: number;
  note: string | null;
};

export type ImportPreview = {
  token: string;
  rows: {
    row: number;
    name: string;
    series: string;
    kinds: string[];
    characters: string[];
    bag_size: string | null;
    spec: string | null;
    status: string;
    quantity: number;
    image_size: [number, number] | null;
    low_res: boolean;
    duplicate: boolean;
    warnings: string[];
  }[];
  new_options: Record<"series" | "kind" | "character" | "bag_size", string[]>;
  new_kinds_to_other: string[];
};

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail)) msg = j.detail.map((d: { msg: string }) => d.msg).join("；");
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  meta: () => req<Meta>("GET", "/api/meta"),
  items: () => req<Item[]>("GET", "/api/items"),
  item: (id: number) => req<Item>("GET", `/api/items/${id}`),
  createItem: (b: ItemInput) => req<Item>("POST", "/api/items", b),
  updateItem: (id: number, b: ItemInput) => req<Item>("PUT", `/api/items/${id}`, b),
  deleteItem: (id: number) => req<{ ok: true }>("DELETE", `/api/items/${id}`),
  /** XHR instead of fetch so upload progress (0–1) can be reported. */
  uploadImages: (id: number, files: File[], onProgress?: (p: number) => void) =>
    new Promise<ItemImage[]>((resolve, reject) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/items/${id}/images`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body: { detail?: unknown } | ItemImage[] | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not json */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as ItemImage[]);
        else {
          const d = (body as { detail?: unknown } | null)?.detail;
          reject(new Error(typeof d === "string" ? d : `上传失败（${xhr.status}）`));
        }
      };
      xhr.onerror = () => reject(new Error("网络错误，图片上传失败"));
      xhr.send(fd);
    }),
  imageSearch: (q: string) => req<SearchResult>("POST", "/api/image-search", { q }),
  fromSearch: (id: number, candidateId: string) =>
    req<ItemImage>("POST", `/api/items/${id}/images/from-search`, { candidate_id: candidateId }),
  updateSettings: (body: SettingsInput) => req<AppSettings>("PUT", "/api/settings", body),
  uploadBrand: (kind: BrandKind, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<AppSettings>("POST", `/api/brand/${kind}`, fd);
  },
  deleteBrand: (kind: BrandKind) => req<AppSettings>("DELETE", `/api/brand/${kind}`),
  orderSeriesItems: (seriesId: number, ids: number[]) => req("PUT", `/api/series/${seriesId}/items/order`, { ids }),
  orderImages: (id: number, ids: number[]) => req("PUT", `/api/items/${id}/images/order`, { ids }),
  deleteImage: (id: number) => req("DELETE", `/api/images/${id}`),
  createOption: <T extends Option = Option>(type: OptionType, body: Record<string, unknown>) =>
    req<T>("POST", `/api/options/${type}`, body),
  updateOption: (type: OptionType, id: number, body: Record<string, unknown>) =>
    req("PATCH", `/api/options/${type}/${id}`, body),
  deleteOption: (type: OptionType, id: number) => req("DELETE", `/api/options/${type}/${id}`),
  orderOptions: (type: OptionType, ids: number[]) => req("PUT", `/api/options/${type}/order`, { ids }),
  importPreview: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<ImportPreview>("POST", "/api/import/xlsx", fd);
  },
  importCommit: (token: string) =>
    req<{ created: number; skipped: number }>("POST", `/api/import/xlsx/${token}/commit`),
};

/** srcset for content-addressed WebP variants. */
export function imgSrcSet(img: ItemImage) {
  const long = Math.max(img.width, img.height);
  const out: string[] = [];
  for (const s of [400, 800, 1600]) {
    // variants never upscale, so stop at the first one that holds the full original
    const w = s < long ? Math.round((img.width * s) / long) : img.width;
    out.push(`/media/${s}/${img.sha256}.webp ${w}w`);
    if (s >= long) break;
  }
  return out.join(", ");
}
export const imgSrc = (img: ItemImage, size: 400 | 800 | 1600 = 800) => `/media/${size}/${img.sha256}.webp`;
export const origSrc = (img: ItemImage) => `/media/orig/${img.sha256}.${img.ext}`;

// ---- operation log (/logs) -------------------------------------------------

export type HostInfo = { name: string | null; via: "tailscale" | "lan" | "alias" | "unknown"; alias: string | null; os?: string; dns?: string | null };
export type LogFilter = { ip?: string; action?: string; since?: string };
export type LogEntry = {
  id: number; ts: string; ip: string; host: string | null; via: HostInfo["via"];
  method: string; path: string; status: number; duration_ms: number; action: string;
  item_id: number | null; item_name: string | null; detail: string | null; user_agent: string | null;
};
type LastOp = { ts: string; action: string; ip: string; host: string | null; detail: string | null; status: number } | null;
export type LogSummary = {
  total: number; writes: number; errors: number; first_ts: string | null; last_ts: string | null;
  last: LastOp; last_write: LastOp;
  by_action: { action: string; count: number; last_ts: string }[];
  by_ip: ({ ip: string; count: number; writes: number; last_ts: string; last_action: string | null } & HostInfo)[];
};
export type LogHosts = {
  actions: string[]; read_actions: string[]; write_key: string;
  hosts: ({ ip: string; count: number; last_ts: string } & HostInfo)[];
};

function logQuery(f: LogFilter, extra: Record<string, string> = {}) {
  const q = new URLSearchParams(extra);
  if (f.ip) q.append("ip", f.ip);
  if (f.action) q.set("action", f.action);
  if (f.since) q.set("since", f.since);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const logsApi = {
  summary: (f: LogFilter) => req<LogSummary>("GET", `/api/logs/summary${logQuery(f)}`),
  recent: (f: LogFilter, limit: number) => req<LogEntry[]>("GET", `/api/logs${logQuery(f, { limit: String(limit) })}`),
  hosts: () => req<LogHosts>("GET", "/api/logs/hosts"),
  setAlias: (ip: string, name: string) => req("PUT", "/api/logs/alias", { ip, name }),
};

/** {prefix} {series} {name minus series prefix} {kinds} {characters}, de-duplicated by word. */
export function buildSearchQuery(prefix: string, series: string, name: string, kinds: string[], characters: string[]) {
  let n = name.trim();
  if (series && n.startsWith(series)) n = n.slice(series.length).replace(/^[\s\-–—·:：]+/, "");
  const words: string[] = [];
  for (const part of [prefix, series, n, ...kinds, ...characters])
    for (const w of (part || "").replace(/ - /g, " ").split(/\s+/)) if (w && !words.includes(w)) words.push(w);
  return words.join(" ");
}
