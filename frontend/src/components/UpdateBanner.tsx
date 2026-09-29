import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

const CHECK_EVERY_MS = 5 * 60_000;

/**
 * "有新版本，点击更新": compares this bundle's __BUILD_ID__ with the server's /version.json.
 * Works with or without the service worker (plain-http LAN tabs and the installed PWA alike).
 * Never reloads on its own — the user decides, so nothing half-typed is lost.
 */
export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let stopped = false;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return;
        const { build } = await r.json();
        if (!stopped && build && build !== __BUILD_ID__) {
          setLatest(build);
          // let the service worker fetch the new build in the background so the reload is instant
          navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
        }
      } catch {
        /* offline — try again later */
      }
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    const first = setTimeout(check, 5_000);
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!latest || latest === dismissed) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 z-[70] flex justify-center px-4 pointer-events-none"
      style={{ top: "max(0.75rem, var(--sat))" }}
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-ink text-canvas shadow-lg pl-4 pr-1 py-1 text-sm">
        <span>有新版本</span>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1 rounded-full bg-accent text-accent-ink px-3 h-8 ml-2 font-medium"
        >
          <RefreshCw size={14} /> 点击更新
        </button>
        <button aria-label="稍后" title="稍后" onClick={() => setDismissed(latest)} className="size-8 grid place-items-center rounded-full opacity-70 hover:opacity-100">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

/** Human-readable build time for the settings page. */
export const buildLabel = () => {
  const d = new Date(__BUILD_ID__);
  return Number.isNaN(d.getTime()) ? __BUILD_ID__ : d.toLocaleString("zh-CN", { hour12: false });
};
