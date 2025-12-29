import { Rainbow, Palette } from "lucide-react";
import AppIcon from "../assets/Icon.png";
import type { ThemeName } from "../lib/themes";

type Props = {
  theme: ThemeName;
  rainbow: boolean;
  onPickRainbow: () => void;
  onNextColor: () => void;
};

export default function AppHeader({
  rainbow,
  onPickRainbow,
  onNextColor,
}: Props) {
  return (
    <header
      className="
        sticky top-0 z-40
        backdrop-blur-md
        bg-bg/80
        border-b border-border
      "
    >
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
        {/* Logo + titre */}
        <div className="flex items-center gap-3">
          <img
            src={AppIcon}
            alt="Logo"
            className="w-9 h-9 rounded-md object-contain"
          />
          {/* Titre visible uniquement sur md+ */}
          <span className="font-semibold text-lg tracking-tight hidden md:inline">
            Music Player
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onPickRainbow}
            aria-pressed={rainbow}
            title="Mode Rainbow"
            className={`
              inline-flex items-center gap-1.5
              px-3 py-1.5 rounded-lg border
              text-sm font-medium
              transition
              ${rainbow ? "bg-pink-600 text-white border-pink-400" : "bg-bg border-border hover:bg-bg/60"}
            `}
          >
            <Rainbow className="w-4 h-4" />
            Rainbow
          </button>

          <button
            onClick={onNextColor}
            title="Changer de couleur"
            className="
              inline-flex items-center gap-1.5
              px-3 py-1.5 rounded-lg border
              text-sm font-medium
              bg-bg border-border hover:bg-bg/60
              transition
            "
          >
            <Palette className="w-4 h-4" />
            Couleur
          </button>
        </div>
      </div>
    </header>
  );
}
