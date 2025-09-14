export type Control = {
  paused?: boolean;
  volume?: number;     // restera toujours 100 côté serveur
  skipSeq?: number;
  repeat?: boolean;
};

export type Now = {
  url?: string;
  title?: string;
  thumb?: string;
  addedBy?: string;
  startedAt?: number | null;   // ms epoch quand “playing” (null si pause)
  group?: string;
  durationSec?: number;        // NEW
  positionOffsetSec?: number;  // NEW: base pour calculer la position actuelle
};

export type QueueItem = {
  id: string;
  url: string;
  title?: string;
  thumb?: string;
  group?: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error";
  createdAt?: number;
};

export type QueueResponse = {
  ok: boolean;
  now: Now | null;
  queue: QueueItem[];
  control: Control | null;
};
