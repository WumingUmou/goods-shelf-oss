import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Kind, type Option } from "../api";
import { useMeta } from "../hooks";
import { Button, Dialog, useToast } from "./ui";

/**
 * "Type a new name → create it" handlers for OptionPicker. A new 种类 must pick its
 * 大类 first, so createKind opens a dialog; render `kindDialog` once in the page.
 */
export function useOptionCreators() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [kindPrompt, setKindPrompt] = useState<{ name: string; resolve: (k: Kind | null) => void } | null>(null);

  const createOpt = (type: "series" | "character" | "bag_size") => async (name: string) => {
    try {
      const o = await api.createOption<Option>(type, { name });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      return o;
    } catch (e) {
      toast((e as Error).message, "err");
      return null;
    }
  };

  const createKind = (name: string) => new Promise<Kind | null>((resolve) => setKindPrompt({ name, resolve }));

  const confirmKind = async (group_id: number) => {
    if (!kindPrompt) return;
    try {
      const k = await api.createOption<Kind>("kind", { name: kindPrompt.name, group_id });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      kindPrompt.resolve(k);
    } catch (e) {
      toast((e as Error).message, "err");
      kindPrompt.resolve(null);
    }
    setKindPrompt(null);
  };

  const kindDialog = (
    <Dialog open={!!kindPrompt} onClose={() => { kindPrompt?.resolve(null); setKindPrompt(null); }} title={`「${kindPrompt?.name}」属于哪个大类？`}>
      <div className="px-5 pb-6 grid grid-cols-2 gap-2">
        {meta?.groups.map((g) => (
          <Button key={g.id} variant="outline" onClick={() => confirmKind(g.id)}>{g.name}</Button>
        ))}
      </div>
    </Dialog>
  );

  return { createOpt, createKind, kindDialog };
}
