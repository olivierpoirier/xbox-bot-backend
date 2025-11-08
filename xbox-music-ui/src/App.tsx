// src/App.tsx

import { useCallback, useEffect, useState } from "react";
import { Rainbow, Palette } from "lucide-react";
import AppIcon from "./assets/Icon.png";
import FormInputs from "./components/FormInputs";
import NowPlaying from "./components/NowPlaying";
import QueueList from "./components/QueueList";
import Toast from "./components/Toast";
import useLiveQueue from "./hooks/useLiveQueue";
import { pickUrlLike } from "./lib/api";
import PlayerBar from "./components/PlayerBar";
// Import mis à jour pour récupérer tout depuis le fichier lib/themes
import ThemeDock from "./components/ThemeDock";
import { type ThemeName, THEME_ORDER, THEMES_SWATCH, type ThemeMode } from "./lib/themes";
import type { Now, QueueItem, Control } from "./types";

type Command = "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat" | "seek" | "seek_abs";

// --- Définitions de thèmes déplacées/supprimées ---
/*
const THEMES: Record<ThemeName, { c1: string; c2: string }> = {
  classic: { c1: "#60a5fa", c2: "#f472b6" },
  // ... (supprimé)
};
*/
// --------------------------------------------------

export default function App() {
  const [url, setUrl] = useState<string>("");
  const [name, setName] = useState<string>("");

  const [mode, setMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("xmb_theme_mode") as ThemeMode) || "color"; } catch { return "color"; }
  });
  const [theme, setTheme] = useState<ThemeName>(() => {
    try { return (localStorage.getItem("xmb_theme") as ThemeName) || "classic"; } catch { return "classic"; }
  });

  const { state, toast, setToast, play, command, busy, clear, setBusy } = useLiveQueue();

  useEffect(() => { try { localStorage.setItem("xmb_theme_mode", mode); } catch { /* empty */ } }, [mode]);
  useEffect(() => { try { localStorage.setItem("xmb_theme", theme); } catch { /* empty */ } }, [theme]);

  useEffect(() => {
    try {
      const n = localStorage.getItem("xmb_name"); if (n) setName(n);
    } catch { setToast("Impossible de charger tes préférences locales."); }
  }, [setToast]);

  useEffect(() => { try { localStorage.setItem("xmb_name", name || ""); } catch { /* empty */ } }, [name]);

  const pasteInto = useCallback(async (setter: (s: string) => void, transform?: (s: string) => string) => {
    try {
      const text = await navigator.clipboard.readText();
      setter(transform ? transform(text) : text);
      setToast("Collé depuis le presse-papiers ✅");
    } catch { setToast("Impossible de lire le presse-papiers."); }
  }, [setToast]);

  const addToQueue = useCallback(() => {
    try {
      const u = pickUrlLike(url);
      if (!/^https?:\/\//i.test(u)) { setToast("URL invalide ❌"); return; }
      play(u, name || "anon");
      setUrl("");
    } catch { setToast("Impossible d’ajouter le lien."); }
  }, [url, name, play, setToast]);

  const sendCommand = useCallback((cmd: Command, arg?: number) => {
    try {
      command(cmd, arg);
      window.setTimeout(() => setBusy(null), 4000);
    } catch {
      setBusy(null);
      setToast(`Commande échouée: ${cmd}`);
    }
  }, [command, setBusy, setToast]);

  const clearWithPass = useCallback(() => clear(), [clear]);

  const control: Control = state.control ?? { paused: false, skipSeq: 0, repeat: false };
  const paused = Boolean(control.paused);
  const repeat = Boolean(control.repeat);
  const now: Now | null = state.now ?? null;
  const queue: QueueItem[] = state.queue ?? [];

  // Utiliser THEMES_SWATCH pour récupérer c1 et c2
  const { c1, c2 } = THEMES_SWATCH[theme];
  const rainbow = mode === "rainbow";
  const rootThemeClass = rainbow ? "theme-rainbow" : `theme-${theme}`;

  const pickRainbow = () => setMode("rainbow");
  const pickColor = (t: ThemeName) => { setTheme(t); setMode("color"); };

  return (
    <div className={`min-h-screen bg-bg text-ink ${rootThemeClass} pb-20`}>
      <main className="max-w-6xl mx-auto px-4 md:px-6 py-6">
      <header className="mb-5 flex flex-col md:flex-row items-center md:items-start justify-between gap-3 md:gap-0">
        <div className="text-center md:text-left flex items-center gap-2">
          <img
            src={AppIcon}
            alt="Xbox Music Bot"
            className="w-32 h-32 rounded-lg object-contain"
          />
          <h1 className="text-2xl md:text-3xl font-bold">Xbox Music Bot</h1>
        </div>

        <div className="flex items-center gap-2 mt-2 md:mt-0">
          <button
            onClick={pickRainbow}
            className={`px-3 py-2 rounded-xl border ${
              rainbow ? "bg-pink-600 text-white border-pink-400" : "bg-slate-800 text-white border-slate-700"
            } inline-flex items-center gap-2`}
            title="Activer Rainbow"
            aria-pressed={rainbow}
          >
            <Rainbow className="w-4 h-4" />
            Rainbow
          </button>

          <button
            onClick={() => pickColor(THEME_ORDER[(THEME_ORDER.indexOf(theme)+1)%THEME_ORDER.length])}
            className="px-3 py-2 rounded-xl bg-slate-800 text-white border border-slate-700 inline-flex items-center gap-2"
            title="Parcourir les couleurs"
            aria-pressed={!rainbow}
          >
            <Palette className="w-4 h-4" />
            Couleurs
          </button>
        </div>
      </header>

        <FormInputs
          url={url} setUrl={setUrl}
          name={name} setName={setName}
          addToQueue={addToQueue} pasteInto={pasteInto}
          busy={busy}
          rainbow={rainbow}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NowPlaying
            now={now}
            paused={paused}
            repeat={repeat}
            busy={busy}
            eqColorFrom={!rainbow ? c1 : undefined}
            eqColorTo={!rainbow ? c2 : undefined}
            rainbow={rainbow}
          />

          <QueueList
            queue={queue}
            busy={busy}
            onSkipGroup={() => sendCommand("skip_group")}
            onClear={() => clearWithPass()}
            rainbow={rainbow}
          />
        </div>

        {toast && <Toast message={toast} clear={() => setToast("")} />}

        <footer className="text-center mt-6 text-xs text-muted">
          Bot de musique créé par Olivier Poirier, 2025
        </footer>
      </main>

      <ThemeDock
        value={theme}
        mode={mode}
        onPick={(m, t) => (m === "rainbow" ? pickRainbow() : pickColor(t || theme))}
      />

      <PlayerBar
        now={now}
        paused={paused}
        repeat={repeat}
        busy={busy}
        sendCommand={sendCommand}
        rainbow={rainbow}
      />
    </div>
  );
}