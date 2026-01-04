import { AnimatePresence, motion } from "framer-motion";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  RotateCw,
  Repeat,
  X,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Now, Command } from "../types";

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
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

export default function PlayerBar({
  now,
  paused,
  repeat,
  busy,
  sendCommand,
  rainbow = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [localPos, setLocalPos] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  
  // Réf pour éviter le "saut" visuel après un seek (verrou de 800ms)
  const lastSeekTime = useRef<number>(0);
  const requestRef = useRef<number>(null);

  /**
   * Animation fluide de la barre de progression
   */
  useEffect(() => {
    const updateTick = () => {
      const nowMs = Date.now();
      
      // On n'écoute pas les updates serveurs si on drag OU si on vient de relâcher (800ms de sécurité)
      if (!isDragging && nowMs - lastSeekTime.current > 800) {
        if (!now) {
          setLocalPos(0);
        } else if (now.isBuffering || paused || !now.startedAt) {
          setLocalPos(now.positionOffsetSec || 0);
        } else {
          const elapsed = (nowMs - now.startedAt) / 1000;
          setLocalPos((now.positionOffsetSec || 0) + elapsed);
        }
      }
      requestRef.current = requestAnimationFrame(updateTick);
    };

    requestRef.current = requestAnimationFrame(updateTick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [now, paused, isDragging]);

  /**
   * Handler de fin de déplacement (Seek)
   */
  const handleSeekEnd = (value: number) => {
    setIsDragging(false);
    setLocalPos(value); // On force visuellement la position
    lastSeekTime.current = Date.now(); // On active le verrou
    sendCommand("seek_abs", value);
  };

  // États dérivés
  const isLoading = Boolean(now?.url && now?.isBuffering);
  const isBusy = Boolean(busy) || isLoading;
  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  
  // Position finale affichée (priorité au drag utilisateur)
  const currentPos = isDragging ? dragValue : (hasDur ? Math.min(dur, Math.max(0, localPos)) : localPos);
  const progressPct = hasDur ? (currentPos / dur) * 100 : 0;

  const title = isLoading ? "CHARGEMENT..." : now?.title || now?.url || "SIGNAL PERDU";
  const subtitle = now?.addedBy ? `SÉLECTION : ${now.addedBy.toUpperCase()}` : "SOURCE : WEB";

  // Classes de styles dynamiques
  const glassClass = "bg-black/90 backdrop-blur-2xl border-t border-white/10 shadow-[0_-10px_50px_rgba(0,0,0,0.9)]";
  const neonText = rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]";
  const neonBorder = rainbow ? "border-rainbow animate-rainbow-glow" : "border-white/10";

  return (
    <AnimatePresence>
      {now?.url && (
        <>
          {/* ===== MINI-PLAYER (BARRE BASSE) ===== */}
          <motion.div
            initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
            className={`fixed bottom-0 inset-x-0 z-40 h-20 ${glassClass} flex flex-col justify-end select-none`}
          >
            <div className="absolute top-0 left-0 right-0 h-[3px] bg-white/5 overflow-hidden">
              <motion.div
                className={`h-full shadow-[0_0_15px_rgba(255,255,255,0.4)] ${
                  rainbow ? "bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 animate-hue" : "bg-[var(--c1)]"
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="flex items-center h-full px-4 gap-3 max-w-6xl mx-auto w-full">
              <button 
                className={`relative shrink-0 w-12 h-12 rounded-lg border overflow-hidden group shadow-lg ${rainbow ? 'border-pink-500/50' : 'border-white/10'}`}
                onClick={() => setExpanded(true)}
              >
                {now.thumb && (
                  <img
                    src={now.thumb}
                    className={`w-full h-full object-cover transition-all duration-700 ${isLoading ? "blur-md opacity-50" : ""} ${rainbow ? "animate-hue filter contrast-125" : ""}`}
                    alt=""
                  />
                )}
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                   <ChevronUp className="text-white w-6 h-6" />
                </div>
              </button>

              <button className="flex-1 min-w-0 text-left" onClick={() => setExpanded(true)}>
                <div className="text-[10px] font-mono uppercase tracking-[0.2em] opacity-50 mb-0.5">{subtitle}</div>
                <div className={`text-sm font-bold truncate tracking-tight font-mono italic ${isLoading ? "opacity-50" : "text-white/90"}`}>{title}</div>
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => sendCommand(paused ? "resume" : "pause")}
                  disabled={isBusy && !paused}
                  className={`p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-all ${neonText} disabled:opacity-20`}
                >
                  {isLoading ? <Loader2 size={20} className="animate-spin" /> : (paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />)}
                </button>
                <button onClick={() => sendCommand("skip")} disabled={isBusy} className="p-3 text-white/60 hover:text-white transition-colors disabled:opacity-10">
                  <SkipForward size={20} fill="currentColor" />
                </button>
              </div>
            </div>
          </motion.div>

          {/* ===== FULLSCREEN PLAYER ===== */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                className="fixed inset-0 z-50 flex flex-col bg-[#050505] overflow-hidden"
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 30, stiffness: 200 }}
              >
                {/* Background Glow */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  <div className={`absolute top-[-10%] left-[-10%] w-[70%] h-[70%] blur-[120px] rounded-full opacity-20 ${rainbow ? "bg-gradient-to-br from-pink-600 to-cyan-600 animate-spin-slow" : "bg-[var(--c1)]"}`} />
                </div>

                <div className="relative z-10 flex flex-col h-full max-w-lg mx-auto w-full p-8 pb-12">
                  <button onClick={() => setExpanded(false)} className="self-center p-2 text-white/20 hover:text-white transition-colors mb-4">
                    <X size={32} />
                  </button>

                  <div className="flex-1 flex flex-col justify-center items-center gap-8">
                    {/* Artwork avec bordure Arc-en-ciel */}
                    <div className={`relative p-1.5 rounded-[2.5rem] border-2 shadow-2xl transition-all duration-500 ${neonBorder}`}>
                      {now.thumb && (
                        <img
                          src={now.thumb}
                          className={`w-72 h-72 sm:w-80 sm:h-80 rounded-[2rem] object-cover transition-all duration-1000 ${isLoading ? "blur-3xl opacity-30 scale-90" : "scale-100"} ${rainbow ? "animate-hue contrast-110" : ""}`}
                          alt=""
                        />
                      )}
                    </div>

                    <div className="text-center w-full">
                      <h2 className={`text-2xl font-black italic uppercase font-mono mb-2 truncate ${isLoading ? "opacity-30" : "text-white"}`}>{title}</h2>
                      <p className="font-mono text-[10px] tracking-[0.5em] opacity-40 uppercase">{subtitle}</p>
                    </div>

                    {/* SEEK BAR DRAG & DROP SANS SAUT */}
                    <div className="w-full space-y-2">
                      <div className="flex justify-between font-mono text-[10px] tracking-widest opacity-60">
                        <span className={neonText}>{formatTime(currentPos)}</span>
                        <span>{formatTime(dur)}</span>
                      </div>
                      <div className="relative h-6 flex items-center">
                        <input
                          type="range"
                          min={0}
                          max={Math.floor(dur)}
                          value={Math.floor(currentPos)}
                          disabled={isBusy}
                          onMouseDown={() => setIsDragging(true)}
                          onMouseUp={(e) => handleSeekEnd(parseInt((e.target as HTMLInputElement).value))}
                          onTouchStart={() => setIsDragging(true)}
                          onTouchEnd={() => handleSeekEnd(dragValue)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setDragValue(val);
                            setLocalPos(val); // Update immédiat pour la fluidité
                          }}
                          className={`absolute w-full h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 z-10 accent-white 
                            ${rainbow ? "accent-pink-500" : ""}`}
                        />
                        <div 
                          className={`absolute h-1.5 rounded-full pointer-events-none ${rainbow ? "bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 animate-hue" : "bg-[var(--c1)]"}`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Controls Main */}
                    <div className="flex items-center justify-between w-full">
                      <button onClick={() => sendCommand("seek", -15)} className="p-3 text-white/30 hover:text-white"><RotateCcw size={28} /></button>
                      <div className="flex items-center gap-6">
                        <button onClick={() => sendCommand("skip_back" as Command)} className="p-2 text-white/40 hover:text-white"><SkipBack size={32} fill="currentColor" /></button>
                        <button
                          onClick={() => sendCommand(paused ? "resume" : "pause")}
                          className={`w-20 h-20 rounded-full flex items-center justify-center border-2 bg-white/5 transition-all active:scale-90 ${neonBorder} ${neonText}`}
                        >
                          {paused ? <Play fill="currentColor" size={32} className="ml-1" /> : <Pause fill="currentColor" size={32} />}
                        </button>
                        <button onClick={() => sendCommand("skip")} className="p-2 text-white/40 hover:text-white"><SkipForward size={32} fill="currentColor" /></button>
                      </div>
                      <button onClick={() => sendCommand("seek", 15)} className="p-3 text-white/30 hover:text-white"><RotateCw size={28} /></button>
                    </div>

                    {/* Option Repeat */}
                    <button
                      onClick={() => sendCommand("repeat", repeat ? 0 : 1)}
                      className={`p-4 rounded-2xl border transition-all ${repeat ? (rainbow ? "border-pink-500 text-pink-500 shadow-pink-500/20" : "border-[var(--c1)] text-[var(--c1)]") : "border-white/5 text-white/20"}`}
                    >
                      <Repeat size={24} />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}