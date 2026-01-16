import { useCallback, useEffect, useState } from "react";
import AppHeader from "./components/AppHeader";
import FormInputs from "./components/FormInputs";
import NowPlaying from "./components/NowPlaying";
import QueueList from "./components/QueueList";
import Toast from "./components/Toast";
import PlayerBar from "./components/PlayerBar";
import ThemeDock from "./components/ThemeDock";

import useLiveQueue from "./hooks/useLiveQueue";
import { pickUrlLike } from "./lib/api";
import { type ThemeName, type ThemeMode, THEME_ORDER, THEMES_SWATCH } from "./lib/themes";
import type { Now, QueueItem, Control } from "./types";
import SystemAlert from "./components/SystemAlert";

type Command =
  | "pause"
  | "resume"
  | "skip"
  | "skip_group"
  | "shuffle"
  | "repeat"
  | "seek"
  | "seek_abs";

export default function App() {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  const [mode, setMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("xmb_theme_mode") as ThemeMode) || "color"; }
    catch (err) { console.warn("Impossible de lire xmb_theme_mode", err); return "color"; }
  });

  const [theme, setTheme] = useState<ThemeName>(() => {
    try { return (localStorage.getItem("xmb_theme") as ThemeName) || "classic"; }
    catch (err) { console.warn("Impossible de lire xmb_theme", err); return "classic"; }
  });

  const { 
    state, 
    toast, 
    setToast, 
    systemError, // Récupéré ici
    play, 
    command, 
    busy, 
    clear, 
    setBusy, 
    reorderQueue, 
    removeQueueItem 
  } = useLiveQueue();

  // --- LocalStorage ---
  useEffect(() => { try { localStorage.setItem("xmb_theme_mode", mode); } catch (err) { console.warn(err); } }, [mode]);
  useEffect(() => { try { localStorage.setItem("xmb_theme", theme); } catch (err) { console.warn(err); } }, [theme]);
  useEffect(() => { try { const n = localStorage.getItem("xmb_name"); if (n) setName(n); } catch (err) { console.warn(err); setToast("Impossible de charger ton nom sauvegardé."); } }, [setToast]);
  useEffect(() => { try { localStorage.setItem("xmb_name", name || ""); } catch (err) { console.warn(err); } }, [name]);

  // --- Actions ---
  const pasteInto = useCallback(async (setter: (s: string) => void, transform?: (s: string) => string) => {
    try {
      const text = await navigator.clipboard.readText();
      setter(transform ? transform(text) : text);
      setToast("Collé depuis le presse-papiers ✅");
    } catch (err) {
      console.warn("Clipboard inaccessible", err);
      setToast("Impossible de lire le presse-papiers.");
    }
  }, [setToast]);

  const addToQueue = useCallback(() => {
    try {
      const u = pickUrlLike(url);
      if (!/^https?:\/\//i.test(u)) { setToast("URL invalide ❌"); return; }
      play(u, name || "anon");
      setUrl("");
    } catch (err) {
      console.error("Erreur addToQueue", err);
      setToast("Impossible d’ajouter le lien.");
    }
  }, [url, name, play, setToast]);

  const sendCommand = useCallback((cmd: Command, arg?: number) => {
    try { command(cmd, arg); window.setTimeout(() => setBusy(null), 4000); }
    catch (err) { console.error(`Commande échouée (${cmd})`, err); setBusy(null); setToast(`Commande échouée: ${cmd}`); }
  }, [command, setBusy, setToast]);

  const clearWithPass = useCallback(() => {
    try { clear(); } catch (err) { console.error("Erreur clear queue", err); setToast("Impossible de vider la file."); }
  }, [clear, setToast]);

  // --- Derived State ---
  const control: Control = state.control ?? { paused: false, skipSeq: 0, repeat: false };
  const paused = Boolean(control.paused);
  const repeat = Boolean(control.repeat);
  const now: Now | null = state.now ?? null;
  const queue: QueueItem[] = state.queue ?? [];
  const rainbow = mode === "rainbow";
  const rootThemeClass = rainbow ? "theme-rainbow" : `theme-${theme}`;
  const { c1, c2 } = THEMES_SWATCH[theme];

  // --- Theme Helpers ---
  const pickRainbow = () => setMode("rainbow");
  const pickNextColor = () => {
    try { const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]; setTheme(next); setMode("color"); }
    catch (err) { console.error("Erreur changement de thème", err); setToast("Impossible de changer le thème."); }
  };

  return (
    <div className={`min-h-screen bg-bg text-ink ${rootThemeClass} pb-28 relative`}>

      <SystemAlert isOpen={systemError} rainbow={rainbow} />
      {/* Header */}
      <AppHeader theme={theme} rainbow={rainbow} onPickRainbow={pickRainbow} onNextColor={pickNextColor} />

      {/* Toasts */}
      {toast && (
        <Toast 
          message={toast} 
          clear={() => setToast("")} 
          rainbow={rainbow} 
        />
      )}

      <main className="max-w-6xl mx-auto px-4 md:px-6 py-6">
        <FormInputs url={url} setUrl={setUrl} name={name} setName={setName} addToQueue={addToQueue} pasteInto={pasteInto} busy={busy} rainbow={rainbow} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <NowPlaying now={now} paused={paused} repeat={repeat} busy={busy} rainbow={rainbow} eqColorFrom={!rainbow ? c1 : undefined} eqColorTo={!rainbow ? c2 : undefined} />
          <QueueList queue={queue} busy={busy} rainbow={rainbow} onSkipGroup={() => sendCommand("skip_group")} onClear={clearWithPass} onReorder={reorderQueue} onRemove={removeQueueItem} />
        </div>

        <footer className="text-center mt-6 text-xs text-muted">
          Bot de musique créé par Olivier Poirier, 2025
        </footer>
      </main>

      {/* Dock & Player */}
      <ThemeDock value={theme} mode={mode} onPick={(m, t) => m === "rainbow" ? pickRainbow() : setTheme(t || theme)} />
      <PlayerBar now={now} paused={paused} repeat={repeat} busy={busy} rainbow={rainbow} sendCommand={sendCommand} />
    </div>
  );
}
