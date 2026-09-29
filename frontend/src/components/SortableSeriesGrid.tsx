import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Item } from "../api";
import type { Density, Lookups } from "../hooks";
import { ItemCard } from "./ItemCard";
import { cx } from "./ui";

/**
 * One series' cards in 整理 mode. Each series gets its own DndContext, so a card can only
 * move within its series. Mouse drags after 5px; touch needs a ~250ms long-press first, so a
 * normal swipe still scrolls the page.
 */
export function SortableSeriesGrid({
  items, lk, density, gridClass, onReorder,
}: {
  items: Item[];
  lk: Lookups;
  density: Density;
  gridClass: string;
  onReorder: (ids: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    onReorder(arrayMove(items, from, to).map((i) => i.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
        <div className={cx("grid", gridClass)}>
          {items.map((it) => (
            <SortableCard key={it.id} item={it} lk={lk} density={density} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({ item, lk, density }: { item: Item; lk: Lookups; density: Density }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx("touch-manipulation", isDragging && "relative z-20 scale-[1.04] opacity-90 drop-shadow-xl")}
      aria-label={`拖动 ${item.name}`}
      {...attributes}
      {...listeners}
    >
      <ItemCard item={item} lk={lk} density={density} modal={false} arranging />
    </div>
  );
}
