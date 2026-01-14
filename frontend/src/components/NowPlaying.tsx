import { useState, useEffect } from "react";
import { PauseCircle, Repeat, Loader2, Music, ExternalLink } from "lucide-react";
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
  spectrumHeightPx?: number;
  spectrumBars?: number;
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

export default function NowPlaying({
  now,
  paused,
  repeat,
  busy,
  eqColorFrom = "#60a5fa",
  eqColorTo = "#f472b6",
  rainbow = false,
  spectrumHeightPx = 64,
  spectrumBars = 24,
}: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (paused || !now?.startedAt || now?.isBuffering) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [paused, now?.startedAt, now?.isBuffering]);

  // États logiques
  const isBuffering = Boolean(now?.isBuffering);
  const isBusy = Boolean(busy);
  
  // On considère qu'on a un vrai titre si ce n'est pas le placeholder par défaut
  const hasRealTitle = now?.title && 
                       now.title !== "Analyse du signal..." && 
                       now.title !== "Initialisation du flux...";

  const calculatePos = () => {
    if (!now) return 0;
    if (isBuffering || paused || !now.startedAt) {
      return now.positionOffsetSec || 0;
    }
    const elapsedSinceStart = (Date.now() - now.startedAt) / 1000;
    return elapsedSinceStart; 
  };

  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  const currentPos = calculatePos();
  const pos = hasDur ? Math.min(dur, Math.max(0, currentPos)) : Math.max(0, currentPos);
  const remaining = hasDur ? Math.max(0, dur - pos) : 0;

  const cardCls = [
    "bg-bg border border-transparent rounded-xl p-4 shadow-soft transition-all duration-500",
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border",
  ].join(" ");

  const playingGlow = (!paused && !isBuffering && now?.url)
    ? "ring-2 ring-[var(--c1)]/40 shadow-lg shadow-[var(--c1)]/20 animate-pulse"
    : "";

  return (
    <section className={cardCls} aria-label="Lecture en cours">
      <h2 className="text-lg font-bold mb-4 text-center uppercase tracking-widest opacity-70">
        Lecture en cours
      </h2>

      {now?.url ? (
        <div className="p-3 rounded-xl bg-panel/50 backdrop-blur-sm">
          <div className="flex flex-col md:flex-row gap-6 items-center justify-center text-center md:text-left">
            
            {/* Thumbnail */}
            <div className="relative shrink-0">
              {now.thumb ? (
                <img
                  src={now.thumb}
                  alt={now.title || "cover"}
                  className={`w-56 h-56 rounded-lg object-cover border border-slate-700 transition-all duration-700 ${playingGlow} ${isBuffering ? "grayscale blur-sm scale-95" : "scale-100"}`}
                />
              ) : (
                <div className="w-56 h-56 rounded-lg bg-black/20 flex items-center justify-center border border-white/5">
                  <Music className="opacity-20 w-12 h-12" />
                </div>
              )}
              {isBuffering && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-12 h-12 text-white animate-spin" />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col items-center md:items-start justify-center">
              {/* Titre : Affiche le vrai titre dès qu'on l'a, sinon met un message d'attente */}
              <div className="text-xl font-black italic uppercase leading-tight line-clamp-2 min-h-[3.5rem]">
                {hasRealTitle ? now.title : (isBuffering ? "Initialisation du flux..." : "Analyse du signal...")}
              </div>

              {/* URL CLIQUABLE */}
              <a 
                href={now.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 mt-1 mb-3 text-[10px] font-mono opacity-40 hover:opacity-100 transition-opacity max-w-full group"
              >
                <span className="truncate group-hover:underline">{now.url}</span>
                <ExternalLink size={10} className="shrink-0" />
              </a>

              {/* Affichage du temps : On affiche le temps même en buffering si on connaît la durée */}
              <div className="text-2xl font-mono font-bold" style={{ color: "var(--c1)" }}>
                {isBuffering && !hasDur 
                  ? "--:-- / --:--" 
                  : (hasDur ? `${formatTime(pos)} / ${formatTime(dur)}` : "LIVE / ∞")
                }
              </div>

              {hasDur && (
                <div className={`text-xs font-mono opacity-50 uppercase tracking-tighter mt-1 transition-opacity ${isBuffering ? 'opacity-0' : 'opacity-50'}`}>
                  RESTE: {formatTime(remaining)}
                </div>
              )}

              {/* Badges de Statut */}
              <div className="mt-4 flex flex-wrap justify-center md:justify-start items-center gap-2">
                {paused && (
                  <span className="px-3 py-1 text-[10px] font-bold bg-purple-600 text-white rounded-full flex items-center gap-1 shadow-lg shadow-purple-600/20">
                    <PauseCircle size={14} /> EN PAUSE
                  </span>
                )}
                {repeat && (
                  <span className="px-3 py-1 text-[10px] font-bold bg-amber-500 text-black rounded-full flex items-center gap-1 shadow-lg shadow-amber-500/20">
                    <Repeat size={14} /> REPEAT
                  </span>
                )}
                {isBuffering && (
                  <span className="px-3 py-1 text-[10px] font-bold bg-sky-600 text-white rounded-full flex items-center gap-1 animate-pulse">
                    <Loader2 size={14} className="animate-spin" /> CHARGEMENT
                  </span>
                )}
                {isBusy && !isBuffering && (
                  <span className="px-3 py-1 text-[10px] font-bold bg-slate-700 text-white rounded-full flex items-center gap-1">
                    <Loader2 size={14} className="animate-spin" /> SYNC
                  </span>
                )}
              </div>

              {/* Spectrum Desktop */}
              <div
                className={`mt-6 hidden md:flex items-end transition-opacity duration-500 w-full ${(isBuffering || paused) ? "opacity-20 grayscale" : "opacity-100"}`}
                style={{ height: `${spectrumHeightPx}px` }}
              >
                <SpectrumBars
                  playing={!paused && !isBuffering}
                  bars={spectrumBars}
                  colorFrom={eqColorFrom}
                  colorTo={eqColorTo}
                />
              </div>
            </div>
          </div>

          {/* Spectrum Mobile */}
          <div
            className={`mt-6 md:hidden transition-opacity duration-500 w-full ${(isBuffering || paused) ? "opacity-20 grayscale" : "opacity-100"}`}
            style={{ height: `${spectrumHeightPx}px` }}
          >
            <SpectrumBars
              playing={!paused && !isBuffering}
              bars={spectrumBars}
              colorFrom={eqColorFrom}
              colorTo={eqColorTo}
            />
          </div>
        </div>
      ) : (
        <div className="py-20 text-muted text-center font-mono animate-pulse uppercase tracking-widest border-2 border-dashed border-white/5 rounded-xl">
          Aucun signal détecté
        </div>
      )}
    </section>
  );
}