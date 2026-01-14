// src/types.ts
import { ChildProcess } from "child_process";
import net from "net";

/* ------------------- MPV TYPES ------------------- */

export type MpvEvent =
  | { type: "file-loaded" }
  | { type: "playback-restart" }
  | { type: "property-change"; name: string; data: unknown };

export type MpvHandle = {
  proc: ChildProcess;
  sock: net.Socket;
  send: (cmd: unknown) => Promise<void>;
  kill: () => void;
  on: (fn: (ev: MpvEvent) => void) => () => void;
  waitForPlaybackStart: (timeoutMs?: number) => Promise<void>;
};

/* ------------------- STATE TYPES ------------------- */

export type Control = { paused: boolean; skipSeq: number; repeat: boolean };

export type Now = {
  url?: string;
  title?: string;
  thumb?: string | null;
  addedBy?: string;
  startedAt?: number | null;
  group?: string;
  durationSec?: number | null;
  positionOffsetSec?: number;
  isBuffering: boolean;
};

export type QueueItem = {
  id: string;
  url: string;
  title?: string;
  thumb: string | null; // Déjà bon ou mis à jour
  group?: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error";
  createdAt: number;
  durationSec?: number;
};

export interface GlobalState {
  control: Control;
  now: Now | null;
  queue: QueueItem[];
}

/* ------------------- STATE INSTANCE ------------------- */

export const state: GlobalState = {
  control: { paused: false, skipSeq: 0, repeat: false },
  now: null,
  queue: [],
};

export let playing: { item: QueueItem; handle: MpvHandle } | null = null;
export const setPlaying = (val: typeof playing) => { playing = val; };

export let nextId = { current: 1 };

export type ResolvedItem = {
  url: string;
  title: string;
  thumb?: string | null; 
  durationSec: number;
};

export type ProbeResult = {
  title: string;
  thumb?: string | null;
  durationSec: number;
};