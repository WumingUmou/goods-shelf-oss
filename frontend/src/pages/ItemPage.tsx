import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useItems } from "../hooks";
import { ItemDetail, ItemNotFound } from "../components/ItemDetail";
import { Dialog, IconButton } from "../components/ui";

function useItem() {
  const { id } = useParams();
  const { data, isLoading } = useItems();
  return { item: data?.find((i) => i.id === Number(id)), isLoading };
}

/** Full page (phones, or direct link). */
export function ItemPage() {
  const { item, isLoading } = useItem();
  const navigate = useNavigate();
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/"));
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 safe-top safe-x app-bar">
        <div className="h-14 flex items-center gap-2 px-2">
        <IconButton label="返回" onClick={back}>
          <ArrowLeft size={20} />
        </IconButton>
        <span className="text-sm text-muted truncate">{item?.name}</span>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 md:px-6 py-5 pb-safe">
        {isLoading ? null : item ? <ItemDetail item={item} onDeleted={() => navigate("/", { replace: true })} /> : <ItemNotFound />}
      </div>
    </div>
  );
}

/** Modal over the showcase (desktop). */
export function ItemModal() {
  const { item, isLoading } = useItem();
  const navigate = useNavigate();
  const close = () => navigate(-1);
  return (
    <Dialog open onClose={close} title="" wide>
      <div className="px-5 md:px-7 pb-6">
        {isLoading ? null : item ? <ItemDetail item={item} onDeleted={close} /> : <ItemNotFound />}
      </div>
    </Dialog>
  );
}
