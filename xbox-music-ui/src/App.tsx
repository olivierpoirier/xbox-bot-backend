import { useCallback, useEffect, useState } from "react";
import FormInputs from "./components/FormInputs";
import NowPlaying from "./components/NowPlaying";
import QueueList from "./components/QueueList";
import StickyControls from "./components/StickyControls";
import Toast from "./components/Toast";
import useLiveQueue from "./hooks/useLiveQueue"; // <- le hook Socket.IO
import { pickUrlLike } from "./lib/api";        // ton helper existant

export default function App() {
  // UI state local
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [adminPass, setAdminPass] = useState("");

  // État live via Socket.IO (state poussé par le serveur) + actions
  const { state, toast, setToast, play, command, clear } = useLiveQueue();

  /* --------- Chargement / persistance localStorage --------- */
  useEffect(() => {
    try {
      const n = localStorage.getItem("xmb_name"); if (n) setName(n);
      const p = localStorage.getItem("xmb_admin_pass"); if (p) setAdminPass(p);
    } catch { /* empty */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("xmb_name", name || ""); } catch { /* empty */ } }, [name]);
  useEffect(() => { try { localStorage.setItem("xmb_admin_pass", adminPass || ""); } catch { /* empty */ } }, [adminPass]);

  /* ------------------- Helpers d’actions ------------------- */
  // Collage générique depuis le presse-papier
  const pasteInto = useCallback(
    async (setter: (s: string) => void, transform?: (s: string) => string) => {
      try {
        const text = await navigator.clipboard.readText();
        let v = text ?? "";
        if (transform) v = transform(v);
        setter(v);
        setToast("Collé depuis le presse-papier ✅");
      } catch {
        setToast("Impossible de lire le presse-papier.");
      }
    },
    [setToast]
  );

  // Ajouter une URL à la file (émission socket)
  const addToQueue = useCallback(() => {
    const u = pickUrlLike(url);
    if (!/^https?:\/\//i.test(u)) {
      setToast("URL invalide ❌");
      return;
    }
    play(u, name || "anon");
    setUrl("");
  }, [url, name, play, setToast]);

  // Wrappers qui injectent adminPass pour les commandes protégées
  const sendCommand = useCallback(
    (cmd: "pause" | "resume" | "skip" | "volume", arg?: number) => {
      command(cmd, arg, adminPass);
    },
    [command, adminPass]
  );

  const clearQueue = useCallback(() => {
    clear(adminPass);
  }, [clear, adminPass]);

  // Dérivés d’affichage
  const volume = state.control?.volume ?? 80;
  const paused = !!state.control?.paused;
  const busy: string | null = null; // pas de busy côté socket, mais on garde la prop pour tes composants

  return (
    <main className="min-h-screen max-w-5xl mx-auto p-5 text-ink bg-bg">
      {/* Header */}
      <header className="mb-4">
        <h1 className="text-2xl md:text-3xl font-bold">🎮 Xbox Music Bot</h1>
        <p className="text-muted mt-1">
          Colle un lien YouTube/MP3/radio. Lecture locale (Voicemeeter → Xbox). Temps réel via WebSocket.
        </p>
      </header>

      {/* Formulaire d’entrée */}
      <FormInputs
        url={url}
        setUrl={setUrl}
        name={name}
        setName={setName}
        adminPass={adminPass}
        setAdminPass={setAdminPass}
        addToQueue={addToQueue}
        pasteInto={pasteInto}
        busy={busy}
      />

      {/* Grille NowPlaying + Queue */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NowPlaying
          now={state.now || null}
          volume={volume}
          paused={paused}
          busy={busy}
          sendCommand={sendCommand}
          clearQueue={clearQueue}
        />
        <QueueList queue={state.queue || []} />
      </div>

      {/* Contrôles mobiles collants */}
      <StickyControls
        paused={paused}
        busy={busy}
        sendCommand={(c) => sendCommand(c)}
        clearQueue={clearQueue}
      />

      {/* Toast */}
      {toast && <Toast message={toast} clear={() => setToast("")} />}

      {/* Footer */}
      <footer className="text-center mt-6 text-xs text-muted">
        Astuce : si tu veux réserver certaines actions, définis <code>ADMIN_PASS</code> côté serveur et saisis-le ici.
      </footer>
    </main>
  );
}
