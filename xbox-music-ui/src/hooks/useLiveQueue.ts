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

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

export default function useLiveQueue() {
  const [state, setState] = useState<QueueState>({
    ok: true,
    now: null,
    queue: [],
    control: { paused: false, skipSeq: 0, repeat: false },
  });
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Petit tick pour rafraîchir l’UI du temps local
  const [, setTick] = useState<number>(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const url = SERVER_URL || undefined;
      const s = io(url, { transports: ["websocket"] });
      socketRef.current = s;

      s.on("connect", () => {
        setToast("Connecté ✅");
        console.log("[socket] connect", { id: s.id });
      });
      s.on("disconnect", (reason) => {
        setToast("Déconnecté");
        console.warn("[socket] disconnect:", reason);
      });
      s.on("connect_error", (err) => {
        setToast("Erreur de connexion socket.");
        console.error("[socket] connect_error:", err);
      });
      s.on("error", (err: unknown) => {
        setToast("Erreur socket.");
        console.error("[socket] error:", err);
      });
      s.on("state", (payload: QueueState) => {
        setState(payload);
        setBusy(null); // annule un loader en cours
      });
      s.on("toast", (msg: string) => {
        setToast(msg);
        console.log("[socket] toast:", msg);
      });

      return () => {
        try {
          s.close();
        } catch (e) {
          console.error("[socket] close error:", e);
        }
      };
    } catch (e) {
      setToast("Impossible d’initialiser la connexion.");
      console.error("[socket] init error:", e);
    }
  }, []);

  const play = useCallback((url: string, addedBy?: string) => {
    try {
      setBusy("play");
      socketRef.current?.emit("play", { url, addedBy });
      console.log("[emit] play", { url, addedBy });
    } catch (e) {
      setBusy(null);
      setToast("Échec de l’envoi de la commande play.");
      console.error("[emit] play error:", e);
    }
  }, []);

  const command = useCallback((cmd: Command, arg?: number) => {
    try {
      setBusy(cmd);
      socketRef.current?.emit("command", { cmd, arg });
      console.log("[emit] command", { cmd, arg });
    } catch (e) {
      setBusy(null);
      setToast(`Échec de la commande: ${cmd}.`);
      console.error(`[emit] command ${cmd} error:`, e);
    }
  }, []);

  const clear = useCallback(() => {
    try {
      setBusy("clear");
      socketRef.current?.emit("clear");
      console.log("[emit] clear");
    } catch (e) {
      setBusy(null);
      setToast("Échec de clear.");
      console.error("[emit] clear error:", e);
    }
  }, []);

  return { state, toast, setToast, play, command, clear, busy, setBusy };
}
