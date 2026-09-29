import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight, ImageOff, Pencil, Trash2 } from "lucide-react";
import { api, imgSrc, imgSrcSet, type Item, type ItemImage } from "../api";
import { useLookups, useMeta } from "../hooks";
import { Button, ConfirmDialog, cx, useToast } from "./ui";

function scaled(img: ItemImage, max = 1600) {
  const long = Math.max(img.width, img.height);
  const f = long > max ? max / long : 1;
  return { width: Math.round(img.width * f), height: Math.round(img.height * f) };
}

/** PhotoSwipe (+ its CSS) is only downloaded the first time someone opens the lightbox. */
export async function openLightbox(images: ItemImage[], index: number) {
  const [{ default: PhotoSwipe }] = await Promise.all([import("photoswipe"), import("photoswipe/style.css")]);
  const pswp = new PhotoSwipe({
    dataSource: images.map((img) => ({ src: imgSrc(img, 1600), ...scaled(img), alt: "" })),
    index,
    bgOpacity: 0.92,
    showHideAnimationType: "fade",
    wheelToZoom: true,
  });
  pswp.init();
}

function Gallery({ images, name }: { images: ItemImage[]; name: string }) {
  const [ref, embla] = useEmblaCarousel({ loop: false });
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!embla) return;
    const on = () => setIdx(embla.selectedScrollSnap());
    embla.on("select", on);
    return () => {
      embla.off("select", on);
    };
  }, [embla]);

  if (!images.length)
    return (
      <div className="well grid place-items-center text-muted/60 rounded-xl" style={{ aspectRatio: "var(--card-ratio)" }}>
        <ImageOff size={36} strokeWidth={1} />
      </div>
    );

  return (
    <div className="relative">
      <div ref={ref} data-no-swipe-back className="overflow-hidden rounded-xl well">
        <div className="flex touch-pan-y">
          {images.map((img, i) => (
            <button
              key={img.id}
              className="relative flex-[0_0_100%] min-w-0 cursor-zoom-in"
              style={{ aspectRatio: "var(--card-ratio)" }}
              onClick={() => openLightbox(images, i)}
              aria-label={`查看大图 ${i + 1}`}
            >
              <img
                src={imgSrc(img, 800)}
                srcSet={imgSrcSet(img)}
                sizes="(min-width: 768px) 480px, 100vw"
                alt={name}
                className="absolute inset-0 size-full object-contain p-[5%] drop-shadow-[0_10px_24px_rgb(0_0_0/0.22)]"
              />
            </button>
          ))}
        </div>
      </div>
      {images.length > 1 && (
        <>
          <button
            aria-label="上一张"
            onClick={() => embla?.scrollPrev()}
            className={cx("hidden md:grid absolute left-2 top-1/2 -translate-y-1/2 size-9 place-items-center rounded-full bg-surface/80 border border-line", idx === 0 && "opacity-0 pointer-events-none")}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            aria-label="下一张"
            onClick={() => embla?.scrollNext()}
            className={cx("hidden md:grid absolute right-2 top-1/2 -translate-y-1/2 size-9 place-items-center rounded-full bg-surface/80 border border-line", idx === images.length - 1 && "opacity-0 pointer-events-none")}
          >
            <ChevronRight size={18} />
          </button>
          <div className="flex justify-center gap-1.5 mt-3">
            {images.map((img, i) => (
              <button
                key={img.id}
                aria-label={`第 ${i + 1} 张`}
                onClick={() => embla?.scrollTo(i)}
                className={cx("h-1.5 rounded-full transition-all", i === idx ? "w-5 bg-accent" : "w-1.5 bg-ink/25")}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ItemDetail({ item, onDeleted }: { item: Item; onDeleted: () => void }) {
  const { data: meta } = useMeta();
  const lk = useLookups(meta);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);

  const del = useMutation({
    mutationFn: () => api.deleteItem(item.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["meta"] });
      toast(`已删除「${item.name}」`);
      setConfirm(false);
      onDeleted();
    },
    onError: (e: Error) => toast(e.message, "err"),
  });

  const series = lk.series.get(item.series_id);
  const kinds = item.kind_ids.map((k) => lk.kind.get(k)?.name).filter(Boolean).join("、");
  const chars = item.character_ids.map((c) => lk.character.get(c)?.name).filter(Boolean).join("、");
  const bag = item.bag_size_id ? lk.bag.get(item.bag_size_id)?.name : null;

  const rows: [string, React.ReactNode][] = [
    ["系列", series?.name],
    ["卡面", series?.card_face],
    ["种类", kinds],
    ["角色", chars],
    ["尺寸 / 规格", item.spec],
    ["自封袋", bag],
    ["状态", <span className={cx(item.status !== "已入库" && "text-accent")}>{item.status}</span>],
    ["数量", <span className="tabular-nums">{item.quantity}</span>],
    ["添加时间", new Date(item.created_at + (item.created_at.endsWith("Z") ? "" : "Z")).toLocaleDateString("zh-CN")],
  ];

  const edit = useCallback(() => navigate(`/item/${item.id}/edit`), [navigate, item.id]);

  return (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
      <Gallery images={item.images} name={item.name} />
      <div className="mt-6 md:mt-0 flex flex-col">
        <p className="text-[13px] tracking-[0.25em] text-gold">{series?.name}</p>
        <h1 className="mt-1 font-display text-2xl leading-snug">{item.name}</h1>
        <div className="gold-rule my-4" />
        <dl className="grid grid-cols-[5.5rem_1fr] gap-y-2.5 text-sm">
          {rows
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        {item.note && (
          <div className="mt-4 rounded-lg bg-canvas border border-line p-3 text-sm whitespace-pre-wrap leading-relaxed">{item.note}</div>
        )}
        {item.images.some((i) => i.low_res) && (
          <p className="mt-4 text-xs text-muted">
            <span className="inline-block size-1.5 rounded-full bg-gold mr-1.5 align-middle" />
            有图片分辨率较低，可在编辑中替换为高清图
          </p>
        )}
        <div className="flex-1" />
        <div className="mt-8 pt-4 border-t border-line flex gap-2">
          <Button variant="outline" className="flex-1" onClick={edit}>
            <Pencil size={15} /> 编辑
          </Button>
          <Button variant="danger" className="flex-1" onClick={() => setConfirm(true)}>
            <Trash2 size={15} /> 删除
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title="删除这件谷子？"
        message={<>「{item.name}」及其所有图片将被永久删除，无法恢复。</>}
        confirmLabel="确认删除"
        busy={del.isPending}
        onConfirm={() => del.mutate()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

export function ItemNotFound() {
  return (
    <div className="py-24 text-center text-muted">
      <p>这件谷子不存在或已被删除</p>
      <Link to="/" className="text-accent underline mt-2 inline-block">返回展示柜</Link>
    </div>
  );
}
