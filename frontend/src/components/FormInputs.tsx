import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  ClipboardPaste,
  Link2,
  Music2,
  PlusCircle,
  Search,
  User,
  Youtube,
} from "lucide-react";
import { pickUrlLike } from "../lib/api";
import type { ThemeName } from "../lib/themes";

interface Props {
  url: string;
  setUrl: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  addToQueue: () => void;
  pasteInto: (
    setter: (s: string) => void,
    transform?: (s: string) => string
  ) => void;
  busy: string | null;
  rainbow?: boolean;
  theme: ThemeName;
}

export default function FormInputs({
  url,
  setUrl,
  name,
  setName,
  addToQueue,
  pasteInto,
  busy,
  rainbow = false,
  theme,
}: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";
  const isPremium = !rainbow && theme === "premium";
  const trimmedUrl = url.trim();

  const formCls = `relative transition-all duration-300 shadow-soft ${
    isAdventurer ? "organic-panel" : "rounded-xl bg-panel"
  } ${
    rainbow ? "rainbow-border rainbow-cycle" : "themed-border"
  }`;

  const inputCls = [
    "w-full px-4 py-3 bg-transparent text-white placeholder:text-white/20 focus:outline-none border-none ring-0",
    isAdventurer ? "font-medium tracking-wide" : "font-mono text-sm",
    isPremium ? "text-[15px]" : "",
    rainbow ? "rainbow-cycle" : "",
  ].join(" ");

  const labelCls = [
    "text-[10px] uppercase tracking-[0.2em] mb-1.5 ml-1 flex items-center gap-2",
    isAdventurer ? "font-semibold text-[#dbe9cf]/70" : "font-mono text-white/40",
    rainbow ? "rainbow-cycle" : "",
  ].join(" ");

  const secondaryBtnCls = isAdventurer
    ? `mt-2 px-3 py-2 rounded-full bg-white/5 border border-[#a3c46f]/20 flex items-center gap-2 text-[11px] font-medium text-[#e7efd9]/70 hover:text-white hover:bg-white/10 hover:border-[#a3c46f]/40 transition-all disabled:opacity-30 ${
        rainbow ? "rainbow-cycle" : ""
      }`
    : `mt-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-white/50 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all disabled:opacity-30 ${
        rainbow ? "rainbow-cycle" : ""
      }`;

  const sourceHint = (() => {
    const candidate = pickUrlLike(trimmedUrl);
    const lowered = candidate.toLowerCase();

    if (!trimmedUrl) {
      return {
        label: "En attente",
        detail: "Colle un lien ou écris un titre.",
        icon: Link2,
        tone: "text-white/45",
      };
    }

    if (lowered.includes("open.spotify.com") || lowered.startsWith("spotify:")) {
      return {
        label: "Spotify",
        detail: "Le backend trouvera le meilleur audio.",
        icon: Music2,
        tone: "text-emerald-200",
      };
    }

    if (lowered.includes("youtube.com") || lowered.includes("youtu.be")) {
      return {
        label: "YouTube",
        detail: "Lecture directe optimisée audio.",
        icon: Youtube,
        tone: "text-red-200",
      };
    }

    if (lowered.includes("soundcloud.com") || lowered.includes("snd.sc")) {
      return {
        label: "SoundCloud",
        detail: "Fallback YouTube si le direct bloque.",
        icon: Music2,
        tone: "text-orange-200",
      };
    }

    if (/^https?:\/\//i.test(candidate)) {
      return {
        label: "Lien web",
        detail: "Le serveur va tenter de l'analyser.",
        icon: Link2,
        tone: "text-sky-200",
      };
    }

    return {
      label: "Recherche",
      detail: "Recherche texte côté serveur.",
      icon: Search,
      tone: "text-violet-200",
    };
  })();

  const SourceHintIcon = sourceHint.icon;

  const handlePasteUrl = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData("text") || "";
    if (text) {
      e.preventDefault();
      setUrl(pickUrlLike(text));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!busy && trimmedUrl) {
        addToQueue();
      }
    }
  };

  const isButtonDisabled = !!busy || !trimmedUrl;
  const submitLabel = busy === "play"
    ? "Syncing..."
    : trimmedUrl
    ? "Transmit"
    : "Signal requis";

  return (
    <div className={`grid gap-4 md:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[2fr,1.2fr,auto] mb-8 p-1 ${rainbow ? "rainbow-cycle" : ""}`}>
      <div className="flex flex-col">
        <label className={labelCls}>
          <Link2 size={12} className={rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]"} />
          Source Signal
        </label>

        <div className={formCls}>
          <input
            className={inputCls}
            placeholder="Spotify, YouTube, SoundCloud ou recherche"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={handlePasteUrl}
            onKeyDown={handleKeyDown}
            autoComplete="url"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="source-status"
          />
          {!isAdventurer && (
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] rounded-xl" />
          )}
        </div>

        <div
          id="source-status"
          className={`mt-2 min-h-[20px] flex items-center gap-2 text-xs ${
            isAdventurer ? "text-[#e7efd9]/65" : "text-white/50"
          } ${rainbow ? "rainbow-cycle" : ""}`}
        >
          <span className={`inline-flex items-center gap-1.5 ${sourceHint.tone}`}>
            <SourceHintIcon className="w-3.5 h-3.5" />
            <span className="font-medium">{sourceHint.label}</span>
          </span>
          <span className="truncate">{sourceHint.detail}</span>
        </div>

        <button
          onClick={() => pasteInto(setUrl, pickUrlLike)}
          disabled={!!busy}
          className={secondaryBtnCls}
          type="button"
        >
          <ClipboardPaste className="w-3 h-3" />
          Auto-Link
        </button>
      </div>

      <div className="flex flex-col">
        <label className={labelCls}>
          <User size={12} className={rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]"} />
          Operator ID
        </label>

        <div className={formCls}>
          <input
            className={inputCls}
            placeholder="Guest_01 optionnel"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="nickname"
            aria-describedby="operator-status"
          />
          {!isAdventurer && (
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] rounded-xl" />
          )}
        </div>

        <div
          id="operator-status"
          className={`mt-2 min-h-[20px] text-xs ${
            isAdventurer ? "text-[#e7efd9]/65" : "text-white/50"
          } ${rainbow ? "rainbow-cycle" : ""}`}
        >
          {name.trim() ? `Ajouté par ${name.trim()}` : "Sans nom, ce sera ajouté par anon."}
        </div>

        <button
          onClick={() => pasteInto(setName)}
          disabled={!!busy}
          className={secondaryBtnCls}
          type="button"
        >
          <ClipboardPaste className="w-3 h-3" />
          Recall ID
        </button>
      </div>

      <div className="flex flex-col justify-end">
        <button
          onClick={addToQueue}
          disabled={isButtonDisabled}
          title={isButtonDisabled ? submitLabel : "Ajouter à la file"}
          type="button"
          className={`
            relative h-[48px] px-8 font-black uppercase tracking-tight transition-all duration-300
            flex items-center justify-center gap-2 overflow-hidden
            ${isAdventurer ? "rounded-full" : "rounded-xl"}
            ${
              isButtonDisabled
                ? "bg-white/5 text-white/20 border border-white/5 cursor-not-allowed"
                : rainbow
                ? "theme-active-button rainbow-cycle hover:scale-[1.02] active:scale-95"
                : "theme-active-button text-white shadow-[0_0_15px_rgba(255,255,255,0.1)] hover:scale-[1.02] active:scale-95"
            }
            ${isAdventurer ? "font-semibold italic" : "font-mono italic"}
          `}
        >
          {busy === "play" ? (
            <>
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span>{submitLabel}</span>
            </>
          ) : (
            <>
              <PlusCircle size={18} />
              <span>{submitLabel}</span>
            </>
          )}

          {!isButtonDisabled && (
            <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 hover:opacity-100 transition-opacity pointer-events-none" />
          )}
        </button>

        <div className="h-[30px] hidden lg:block" />
      </div>
    </div>
  );
}
