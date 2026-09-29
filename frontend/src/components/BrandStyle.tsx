import { useEffect } from "react";
import { useMeta } from "../hooks";

/**
 * Writes the instance's appearance settings (设置 → 外观) into CSS variables on :root, and keeps
 * the document title / status-bar colours in step. The server already renders the same values
 * into index.html, so the first paint is right; this keeps them live after edits.
 */
export function BrandStyle() {
  const { data: meta } = useMeta();
  const st = meta?.settings;
  const brand = meta?.brand;

  useEffect(() => {
    if (!st) return;
    document.title = st.app_name;
    const setMeta = (sel: string, value: string) => document.querySelector(sel)?.setAttribute("content", value);
    setMeta('meta[name="theme-color"][media*="light"]', st.bar_light_bg);
    setMeta('meta[name="theme-color"][media*="dark"]', st.bar_dark_bg);
    setMeta('meta[name="apple-mobile-web-app-title"]', st.app_name);
  }, [st]);

  if (!st) return null;
  const url = (u: string | null | undefined) => (u ? `url("${u}")` : "none");
  const css = `:root{
    --bar-light-bg:${st.bar_light_bg};--bar-light-ink:${st.bar_light_ink};
    --bar-dark-bg:${st.bar_dark_bg};--bar-dark-ink:${st.bar_dark_ink};
    --pattern-light:${url(brand?.pattern_light)};--pattern-dark:${url(brand?.pattern_dark ?? brand?.pattern_light)};
    --pattern-size:${Number(st.pattern_size) || 640}px;
  }`;
  return <style>{css}</style>;
}
