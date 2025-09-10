import type { QueueItem } from "../types";

interface Props {
  queue: QueueItem[];
}

export default function QueueList({ queue }: Props) {
  return (
    <section className="bg-bg border border-slate-800 rounded-xl p-4 shadow-soft">
      <h2 className="text-lg font-semibold mb-2">File d’attente</h2>
      {queue?.length ? (
        <div className="grid gap-2">
          {queue.map((it, i) => (
            <div key={it.id} className="p-2 border border-slate-700 bg-panel rounded-xl">
              <div className="font-semibold break-words">
                <span className="text-muted mr-1">{i + 1}.</span>
                {it.url}
              </div>
              <div className="text-xs text-muted">
                {it.addedBy || "anonyme"} · <b>{it.status}</b>
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
