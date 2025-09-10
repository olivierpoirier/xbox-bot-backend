import type { ClipboardEvent } from "react";
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
}

export default function FormInputs({
  url, setUrl,
  name, setName,
  adminPass, setAdminPass,
  addToQueue, pasteInto, busy
}: Props) {

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
        <input
          className="w-full border border-slate-700 rounded-xl px-3.5 py-3 bg-panel text-ink"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={handlePasteUrl}
        />
        <button
          onClick={() => pasteInto(setUrl, pickUrlLike)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700"
        >
          📋 Coller l’URL
        </button>
      </div>

      {/* Pseudo */}
      <div className="grid gap-2">
        <input
          className="w-full border border-slate-700 rounded-xl px-3.5 py-3 bg-panel text-ink"
          placeholder="Ton pseudo (optionnel)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          onClick={() => pasteInto(setName)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700"
        >
          📋 Coller le pseudo
        </button>
      </div>

      {/* Admin pass */}
      <div className="grid gap-2">
        <input
          type="password"
          className="w-full border border-slate-700 rounded-xl px-3.5 py-3 bg-panel text-ink"
          placeholder="Mot de passe admin (si requis)"
          value={adminPass}
          onChange={(e) => setAdminPass(e.target.value)}
        />
        <button
          onClick={() => pasteInto(setAdminPass)}
          disabled={!!busy}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700"
        >
          📋 Coller le mot de passe
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
