import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { QueueResponse, Command } from "../types";

// On définit l'état "occupé" pour l'UI
type BusyState = Command | "play" | "clear" | "reorder_queue" | "remove_queue_item" | null;

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";
const BUSY_TIMEOUT = 8_000;

export default function useLiveQueue() {
  const [state, setState] = useState<QueueResponse>({
    ok: true,
    now: null,
    queue: [],
    control: { paused: false, skipSeq: 0, repeat: false },
  });

  const [toast, setToast] = useState("");
  const [busy, setBusyState] = useState<BusyState>(null);
  const socketRef = useRef<Socket | null>(null);
  const busyTimerRef = useRef<number | null>(null);

  // Tick pour forcer le rafraîchissement du timer de lecture
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const clearBusy = useCallback(() => {
    setBusyState(null);
    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const setBusy = useCallback((value: BusyState) => {
    setBusyState(value);
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    busyTimerRef.current = window.setTimeout(() => {
      setBusyState(null);
    }, BUSY_TIMEOUT);
  }, []);

  useEffect(() => {
    const s = io(SERVER_URL || undefined, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("state", (payload: QueueResponse) => {
      setState(payload);
      clearBusy();
    });

    s.on("toast", (msg: string) => {
      setToast(msg);
      // Force la suppression du toast côté état après 4.5s 
      // (un peu après l'animation de 4s du composant)
      setTimeout(() => setToast(""), 4500);
    });
    s.on("connect", () => {
      setToast("🔗 Connecté au serveur");
      setTimeout(() => setToast(""), 4500);
    });
    s.on("disconnect", () => {
      setToast("⚡ Connexion perdue");
      clearBusy();
    });

    return () => { s.close(); };
  }, [clearBusy]);

  const emitSafe = useCallback((event: string, payload?: unknown, busyKey?: BusyState) => {
    if (!socketRef.current?.connected) {
      setToast("❌ Erreur : Serveur hors ligne");
      return;
    }
    if (busyKey) setBusy(busyKey);
    socketRef.current.emit(event, payload);
  }, [setBusy]);

  const play = (url: string, addedBy?: string) => emitSafe("play", { url, addedBy }, "play");
  const command = (cmd: Command, arg?: number) => emitSafe("command", { cmd, arg }, cmd);
  const clear = () => emitSafe("clear", undefined, "clear");
  const reorderQueue = (ids: string[]) => emitSafe("reorder_queue", { ids }, "reorder_queue");
  const removeQueueItem = (id: string) => emitSafe("remove_queue_item", { id }, "remove_queue_item");

  return { 
    state, 
    toast, 
    setToast, 
    play, 
    command, 
    busy, 
    setBusy, // Maintenant disponible pour App.tsx
    clear, 
    reorderQueue, 
    removeQueueItem 
  };
}