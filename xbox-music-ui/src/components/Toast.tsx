import { useEffect } from "react";

interface Props {
  message: string;
  clear: () => void;
}

export default function Toast({ message, clear }: Props) {
  useEffect(() => {
    // Auto-hide après 4 secondes
    const id = window.setTimeout(() => {
      clear();
    }, 4000);

    return () => window.clearTimeout(id);
  }, [message, clear]);

  return (
    <div
      className="
        fixed top-4 right-4
        max-w-sm
        bg-emerald-500 text-emerald-950
        border border-emerald-900
        px-3.5 py-2 rounded-xl shadow-xl
        animate-fadeOut
      "
      onAnimationEnd={clear}
    >
      {message}
    </div>
  );
}
