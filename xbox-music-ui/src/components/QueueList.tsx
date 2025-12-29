import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronsRight, Trash2, GripVertical } from "lucide-react";
import type { QueueItem } from "../types";

interface Props {
  queue: QueueItem[];
  busy: string | null;
  onSkipGroup: () => void;
  onClear: () => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  rainbow?: boolean;
}

/* =========================
   Sortable item
========================= */
function SortableQueueItem({
  item,
  disabled,
  onRemove,
}: {
  item: QueueItem;
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="p-2 border border-slate-700 bg-panel rounded-xl flex gap-3 items-center"
    >
      {/* Handle */}
      <button
        {...attributes}
        {...listeners}
        disabled={disabled}
        className="cursor-grab active:cursor-grabbing text-muted hover:text-white"
        title="Déplacer"
      >
        <GripVertical className="w-5 h-5" />
      </button>

      {item.thumb && (
        <img
          src={item.thumb}
          alt={item.title || "thumb"}
          className="w-12 h-12 rounded-md object-cover border border-slate-700 shrink-0"
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="font-semibold break-words">
          {item.title ? <span title={item.url}>{item.title}</span> : item.url}
        </div>
        <div className="text-xs text-muted">
          {item.addedBy || "anonyme"} · <b>{item.status}</b>
          {item.group && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800">
              playlist
            </span>
          )}
        </div>
      </div>

      {/* Delete */}
      <button
        disabled={disabled}
        onClick={() => onRemove(item.id)}
        className="p-2 rounded-lg text-red-500 hover:bg-slate-800 disabled:opacity-40"
        title="Supprimer"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

/* =========================
   QueueList
========================= */
export default function QueueList({
  queue,
  busy,
  onSkipGroup,
  onClear,
  onReorder,
  onRemove,
  rainbow = false,
}: Props) {
  const isBusy = Boolean(busy);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const cardCls = `bg-bg border border-transparent rounded-xl p-4 shadow-soft ${
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border"
  }`;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = queue.findIndex((q) => q.id === active.id);
    const newIndex = queue.findIndex((q) => q.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newQueue = arrayMove(queue, oldIndex, newIndex);
    onReorder(newQueue.map((q) => q.id));
  };

  return (
    <section className={cardCls}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">File d’attente</h2>

        <div className="flex items-center gap-2">
          <button
            disabled={isBusy}
            onClick={onSkipGroup}
            className="px-3 py-2 rounded-xl bg-slate-800 text-white border border-slate-700 inline-flex items-center gap-2"
          >
            <ChevronsRight className="w-5 h-5" />
            Skip playlist
          </button>

          <button
            disabled={isBusy}
            onClick={onClear}
            className="px-3 py-2 rounded-xl bg-red-600 text-white border border-red-700 inline-flex items-center gap-2"
          >
            <Trash2 className="w-5 h-5" />
            Vider la file
          </button>
        </div>
      </div>

      {queue.length ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={queue.map((q) => q.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="grid gap-2">
              {queue.map((item) => (
                <SortableQueueItem
                  key={item.id}
                  item={item}
                  disabled={isBusy}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="text-muted">La file est vide.</div>
      )}
    </section>
  );
}
