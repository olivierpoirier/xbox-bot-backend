interface Props {
  paused: boolean;
  busy: string | null;
  sendCommand: (cmd: "pause" | "resume" | "skip") => void;
  clearQueue: () => void;
}

export default function StickyControls({ paused, busy, sendCommand, clearQueue }: Props) {
  return (
    <div className="fixed bottom-0 left-0 right-0 grid grid-cols-3 gap-2 p-3 bg-[rgba(11,18,32,0.95)] md:hidden">
      <button
        disabled={!!busy}
        onClick={() => sendCommand(paused ? "resume" : "pause")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
      >
        {paused ? "▶" : "⏸"}
      </button>
      <button
        disabled={!!busy}
        onClick={() => sendCommand("skip")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
      >
        ⏭
      </button>
      <button
        disabled={!!busy}
        onClick={clearQueue}
        className="px-3 py-2 bg-red-500 rounded-xl text-white"
      >
        🗑
      </button>
    </div>
  );
}
