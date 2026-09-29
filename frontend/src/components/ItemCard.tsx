import { memo } from "react";
import { Link, useLocation } from "react-router-dom";
import { ImageOff } from "lucide-react";
import { imgSrc, imgSrcSet, type Item } from "../api";
import type { Density, Lookups } from "../hooks";
import { cx } from "./ui";

const SIZES: Record<Density, string> = {
  s: "(min-width: 1280px) 12vw, (min-width: 1024px) 16vw, (min-width: 640px) 25vw, 33vw",
  m: "(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw",
  l: "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
};

export const ItemCard = memo(function ItemCard({
  item,
  lk,
  density,
  modal,
  arranging = false,
}: {
  item: Item;
  lk: Lookups;
  density: Density;
  modal: boolean;
  /** 整理模式: plain block (no link, no hover lift) so it can be dragged */
  arranging?: boolean;
}) {
  const location = useLocation();
  const cover = item.images[0];
  const kinds = item.kind_ids.map((k) => lk.kind.get(k)?.name).filter(Boolean) as string[];
  const chars = item.character_ids.map((c) => lk.character.get(c)?.name).filter(Boolean);
  const small = density === "s";
  const pending = item.status !== "已入库";

  const body = (
    <>
      <div className="well relative" style={{ aspectRatio: "var(--card-ratio)" }}>
        {cover ? (
          <img
            src={imgSrc(cover, 400)}
            srcSet={imgSrcSet(cover)}
            sizes={SIZES[density]}
            width={cover.width}
            height={cover.height}
            alt={item.name}
            loading="lazy"
            decoding="async"
            draggable={!arranging}
            className="absolute inset-0 size-full object-contain p-[6%] drop-shadow-[0_6px_14px_rgb(0_0_0/0.18)] transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted/60">
            <ImageOff size={small ? 18 : 26} strokeWidth={1.25} />
          </div>
        )}
        {!small && kinds[0] && (
          <span className="absolute left-2 top-2 max-w-[70%] truncate rounded-[4px] border border-gold/40 bg-surface/85 backdrop-blur px-1.5 py-0.5 text-[12px] leading-none text-gold tracking-wide">
            {kinds[0]}
            {kinds.length > 1 && <span className="opacity-70"> +{kinds.length - 1}</span>}
          </span>
        )}
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          {item.quantity > 1 && (
            <span className="rounded-full bg-ink/80 text-canvas px-1.5 py-0.5 text-[12px] font-semibold leading-none tabular-nums">
              ×{item.quantity}
            </span>
          )}
          {pending && !small && (
            <span className="rounded-[4px] bg-accent text-accent-ink px-1.5 py-0.5 text-[12px] leading-none">{item.status}</span>
          )}
        </div>
        {pending && small && <span className="absolute right-1.5 bottom-1.5 size-1.5 rounded-full bg-accent" />}
      </div>
      <div className={cx("px-2.5", small ? "py-1.5" : "py-2.5")}>
        <div className={cx("leading-snug text-ink", small ? "text-[13px] line-clamp-1" : "text-[15px] line-clamp-2 min-h-[2lh]")}>
          {item.name}
        </div>
        {!small && (
          <div className="mt-1 text-[13px] text-muted truncate">
            {[kinds.join("·"), chars.join("·")].filter(Boolean).join(" ｜ ")}
          </div>
        )}
      </div>
    </>
  );

  if (arranging)
    return (
      <div className="group block rounded-xl bg-surface border border-dashed border-gold/60 overflow-hidden select-none [-webkit-touch-callout:none] cursor-grab active:cursor-grabbing">
        {body}
      </div>
    );
  return (
    <Link
      to={`/item/${item.id}`}
      state={modal ? { background: location } : undefined}
      className="group block rounded-xl bg-surface border border-line overflow-hidden transition duration-300 hover:-translate-y-0.5 hover:border-gold/50 hover:shadow-[var(--shadow)] focus-visible:outline-2 focus-visible:outline-gold"
    >
      {body}
    </Link>
  );
});
