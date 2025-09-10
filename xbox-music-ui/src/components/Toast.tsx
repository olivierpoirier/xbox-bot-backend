interface Props {
  message: string;
  clear: () => void;
}

export default function Toast({ message, clear }: Props) {
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-emerald-500 text-emerald-950 border border-emerald-900 px-3.5 py-2 rounded-xl shadow-xl animate-fadeOut"
      onAnimationEnd={clear}
    >
      {message}
    </div>
  );
}
