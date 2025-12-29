import { AnimatePresence, motion } from "framer-motion";
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  RotateCw,
  Repeat,
  X,
  ChevronUp
} from "lucide-react";
import React, { useState } from "react";
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

export default function PlayerBar({
  now,
  paused,
  repeat,
  busy,
  sendCommand,
  rainbow = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const isBusy = Boolean(busy); // Corrigé : utilisé pour désactiver les boutons

  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  const pos = hasDur ? Math.min(dur, Math.max(0, currentPosSec(now, paused))) : 0;
  const progressPct = hasDur ? (pos / dur) * 100 : 0;

  const title = now?.title || now?.url || "Scanning Signal...";
  const subtitle = now?.addedBy ? `USER: ${now.addedBy.toUpperCase()}` : "SOURCE: UNKNOWN";

  // Styles typés proprement pour éviter l'erreur 'any'
  const sliderStyle = {
    '--c1': 'var(--c1)',
    '--c2': 'var(--c2)'
  } as React.CSSProperties;

  const glassClass = "bg-black/40 backdrop-blur-xl border-t border-white/10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]";
  const neonText = rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]";
  const neonBorder = rainbow ? "rainbow-border" : "themed-border";

  return (
    <AnimatePresence>
      {now?.url && (
        <>
          {/* ===== BARRE PRINCIPALE MINIMALISTE RETROWAVE ===== */}
          <motion.div
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className={`fixed bottom-0 inset-x-0 z-40 h-20 ${glassClass} flex flex-col justify-end`}
          >
            {/* Ligne de progression néon */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/5">
              <motion.div
                className={`h-full shadow-[0_0_15px_rgba(255,255,255,0.5)] ${rainbow ? "bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500" : "bg-[var(--c1)]"}`}
                animate={{ width: `${progressPct}%` }}
                transition={{ ease: "linear", duration: 0.5 }}
              />
            </div>

            <div className="flex items-center h-full px-4 gap-3">
              {/* Thumbnail Mini avec accès vue étendue */}
              <button 
                className="relative shrink-0 w-12 h-12 rounded border border-white/20 overflow-hidden group"
                onClick={() => setExpanded(true)}
              >
                {now.thumb && <img src={now.thumb} className="w-full h-full object-cover" alt="" />}
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <ChevronUp className="text-white w-6 h-6" />
                </div>
              </button>

              {/* Titre et User (Style Terminal) */}
              <button className="flex-1 min-w-0 text-left" onClick={() => setExpanded(true)}>
                <div className={`text-[10px] font-mono uppercase tracking-widest opacity-60 mb-0.5`}>
                  {subtitle}
                </div>
                <div className="text-sm font-bold truncate tracking-tight text-white/90 font-mono italic">
                  {title}
                </div>
              </button>

              {/* Contrôles Rapides avec protection isBusy */}
              <div className="flex items-center gap-1 sm:gap-4">
                <button 
                  onClick={() => sendCommand("seek", -15)} 
                  disabled={isBusy}
                  className="hidden sm:block p-2 text-white/50 hover:text-white transition-colors disabled:opacity-30"
                >
                  <RotateCcw size={18} />
                </button>
                
                <button
                  onClick={() => sendCommand(paused ? "resume" : "pause")}
                  disabled={isBusy}
                  className={`p-3 rounded-lg border border-white/10 bg-white/5 transition-all ${neonText} disabled:opacity-30`}
                >
                  {paused ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}
                </button>

                <button 
                  onClick={() => sendCommand("seek", 15)} 
                  disabled={isBusy}
                  className="hidden sm:block p-2 text-white/50 hover:text-white transition-colors disabled:opacity-30"
                >
                  <RotateCw size={18} />
                </button>

                <button 
                  onClick={() => sendCommand("skip")} 
                  disabled={isBusy}
                  className="p-2 text-white/70 hover:text-white transition-colors disabled:opacity-30"
                >
                  <SkipForward size={22} fill="currentColor" />
                </button>
              </div>
            </div>
          </motion.div>

          {/* ============================
              VUE MOBILE / ÉTENDUE (FULL SCI-FI)
              ============================ */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                className="fixed inset-0 z-50 flex flex-col bg-[#050505] overflow-y-auto no-scrollbar"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
              >
                {/* Effet de lueur d'ambiance basé sur le thème */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  <div className={`absolute top-[-10%] left-[-10%] w-[50%] h-[50%] blur-[120px] rounded-full opacity-20 ${rainbow ? "bg-pink-500 animate-pulse" : "bg-[var(--c1)]"}`} />
                  <div className={`absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] blur-[120px] rounded-full opacity-20 ${rainbow ? "bg-cyan-500 animate-pulse" : "bg-[var(--c2)]"}`} />
                </div>

                <div className="relative z-10 flex flex-col min-h-full max-w-lg mx-auto w-full p-8">
                  <button onClick={() => setExpanded(false)} className="self-center mb-8 p-2 text-white/30 hover:text-white transition-colors border-b border-white/5 w-20 flex justify-center">
                    <X size={32} />
                  </button>

                  <div className="flex-1 flex flex-col justify-center items-center gap-10">
                    {/* Artwork avec bordure néon dynamique */}
                    <div className={`relative p-1 rounded-2xl ${neonBorder} bg-black`}>
                      {now.thumb && (
                        <img
                          src={now.thumb}
                          className="w-64 h-64 sm:w-80 sm:h-80 rounded-xl object-cover"
                          alt=""
                        />
                      )}
                      {/* Effet Scanlines rétro */}
                      <div className="absolute inset-0 pointer-events-none opacity-20 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
                    </div>

                    <div className="text-center">
                      <h2 className="text-2xl font-black text-white italic tracking-tighter mb-2 leading-tight uppercase font-mono">
                        {title}
                      </h2>
                      <p className={`font-mono text-xs tracking-[0.3em] opacity-60`}>
                         {subtitle}
                      </p>
                    </div>

                    {/* Slider de progression digital */}
                    <div className="w-full space-y-4">
                      <div className="flex justify-between font-mono text-[10px] text-white/40 tracking-widest">
                        <span className={neonText}>{formatTime(pos)}</span>
                        <span>{formatTime(dur)}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.floor(dur)}
                        value={Math.floor(pos)}
                        disabled={isBusy}
                        onChange={(e) => sendCommand("seek_abs", parseInt(e.target.value))}
                        className={`w-full h-1 bg-white/10 rounded-none appearance-none cursor-pointer accent-white ${rainbow ? "animate-hue" : ""}`}
                        style={sliderStyle}
                      />
                    </div>

                    {/* Contrôles Principaux Étendus */}
                    <div className="grid grid-cols-3 gap-8 items-center w-full max-w-xs">
                      <button 
                        onClick={() => sendCommand("seek", -15)} 
                        disabled={isBusy}
                        className="flex flex-col items-center gap-2 text-white/40 hover:text-white transition-all disabled:opacity-20"
                      >
                        <RotateCcw size={28} />
                        <span className="text-[9px] font-mono">-15S</span>
                      </button>

                      <button
                        onClick={() => sendCommand(paused ? "resume" : "pause")}
                        disabled={isBusy}
                        className={`w-20 h-20 rounded-full flex items-center justify-center border-2 border-white/20 hover:scale-110 transition-transform active:scale-95 bg-white/5 ${neonText} disabled:opacity-30`}
                      >
                        {paused ? <Play fill="currentColor" size={32} className="ml-1" /> : <Pause fill="currentColor" size={32} />}
                      </button>

                      <button 
                        onClick={() => sendCommand("seek", 15)} 
                        disabled={isBusy}
                        className="flex flex-col items-center gap-2 text-white/40 hover:text-white transition-all disabled:opacity-20"
                      >
                        <RotateCw size={28} />
                        <span className="text-[9px] font-mono">+15S</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-12 mt-4">
                      <button 
                        onClick={() => sendCommand("repeat", repeat ? 0 : 1)}
                        className={`p-4 rounded-xl transition-all border ${repeat ? "border-[var(--c1)] text-[var(--c1)] shadow-[0_0_20px_var(--c1)]" : "border-white/5 text-white/20"}`}
                      >
                        <Repeat size={24} />
                      </button>
                      <button 
                         onClick={() => sendCommand("skip")}
                         disabled={isBusy}
                         className="p-4 rounded-xl border border-white/5 text-white/60 hover:text-white hover:border-white/20 disabled:opacity-20"
                      >
                        <SkipForward size={24} fill="currentColor" />
                      </button>
                    </div>
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