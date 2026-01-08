import React from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
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
import { Trash2, GripVertical } from "lucide-react";
import type { QueueItem } from "../types";

/* =========================
   Styles CSS Corrigés
========================= */
const styles = `
  @keyframes marquee {
    0% { transform: translateX(0); }
    100% { transform: translateX(-51%); } 
  }
  
  .marquee-container {
    mask-image: linear-gradient(to right, black 80%, transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
    overflow: hidden;
    white-space: nowrap;
    width: 100%; /* Force le conteneur à respecter la largeur du flex parent */
  }

  /* On ne déclenche l'animation que si le parent est survolé ou touché */
  .group:hover .marquee-content,
  .group:active .marquee-content {
    display: inline-block;
    animation: marquee 12s linear infinite;
    animation-delay: 0.5s;
    padding-right: 2rem; /* Espace pour la boucle */
  }

  /* État par défaut pour éviter le débordement avant le survol */
  .marquee-content {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

interface Props {
  queue: QueueItem[];
  busy: string | null;
  onSkipGroup: () => void;
  onClear: () => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  rainbow?: boolean;
}

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
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : "auto",
  };

  const displayName = item.title || item.url;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group p-2 border border-slate-700 bg-panel rounded-xl flex gap-3 items-center touch-manipulation relative w-full overflow-hidden"
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        className="cursor-grab active:cursor-grabbing text-muted hover:text-white shrink-0"
      >
        <GripVertical className="w-5 h-5" />
      </button>

      {item.thumb && (
        <img
          src={item.thumb}
          alt=""
          className="w-10 h-10 rounded object-cover border border-slate-700 shrink-0"
          onError={(e) => (e.currentTarget.src = "/fallback-cover.png")}
        />
      )}

      {/* Le conteneur min-w-0 est la clé pour empêcher le débordement en Flexbox */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="marquee-container">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            className="text-white hover:text-blue-400 font-medium text-sm block"
          >
            <span className="marquee-content will-change-transform">
              {displayName}
              {/* Le texte dupliqué pour l'effet de boucle */}
              <span className="hidden group-hover:inline group-active:inline ml-8 opacity-40">
                {displayName}
              </span>
            </span>
          </a>
        </div>
        
        <div className="text-[11px] text-muted truncate">
          {item.addedBy || "anonyme"} · {item.status}
        </div>
      </div>

      <button
        disabled={disabled}
        onClick={() => onRemove(item.id)}
        className="p-2 text-red-500 hover:bg-red-500/10 shrink-0"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

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
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = queue.findIndex((q) => q.id === active.id);
    const newIndex = queue.findIndex((q) => q.id === over.id);

    // On calcule le nouvel ordre localement
    const newOrder = arrayMove(queue, oldIndex, newIndex);
    
    // On envoie la liste des IDs réordonnés via la prop onReorder
    // Cette prop appelle reorderQueue() dans votre Hook, qui contient déjà le emitSafe
    onReorder(newOrder.map((q) => q.id));
  };

  return (
    <section className={`rounded-xl p-4 bg-bg border border-slate-800 ${rainbow ? "animate-hue" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">File d'attente</h2>
        <div className="flex gap-2">
          <button onClick={onSkipGroup} className="text-xs p-2 bg-slate-800 rounded-lg border border-slate-700">Skip</button>
          <button onClick={onClear} className="text-xs p-2 bg-red-600/20 text-red-500 rounded-lg border border-red-600/30">Vider</button>
        </div>
      </div>

      <div className="max-w-full overflow-hidden">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={queue.map((q) => q.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {queue.map((item) => (
                <SortableQueueItem key={item.id} item={item} disabled={isBusy} onRemove={onRemove} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}