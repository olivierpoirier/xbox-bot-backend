import { ChevronsRight, Trash2 } from "lucide-react";
import type { QueueItem } from "../types";

interface Props {
  queue: QueueItem[];
  busy: string | null;
  onSkipGroup: () => void;
  onClear: () => void;
  rainbow?: boolean;
}

export default function QueueList({ queue, busy, onSkipGroup, onClear, rainbow = false }: Props) {
  const isBusy = Boolean(busy);
  const cardCls = `bg-bg border border-transparent rounded-xl p-4 shadow-soft ${
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border"
  }`;

  return (
    <section className={cardCls}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">File d’attente</h2>

        <div className="flex items-center gap-2">
          <button
            disabled={isBusy}
            onClick={onSkipGroup}
            className="px-3 py-2 rounded-xl bg-slate-800 text-white border border-slate-700 inline-flex items-center gap-2"
            title="Passer toute la playlist en cours"
          >
            <ChevronsRight className="w-5 h-5" />
            Skip playlist
          </button>
          <button
            disabled={isBusy}
            onClick={onClear}
            className="px-3 py-2 rounded-xl bg-red-600 text-white border border-red-700 inline-flex items-center gap-2"
            title="Vider toute la file d’attente"
          >
            <Trash2 className="w-5 h-5" />
            Vider la file
          </button>
        </div>
      </div>

      {queue?.length ? (
        <div className="grid gap-2">
          {queue.map((it, i) => (
            <div
              key={it.id}
              className="p-2 border border-slate-700 bg-panel rounded-xl flex gap-3 items-center"
            >
              {it.thumb && (
                <img
                  src={it.thumb}
                  alt={it.title || "thumb"}
                  className="w-12 h-12 rounded-md object-cover border border-slate-700 shrink-0"
                />
              )}
              <div className="min-w-0">
                <div className="font-semibold break-words">
                  <span className="text-muted mr-1">{i + 1}.</span>
                  {it.title ? <span title={it.url}>{it.title}</span> : it.url}
                </div>
                <div className="text-xs text-muted">
                  {it.addedBy || "anonyme"} · <b>{it.status}</b>
                  {it.group && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800">
                      playlist
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted">La file est vide.</div>
      )}
    </section>
  );
}
