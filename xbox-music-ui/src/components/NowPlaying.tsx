import { PauseCircle, Repeat } from "lucide-react";
import type { Now } from "../types";
import SpectrumBars from "./SpectrumBars";

interface Props {
  now: Now | null;
  paused: boolean;
  repeat: boolean;
  busy: string | null;
  eqColorFrom?: string;
  eqColorTo?: string;
  rainbow?: boolean;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function currentPosSec(now: Now | null, paused: boolean): number {
  if (!now) return 0;
  const base = now.positionOffsetSec || 0;
  if (paused || !now.startedAt) return base;
  return base + (Date.now() - now.startedAt) / 1000;
}

export default function NowPlaying({
  now, paused, repeat, busy,
  eqColorFrom = "#60a5fa",
  eqColorTo = "#f472b6",
  rainbow = false,
}: Props) {
  const isBusy = Boolean(busy);
  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  const pos = hasDur ? Math.min(dur, Math.max(0, currentPosSec(now, paused))) : 0;

  const cardCls = `bg-bg border border-transparent rounded-xl p-4 shadow-soft ${
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border"
  }`;

  return (
    <section className={cardCls}>
      <h2 className="text-lg font-semibold mb-2">Lecture en cours</h2>

      {now?.url ? (
        <div className="p-3 rounded-xl bg-panel">
          <div className="flex gap-3 items-start">
            {now.thumb && (
              <img
                src={now.thumb}
                alt={now.title || "Cover"}
                className="w-56 h--56 rounded-lg object-cover border border-slate-700"
              />
            )}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={now.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-blue-300 break-words hover:underline"
                >
                  {now.title || now.url}
                </a>
                {now.addedBy && (
                  <span className="text-xs text-muted">· par {now.addedBy}</span>
                )}
              </div>

              <div className="mt-1 text-xs text-muted">
                {hasDur ? `${formatTime(pos)} / ${formatTime(dur)}` : "Durée inconnue"}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {paused && (
                  <span className="px-2 py-1 text-xs bg-purple-600 text-white rounded-full inline-flex items-center gap-1">
                    <PauseCircle className="w-3.5 h-3.5" />
                    En pause
                  </span>
                )}
                {repeat && (
                  <span className="px-2 py-1 text-xs bg-amber-500 text-black rounded-full inline-flex items-center gap-1">
                    <Repeat className="w-3.5 h-3.5" />
                    Repeat ON
                  </span>
                )}
                {isBusy && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-sky-600 text-white rounded-full">
                    <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    traitement…
                  </span>
                )}
              </div>

              <div className={rainbow ? "mt-4 animate-hue" : "mt-4"}>
                <SpectrumBars
                  playing={!paused}
                  bars={24}
                  colorFrom={eqColorFrom}
                  colorTo={eqColorTo}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-muted">Aucune piste en cours.</div>
      )}
    </section>
  );
}
