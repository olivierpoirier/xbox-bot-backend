import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { QueueResponse } from "../types";

export type Command =
  | "pause"
  | "resume"
  | "skip"
  | "skip_group"
  | "shuffle"
  | "repeat"
  | "seek"
  | "seek_abs";

export type QueueState = QueueResponse;

type BusyState =
  | Command
  | "play"
  | "clear"
  | "reorder_queue"
  | "remove_queue_item"
  | null;

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";
const BUSY_TIMEOUT = 5_000;

export default function useLiveQueue() {
  const [state, setState] = useState<QueueState>({
    ok: true,
    now: null,
    queue: [],
    control: { paused: false, skipSeq: 0, repeat: false },
  });

  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState<BusyState>(null);

  const socketRef = useRef<Socket | null>(null);
  const busyTimerRef = useRef<number | null>(null);

  // Tick UI
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const startBusy = (value: BusyState) => {
    setBusy(value);
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);

    busyTimerRef.current = window.setTimeout(() => {
      setBusy(null);
      setToast("⚠️ Serveur non disponible.");
    }, BUSY_TIMEOUT);
  };

  const clearBusy = () => {
    setBusy(null);
    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  };

  useEffect(() => {
    const s = io(SERVER_URL || undefined, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setToast("🔗 Connexion établie");
      console.log("[socket] connect", s.id);
    });

    s.on("disconnect", (reason) => {
      setToast("⚡ Déconnecté du serveur");
      clearBusy();
      console.warn("[socket] disconnect:", reason);
    });

    s.on("connect_error", (err) => {
      setToast("❌ Erreur de connexion");
      clearBusy();
      console.error("[socket] connect_error:", err);
    });

    s.on("state", (payload: QueueState) => {
      setState(payload);
      clearBusy();
    });

    s.on("toast", (msg: string) => {
      setToast(`💬 ${msg}`);
      console.log("[socket] toast:", msg);
    });

    // ✅ ici on ferme le socket correctement
    return () => {
      s.close();
    };
  }, []);


  const emitSafe = useCallback(
    (event: string, payload?: unknown, busyKey?: BusyState) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        setToast("❌ Pas connecté au serveur");
        return;
      }
      if (busyKey) startBusy(busyKey);
      socket.emit(event, payload);
      console.log(`[emit] ${event}`, payload);
    },
    []
  );

  const play = useCallback((url: string, addedBy?: string) => {
    emitSafe("play", { url, addedBy }, "play");
  }, [emitSafe]);

  const command = useCallback((cmd: Command, arg?: number) => {
    emitSafe("command", { cmd, arg }, cmd);
  }, [emitSafe]);

  const clear = useCallback(() => emitSafe("clear", undefined, "clear"), [emitSafe]);

  const reorderQueue = useCallback((ids: string[]) => emitSafe("reorder_queue", { ids }, "reorder_queue"), [emitSafe]);

  const removeQueueItem = useCallback((id: string) => emitSafe("remove_queue_item", { id }, "remove_queue_item"), [emitSafe]);

  return { state, toast, setToast, play, command, clear, reorderQueue, removeQueueItem, busy, setBusy };
}
