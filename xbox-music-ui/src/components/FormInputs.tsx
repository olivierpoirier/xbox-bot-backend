import type { ClipboardEvent } from "react";
import { ClipboardPaste } from "lucide-react";
import { pickUrlLike } from "../lib/api";

interface Props {
  url: string;
  setUrl: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  adminPass: string;
  setAdminPass: (s: string) => void;
  addToQueue: () => void;
  pasteInto: (setter: (s: string) => void, transform?: (s: string) => string) => void;
  busy: string | null;
  rainbow?: boolean;
}

export default function FormInputs({
  url, setUrl,
  name, setName,
  adminPass, setAdminPass,
  addToQueue, pasteInto, busy, rainbow = false
}: Props) {

  const formCls = `bg-bg border border-transparent rounded-xl shadow-soft ${
    rainbow ? "neon-glow rainbow-border animate-hue" : "neon-glow themed-border"
  }`;

  const handlePasteUrl = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData("text") || "";
    if (text) {
      e.preventDefault();
      setUrl(pickUrlLike(text));
    }
  };

  return (
    <div className="grid gap-2 md:gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[2fr,1.2fr,1.2fr,auto] mb-4">
      {/* URL */}
      <div className="grid gap-2">
        <div className={formCls}>
          <input
            className="w-full border border-transparent rounded-xl px-3.5 py-3 bg-panel text-ink"
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={handlePasteUrl}
          />
        </div>
        <button
          onClick={() => pasteInto(setUrl, pickUrlLike)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 inline-flex items-center gap-2"
        >
          <ClipboardPaste className="w-4 h-4" />
          Coller l’URL
        </button>
      </div>

      {/* Pseudo */}
      <div className="grid gap-2">
        <div className={formCls}>
          <input
            className="w-full border border-transparent rounded-xl px-3.5 py-3 bg-panel text-ink"
            placeholder="Ton pseudo (optionnel)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button
          onClick={() => pasteInto(setName)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 inline-flex items-center gap-2"
        >
          <ClipboardPaste className="w-4 h-4" />
          Coller le pseudo
        </button>
      </div>

      {/* Admin pass */}
      <div className="grid gap-2">
        <div className={formCls}>
          <input
            type="password"
            className="w-full border border-transparent rounded-xl px-3.5 py-3 bg-panel text-ink"
            placeholder="Mot de passe admin (si requis)"
            value={adminPass}
            onChange={(e) => setAdminPass(e.target.value)}
          />
        </div>
        <button
          onClick={() => pasteInto(setAdminPass)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 inline-flex items-center gap-2"
        >
          <ClipboardPaste className="w-4 h-4" />
          Coller le mot de passe
        </button>
      </div>

      <button
        onClick={addToQueue}
        disabled={!!busy}
        className="px-4 py-3 rounded-xl bg-blue-600 text-white font-bold disabled:opacity-50"
      >
        {busy === "play" ? "Ajout…" : "Ajouter"}
      </button>
    </div>
  );
}
