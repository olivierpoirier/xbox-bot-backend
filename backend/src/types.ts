// types.ts
import { MpvHandle } from "./mpv";

export type Control = { paused: boolean; skipSeq: number; repeat: boolean };

export type Now = {
  url?: string;
  title?: string;
  thumb?: string;
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
  thumb?: string;
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

export const state: GlobalState = {
  control: { paused: false, skipSeq: 0, repeat: false },
  now: null,
  queue: [],
};

export let playing: { item: QueueItem; handle: MpvHandle } | null = null;
export const setPlaying = (val: typeof playing) => { playing = val; };

export let nextId = { current: 1 };