import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Item, type Meta } from "./api";

export const useMeta = () => useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 30_000 });
export const useItems = () => useQuery({ queryKey: ["items"], queryFn: api.items, staleTime: 30_000 });

/** id → option lookups derived from meta. */
export function useLookups(meta: Meta | undefined) {
  return useMemo(() => {
    const m = <T extends { id: number }>(xs: T[] | undefined) => new Map((xs ?? []).map((x) => [x.id, x]));
    return {
      group: m(meta?.groups),
      kind: m(meta?.kinds),
      series: m(meta?.series),
      character: m(meta?.characters),
      bag: m(meta?.bag_sizes),
    };
  }, [meta]);
}
export type Lookups = ReturnType<typeof useLookups>;

export function searchText(item: Item, lk: Lookups) {
  return [
    item.name,
    lk.series.get(item.series_id)?.name,
    lk.series.get(item.series_id)?.card_face,
    ...item.kind_ids.map((k) => lk.kind.get(k)?.name),
    ...item.character_ids.map((c) => lk.character.get(c)?.name),
    item.note,
    item.spec,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function subscribeMedia(q: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(q);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}
export function useMediaQuery(q: string) {
  return useSyncExternalStore(subscribeMedia(q), () => window.matchMedia(q).matches, () => false);
}
/** PC = modal details; below = full pages. */
export const useIsDesktop = () => useMediaQuery("(min-width: 768px)");

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}
export const storage = { read: readLS, write: writeLS };

export type ThemePref = "system" | "light" | "dark";
export function applyTheme(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", pref);
}
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (readLS("theme") as ThemePref) || "system");
  useEffect(() => {
    applyTheme(pref);
    writeLS("theme", pref === "system" ? null : pref);
  }, [pref]);
  const cycle = useCallback(
    () => setPref((p) => (p === "system" ? "light" : p === "light" ? "dark" : "system")),
    [],
  );
  return { pref, cycle };
}

export type Density = "s" | "m" | "l";
export function useDensity() {
  const [d, setD] = useState<Density>(() => (readLS("density") as Density) || "m");
  useEffect(() => writeLS("density", d), [d]);
  return [d, setD] as const;
}

/** id of the 「默认角色」 setting, if that character exists. */
export function defaultCharacterIds(meta: Meta | undefined): number[] {
  const name = meta?.settings.default_character?.trim();
  const c = name ? meta?.characters.find((x) => x.name === name) : undefined;
  return c ? [c.id] : [];
}
