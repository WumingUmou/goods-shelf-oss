import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

const EDGE = 20;      // px from the left edge where a swipe may start
const TRIGGER = 80;   // px of horizontal travel that counts as "back"

/** Installed iOS web apps (standalone) lose Safari's swipe-from-edge back gesture — restore it. */
function isStandalone() {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export function EdgeSwipeBack() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null);

  useEffect(() => {
    if (!isStandalone() || pathname === "/") return;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.clientX > EDGE) return;
      // leave horizontal widgets (image carousel, lightbox, bulk table) alone
      if ((e.target as Element).closest?.("[data-no-swipe-back], .pswp")) return;
      start.current = { x: t.clientX, y: t.clientY, active: false };
    };
    const onMove = (e: TouchEvent) => {
      const s = start.current;
      if (!s) return;
      const t = e.touches[0];
      const x = t.clientX - s.x;
      const y = Math.abs(t.clientY - s.y);
      if (!s.active) {
        if (y > 12 && y > x) { start.current = null; return; } // it's a vertical scroll
        if (x > 12) s.active = true;
      }
      if (s.active) setDx(Math.max(0, x));
    };
    const onEnd = () => {
      const s = start.current;
      start.current = null;
      setDx((cur) => {
        if (s?.active && cur >= TRIGGER) {
          if (window.history.state?.idx > 0) navigate(-1);
          else navigate("/", { replace: true });
        }
        return 0;
      });
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [pathname, navigate]);

  if (!dx) return null;
  const ready = dx >= TRIGGER;
  return (
    <div
      aria-hidden
      className="fixed left-0 top-1/2 z-[80] pointer-events-none -translate-y-1/2"
      style={{ transform: `translate(${Math.min(dx, TRIGGER + 24) - 44}px, -50%)` }}
    >
      <div className={`size-11 rounded-full grid place-items-center shadow-lg transition-colors ${ready ? "bg-accent text-accent-ink" : "bg-surface text-ink border border-line"}`}>
        <ChevronLeft size={22} />
      </div>
    </div>
  );
}
