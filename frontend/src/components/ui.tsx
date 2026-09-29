import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function Button({
  variant = "ghost",
  className,
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 h-10 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        variant === "primary" && "bg-accent text-accent-ink hover:brightness-110",
        variant === "danger" && "bg-accent/10 text-accent hover:bg-accent/20",
        variant === "outline" && "border border-line hover:border-gold/60 hover:bg-surface",
        variant === "ghost" && "hover:bg-ink/5",
        className,
      )}
    />
  );
}

export function IconButton({ label, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      {...p}
      className={cx("inline-flex items-center justify-center size-10 rounded-full text-ink/80 hover:bg-ink/5 hover:text-ink transition-colors", className)}
    />
  );
}

/** Centered dialog on desktop, bottom sheet on phones. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "relative w-full bg-surface text-ink shadow-2xl border border-line flex flex-col",
          "rounded-t-2xl md:rounded-2xl max-h-[calc(100dvh-var(--sat)-0.75rem)] md:max-h-[92dvh] pb-[var(--sab)] md:pb-0",
          wide ? "md:max-w-5xl md:mx-6" : "md:max-w-md md:mx-4",
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
            <h2 className="font-display text-lg">{title}</h2>
            <IconButton label="关闭" onClick={onClose} className="-mr-2">
              <X size={18} />
            </IconButton>
          </div>
        )}
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  onConfirm,
  onClose,
  busy,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="px-5 pb-5">
        <div className="text-sm text-muted leading-relaxed">{message}</div>
        <div className="mt-5 flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---- toasts ---------------------------------------------------------------

type Toast = { id: number; text: string; tone: "ok" | "err" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 5000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed inset-x-0 top-[calc(4rem+var(--sat))] md:top-auto md:bottom-6 z-[60] flex flex-col items-center gap-2 pointer-events-none px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto rounded-full px-4 py-2 text-sm shadow-lg border",
              t.tone === "err" ? "bg-accent text-accent-ink border-transparent" : "bg-surface text-ink border-line",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs tracking-wide text-muted mb-1.5">
        {label}
        {required && <span className="text-accent ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full h-11 rounded-lg bg-canvas border border-line px-3 text-[16px] outline-none focus:border-gold/70 focus:ring-2 focus:ring-gold/15 placeholder:text-muted/70";
