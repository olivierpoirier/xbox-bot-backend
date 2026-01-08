import { useEffect, useState } from "react";

interface Props {
  message: string;
  clear: () => void;
  rainbow?: boolean;
}

export default function Toast({ message, clear, rainbow }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        // On attend la fin de l'animation CSS (300ms) pour supprimer le message
        setTimeout(clear, 300);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [message, clear]);

  if (!message) return null;

  const baseClasses = `
    fixed top-24 right-4 z-[9999]
    max-w-sm px-6 py-4 rounded-xl
    text-sm font-mono font-bold shadow-2xl transition-all duration-500
    pointer-events-auto select-none border-2
  `;

  const stateClasses = visible
    ? "opacity-100 translate-x-0 scale-100"
    : "opacity-0 translate-x-12 scale-90";

  const themeClasses = rainbow
    ? "bg-black text-white border-pink-500 shadow-[0_0_20px_rgba(236,72,153,0.4)]"
    : "bg-bg text-ink border-border shadow-lg";

  return (
    <div className={`${baseClasses} ${stateClasses} ${themeClasses}`}>
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full animate-ping ${rainbow ? 'bg-pink-500' : 'bg-current'}`} />
        <span className="uppercase tracking-tighter">
          {message}
        </span>
      </div>
      
      {/* Barre de progression de vie du toast */}
      <div className="absolute bottom-0 left-0 h-1 bg-current opacity-20 transition-all duration-[4000ms] ease-linear w-0" 
           style={{ width: visible ? '100%' : '0%' }} 
      />
    </div>
  );
}