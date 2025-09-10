import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type Control = { paused?: boolean; volume?: number; skipSeq?: number };
export type Now = { url?: string; title?: string; addedBy?: string; startedAt?: number | null };
export type QueueItem = { id: string; url: string; addedBy?: string; status: "queued"|"playing"|"done"|"error"; createdAt?: number };
export type QueueState = { ok: boolean; now: Now | null; queue: QueueItem[]; control: Control | null };

const SERVER_URL = import.meta.env.VITE_SERVER_URL || ""; // vide => même origine

export default function useLiveQueue() {
  const [state, setState] = useState<QueueState>({ ok: true, now: null, queue: [], control: { paused: false, volume: 80, skipSeq: 0 } });
  const [toast, setToast] = useState("");
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const url = SERVER_URL || undefined; // même origin si vide
    const s = io(url, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => setToast("Connecté ✅"));
    s.on("disconnect", () => setToast("Déconnecté"));
    s.on("state", (payload: QueueState) => setState(payload));
    s.on("toast", (msg: string) => setToast(msg));

    return () => { s.close(); };
  }, []);

  const play = useCallback((url: string, addedBy?: string) => {
    socketRef.current?.emit("play", { url, addedBy });
  }, []);

  const command = useCallback((cmd: "pause"|"resume"|"skip"|"volume", arg?: number, adminPass?: string) => {
    socketRef.current?.emit("command", { cmd, arg, adminPass });
  }, []);

  const clear = useCallback((adminPass?: string) => {
    socketRef.current?.emit("clear", adminPass);
  }, []);

  return { state, toast, setToast, play, command, clear };
}
