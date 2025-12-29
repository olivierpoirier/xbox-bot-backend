import { useEffect, useState } from "react";

interface Props {
  message: string;
  clear: () => void;
  rainbow?: boolean;
}

export default function Toast({ message, clear, rainbow }: Props) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 4000);
    return () => window.clearTimeout(id);
  }, [message]);

  useEffect(() => {
    if (!visible) {
      const id = window.setTimeout(() => clear(), 300);
      return () => window.clearTimeout(id);
    }
  }, [visible, clear]);

  // Classes de base : On force le placement à droite avec right-4
  const baseClasses = `
    fixed top-24 right-4 z-[999]
    max-w-sm px-6 py-3 rounded-xl
    text-sm font-mono font-bold shadow-2xl transition-all duration-300
    pointer-events-auto select-none
  `;

  const visibleClasses = visible
    ? "opacity-100 translate-y-0 scale-100"
    : "opacity-0 -translate-y-4 scale-95";

  const themeClasses = rainbow
    ? "toast-rainbow"
    : "bg-bg text-ink border-2 border-border shadow-neon-dynamic";

  return (
    <>
      <div className={`${baseClasses} ${visibleClasses} ${themeClasses}`}>
        <span className="animate-glitch relative inline-block">
          {message}
        </span>
      </div>

      <style>
        {`
          @keyframes glitch {
            0% { clip-path: inset(0% 0% 0% 0%); transform: translate(0,0); }
            20% { clip-path: inset(10% 0 85% 0); transform: translate(-2px,-2px); }
            40% { clip-path: inset(85% 0 5% 0); transform: translate(2px,2px); }
            60% { clip-path: inset(10% 0 85% 0); transform: translate(-1px,1px); }
            80% { clip-path: inset(85% 0 5% 0); transform: translate(1px,-1px); }
            100% { clip-path: inset(0% 0% 0% 0%); transform: translate(0,0); }
          }

          .animate-glitch {
            animation: glitch 1.5s infinite;
            text-shadow: 2px 0 10px currentColor;
          }

          .shadow-neon-dynamic {
             box-shadow: 0 0 15px var(--border);
          }

          /* CORRECTION ICI : Pas de position relative/absolute qui casse le fixed right-4 */
          .toast-rainbow {
            background: #0f111a !important;
            color: white !important;
            border: none !important;
            overflow: hidden; /* Pour que le pseudo-élément ne dépasse pas */
          }

          /* La bordure rainbow se fait via un pseudo-élément en absolute */
          .toast-rainbow::before {
            content: '';
            position: absolute;
            inset: 0;
            padding: 2px; /* épaisseur de la bordure */
            border-radius: inherit;
            background: linear-gradient(90deg, #f472b6, #a78bfa, #06b6d4);
            -webkit-mask:
              linear-gradient(#fff 0 0) content-box,
              linear-gradient(#fff 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            pointer-events: none;
          }
        `}
      </style>
    </>
  );
}