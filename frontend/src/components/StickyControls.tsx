import { Play, Pause, SkipForward, ChevronsRight, Shuffle, Repeat, Trash2 } from "lucide-react";

type Command = "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat";

interface Props {
  paused: boolean;
  repeat: boolean;
  busy: string | null;
  sendCommand: (cmd: Command, arg?: number) => void;
  clearQueue: () => void;
}

export default function StickyControls({
  paused,
  repeat,
  busy,
  sendCommand,
  clearQueue,
}: Props) {
  const isBusy = Boolean(busy);

  return (
    <div className="fixed bottom-0 left-0 right-0 grid grid-cols-6 gap-2 p-3 bg-[rgba(11,18,32,0.95)] md:hidden">
      <button
        disabled={isBusy}
        onClick={() => sendCommand(paused ? "resume" : "pause")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
        title={paused ? "Reprendre" : "Pause"}
      >
        {paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
      </button>

      <button
        disabled={isBusy}
        onClick={() => sendCommand("skip")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
        title="Passer la piste"
      >
        <SkipForward className="w-5 h-5" />
      </button>

      <button
        disabled={isBusy}
        onClick={() => sendCommand("skip_group")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
        title="Passer toute la playlist en cours"
      >
        <ChevronsRight className="w-5 h-5" />
      </button>

      <button
        disabled={isBusy}
        onClick={() => sendCommand("shuffle")}
        className="px-3 py-2 bg-slate-800 rounded-xl text-white"
        title="Mélanger la file d’attente"
      >
        <Shuffle className="w-5 h-5" />
      </button>

      <button
        disabled={isBusy}
        onClick={() => sendCommand("repeat", repeat ? 0 : 1)}
        className={`px-3 py-2 rounded-xl ${
          repeat ? "bg-amber-600 text-black" : "bg-slate-800 text-white"
        }`}
        title="Répéter la piste en cours"
      >
        <Repeat className="w-5 h-5" />
      </button>

      <button
        disabled={isBusy}
        onClick={clearQueue}
        className="px-3 py-2 bg-red-500 rounded-xl text-white"
        title="Vider la file"
      >
        <Trash2 className="w-5 h-5" />
      </button>
    </div>
  );
}
