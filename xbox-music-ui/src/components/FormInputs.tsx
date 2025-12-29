import type { ClipboardEvent } from "react";
import { ClipboardPaste, PlusCircle, User, Link2 } from "lucide-react";
import { pickUrlLike } from "../lib/api";

interface Props {
  url: string;
  setUrl: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  addToQueue: () => void;
  pasteInto: (setter: (s: string) => void, transform?: (s: string) => string) => void;
  busy: string | null;
  rainbow?: boolean;
}

export default function FormInputs({
  url, setUrl,
  name, setName,
  addToQueue, pasteInto, busy, rainbow = false
}: Props) {

  // Conteneur de l'input : On gère la bordure ici uniquement
  const formCls = `relative transition-all duration-300 rounded-xl bg-panel shadow-soft ${
    rainbow ? "rainbow-border animate-hue" : "themed-border"
  }`;

  const handlePasteUrl = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData("text") || "";
    if (text) {
      e.preventDefault();
      setUrl(pickUrlLike(text));
    }
  };

  const isButtonDisabled = !!busy || !url || !name;

  // Style des boutons secondaires (Coller)
  const secondaryBtnCls = "mt-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-white/50 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all disabled:opacity-30";

  return (
    <div className="grid gap-4 md:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[2fr,1.2fr,auto] mb-8 p-1">
      
      {/* SECTION URL SIGNAL */}
      <div className="flex flex-col">
        <label className="text-[10px] font-mono uppercase tracking-[0.2em] mb-1.5 ml-1 text-white/40 flex items-center gap-2">
          <Link2 size={12} className={rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]"} />
          Source Signal
        </label>
        
        <div className={formCls}>
          <input
            className="w-full px-4 py-3 bg-transparent text-white font-mono text-sm placeholder:text-white/20 focus:outline-none border-none ring-0"
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={handlePasteUrl}
          />
          {/* Effet Scanline interne (subtile) */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] rounded-xl" />
        </div>

        <button
          onClick={() => pasteInto(setUrl, pickUrlLike)}
          disabled={!!busy}
          className={secondaryBtnCls}
        >
          <ClipboardPaste className="w-3 h-3" />
          Auto-Link
        </button>
      </div>

      {/* SECTION OPERATOR ID */}
      <div className="flex flex-col">
        <label className="text-[10px] font-mono uppercase tracking-[0.2em] mb-1.5 ml-1 text-white/40 flex items-center gap-2">
          <User size={12} className={rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]"} />
          Operator ID
        </label>
        
        <div className={formCls}>
          <input
            className="w-full px-4 py-3 bg-transparent text-white font-mono text-sm placeholder:text-white/20 focus:outline-none border-none ring-0"
            placeholder="Guest_01"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] rounded-xl" />
        </div>

        <button
          onClick={() => pasteInto(setName)}
          disabled={!!busy}
          className={secondaryBtnCls}
        >
          <ClipboardPaste className="w-3 h-3" />
          Recall ID
        </button>
      </div>

      {/* BOUTON TRANSMIT */}
      <div className="flex flex-col justify-end">
        <button
          onClick={addToQueue}
          disabled={isButtonDisabled}
          className={`
            relative h-[48px] px-8 rounded-xl font-mono font-black italic uppercase tracking-tighter transition-all duration-300
            flex items-center justify-center gap-2 overflow-hidden
            ${isButtonDisabled 
              ? "bg-white/5 text-white/20 border border-white/5 cursor-not-allowed" 
              : "theme-active-button text-white shadow-[0_0_15px_rgba(255,255,255,0.1)] hover:scale-[1.02] active:scale-95"
            }
          `}
        >
          {busy === "play" ? (
            <>
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span>Syncing...</span>
            </>
          ) : (
            <>
              <PlusCircle size={18} />
              <span>Transmit</span>
            </>
          )}
          
          {/* Lueur au survol */}
          {!isButtonDisabled && (
            <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 hover:opacity-100 transition-opacity pointer-events-none" />
          )}
        </button>
        {/* Espaceur pour aligner avec les boutons secondaires en desktop */}
        <div className="h-[30px] hidden lg:block" />
      </div>
    </div>
  );
}