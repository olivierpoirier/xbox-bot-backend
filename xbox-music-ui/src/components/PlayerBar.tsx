import { AnimatePresence, motion } from "framer-motion";
import { Play, Pause, SkipForward, RotateCcw, RotateCw, Repeat } from "lucide-react";
import type { Now } from "../types";

type Command = "pause" | "resume" | "skip" | "seek" | "seek_abs" | "repeat";

interface Props {
  now: Now | null;
  paused: boolean;
  repeat: boolean;
  busy: string | null;
  sendCommand: (cmd: Command, arg?: number) => void;
  rainbow?: boolean;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}
function currentPosSec(now: Now | null, paused: boolean): number {
  if (!now) return 0;
  const base = now.positionOffsetSec || 0;
  if (paused || !now.startedAt) return base;
  return base + (Date.now() - now.startedAt) / 1000;
}

export default function PlayerBar({ now, paused, repeat, busy, sendCommand, rainbow = false }: Props) {
  const isBusy = Boolean(busy);
  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  const pos = hasDur ? Math.min(dur, Math.max(0, currentPosSec(now, paused))) : 0;

  const wrapCls =
    "rounded-2xl border border-transparent bg-[rgba(17,24,39,0.85)] backdrop-blur-md shadow-2xl " +
    (rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border");

  const sliderCls = `xmb-slider w-full ${rainbow ? "xmb-slider-rainbow" : "xmb-slider-themed"}`;

  return (
    <AnimatePresence>
      {now?.url && (
        <motion.div
          initial={{ y: 96, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 96, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="fixed bottom-0 inset-x-0 z-40"
        >
          <div className="mx-auto w-full max-w-7xl px-4 py-3">
            <motion.div className={wrapCls}>
              <div className="flex items-center gap-3 px-3 py-2">
                {/* Thumb + title */}
                <div className="flex items-center gap-3 min-w-0 w-1/4">
                  {now.thumb && (
                    <img
                      src={now.thumb}
                      alt={now.title || "cover"}
                      className="w-12 h-12 rounded-lg object-cover border border-slate-700"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{now.title || now.url}</div>
                    {now.addedBy && (
                      <div className="text-xs text-muted truncate">par {now.addedBy}</div>
                    )}
                  </div>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-2 ml-2">
                  <button
                    onClick={() => sendCommand("seek", -15)}
                    disabled={isBusy}
                    className="px-2 py-1 rounded-lg bg-slate-800 inline-flex items-center gap-1"
                    title="Reculer de 15s"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span className="text-xs">15s</span>
                  </button>

                  <button
                    onClick={() => sendCommand(paused ? "resume" : "pause")}
                    disabled={isBusy}
                    className="px-4 py-2 rounded-lg bg-slate-800"
                    title={paused ? "Reprendre" : "Pause"}
                  >
                    {paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                  </button>

                  <button
                    onClick={() => sendCommand("skip")}
                    disabled={isBusy}
                    className="px-2 py-1 rounded-lg bg-slate-800"
                    title="Passer la piste"
                  >
                    <SkipForward className="w-5 h-5" />
                  </button>

                  <button
                    onClick={() => sendCommand("seek", +15)}
                    disabled={isBusy}
                    className="px-2 py-1 rounded-lg bg-slate-800 inline-flex items-center gap-1"
                    title="Avancer de 15s"
                  >
                    <RotateCw className="w-4 h-4" />
                    <span className="text-xs">15s</span>
                  </button>
                </div>

                {/* Slider au centre */}
                <div className="flex-1 mx-4 hidden md:flex items-center gap-2 text-[11px] text-muted">
                  {hasDur ? (
                    <>
                      <span className="w-10 text-right">{formatTime(pos)}</span>

                      <div className={`glow-wrap ${rainbow ? "glow-rainbow" : ""} w-full rounded-xl p-2`}>
                        <input
                          type="range"
                          min={0}
                          max={Math.floor(dur)}
                          value={Math.floor(pos)}
                          onChange={(e) => sendCommand("seek_abs", parseInt(e.target.value))}
                          className={sliderCls}
                        />
                      </div>

                      <span className="w-10">{formatTime(dur)}</span>
                    </>
                  ) : (
                    <div className="w-full h-1 rounded bg-slate-700 overflow-hidden">
                      <div className="h-1 w-1/3 animate-pulse bg-slate-400" />
                    </div>
                  )}
                </div>

                {/* Repeat */}
                <button
                  onClick={() => sendCommand("repeat", repeat ? 0 : 1)}
                  disabled={isBusy}
                  className={`px-3 py-2 rounded-lg ${repeat ? "bg-amber-600 text-black" : "bg-slate-800 text-white"}`}
                  title="Répéter la piste"
                >
                  <Repeat className="w-5 h-5" />
                </button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
