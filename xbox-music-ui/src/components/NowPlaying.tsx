// src/components/NowPlaying.tsx
import { PauseCircle, Repeat } from "lucide-react";
import type { Now } from "../types";
import SpectrumBars from "./SpectrumBars";

interface Props {
  now: Now | null;
  paused: boolean;
  repeat: boolean;
  busy: string | null;
  /** Couleur de départ du dégradé pour les barres */
  eqColorFrom?: string;
  /** Couleur de fin du dégradé pour les barres */
  eqColorTo?: string;
  /** Active l’animation arc-en-ciel (CSS) autour de la carte et du spectre */
  rainbow?: boolean;
  /** Hauteur (px) du spectre sur mobile et desktop. Par défaut 64 */
  spectrumHeightPx?: number;
  /** Nombre de barres à afficher */
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

function currentPosSec(now: Now | null, paused: boolean): number {
  if (!now) return 0;
  const base = now.positionOffsetSec || 0;
  if (paused || !now.startedAt) return base;
  return base + (Date.now() - now.startedAt) / 1000;
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
  const isBusy = Boolean(busy);

  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? Math.max(0, now!.durationSec!) : 0;

  // Position courante (clampée entre 0 et dur)
  const pos = hasDur
    ? Math.min(dur, Math.max(0, currentPosSec(now, paused)))
    : 0;

  const remaining = hasDur ? Math.max(0, dur - pos) : 0;

  const cardCls = [
    "bg-bg border border-transparent rounded-xl p-4 shadow-soft",
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border",
  ].join(" ");

  const playingGlow = !paused
    ? "ring-2 ring-[var(--c1)]/40 shadow-lg shadow-[var(--c1)]/20 animate-pulse"
    : "";

  // style commun pour forcer une hauteur non-nulle du conteneur du spectre
  const spectrumStyle: React.CSSProperties = {
    width: "100%",
    height: `${spectrumHeightPx}px`,
  };

  return (
    <section className={cardCls} aria-label="Lecture en cours">
      <h2 className="text-lg font-semibold mb-2 text-center">Lecture en cours</h2>

      {now?.url ? (
        <div className="p-3 rounded-xl bg-panel">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-center text-center md:text-left">
            {now.thumb && (
              <img
                src={now.thumb}
                alt={now.title || "cover"}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = "/fallback-cover.png";
                }}
                className={[
                  "w-full max-w-[14rem] md:w-56 md:h-56 rounded-lg object-cover border border-slate-700",
                  playingGlow,
                ].join(" ")}
              />
            )}


            <div className="flex-1 min-w-0 flex flex-col items-center md:items-start justify-center">
              <a
                href={now.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold break-words hover:underline text-center md:text-left"
              >
                {now.title || now.url}
              </a>

              {/* Temps courant / durée */}
              <div
                className="mt-1 text-sm font-medium"
                style={{ color: "var(--c1)" }}
                aria-live="polite"
              >
                {hasDur ? `${formatTime(pos)} / ${formatTime(dur)}` : "Durée inconnue"}
              </div>

              {/* Temps restant */}
              {hasDur && (
                <div className="mt-1 text-xs text-muted">
                  Temps restant: {formatTime(remaining)}
                </div>
              )}

              {/* Étiquettes statut */}
              <div className="mt-2 flex flex-wrap justify-center md:justify-start items-center gap-2">
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

              {/* Desktop → spectre dans la colonne (donner une hauteur explicite) */}
              <div
                className={[
                  "mt-4 hidden md:flex items-end", // md:flex pour aligner les barres en bas si besoin
                  rainbow ? "animate-hue" : "",
                ].join(" ")}
                style={spectrumStyle}
              >
                <SpectrumBars
                  playing={!paused}
                  bars={spectrumBars}
                  colorFrom={eqColorFrom}
                  colorTo={eqColorTo}
                />
              </div>
            </div>
          </div>

          {/* Mobile → spectre sous l’image (hauteur explicite aussi) */}
          <div
            className={["mt-4 md:hidden", rainbow ? "animate-hue" : ""].join(" ")}
            style={spectrumStyle}
          >
            <SpectrumBars
              playing={!paused}
              bars={spectrumBars}
              colorFrom={eqColorFrom}
              colorTo={eqColorTo}
            />
          </div>
        </div>
      ) : (
        <div className="text-muted text-center">Aucune piste en cours.</div>
      )}
    </section>
  );
}
