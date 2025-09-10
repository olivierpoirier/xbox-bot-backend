import type { Now } from "../types";

interface Props {
  now: Now | null;
  volume: number;
  paused: boolean;
  busy: string | null;
  sendCommand: (cmd: "pause" | "resume" | "skip" | "volume", arg?: number) => void;
  clearQueue: () => void;
}

export default function NowPlaying({ now, volume, paused, busy, sendCommand, clearQueue }: Props) {
  return (
    <section className="bg-bg border border-slate-800 rounded-xl p-4 shadow-soft">
      <h2 className="text-lg font-semibold mb-2">Lecture en cours</h2>
      {now?.url ? (
        <div className="p-3 rounded-xl border border-slate-700 bg-panel">
          <a href={now.url} target="_blank" rel="noreferrer" className="font-bold text-blue-300 break-words hover:underline">
            {now.title || now.url}
          </a>
          {now.addedBy && <div className="text-xs text-muted">par {now.addedBy}</div>}
          <div className="text-xs text-muted">Volume : {volume}%</div>
          {paused && (
            <div className="mt-2 inline-block px-2 py-1 text-xs bg-purple-600 text-white rounded-full">
              ⏸ En pause
            </div>
          )}
        </div>
      ) : (
        <div className="text-muted">Aucune piste en cours.</div>
      )}

      <div className="flex gap-2 mt-3">
        <button
          onClick={() => sendCommand(paused ? "resume" : "pause")}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800"
        >
          {paused ? "▶ Reprendre" : "⏸ Pause"}
        </button>
        <button
          onClick={() => sendCommand("skip")}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800"
        >
          ⏭ Skip
        </button>
        <button
          onClick={clearQueue}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-red-500 text-white"
        >
          🗑 Vider
        </button>
      </div>

      <div className="mt-3">
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => sendCommand("volume", parseInt(e.target.value))}
          className="xmb-slider w-full"
        />
      </div>
    </section>
  );
}
