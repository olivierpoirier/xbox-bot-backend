export type Control = { paused?: boolean; volume?: number; skipSeq?: number };
export type Now = { url?: string; title?: string; addedBy?: string; startedAt?: unknown };
export type QueueItem = {
  id: string;
  url: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error";
  createdAt?: unknown;
};
export type QueueResponse = {
  ok: boolean;
  now: Now | null;
  queue: QueueItem[];
  control: Control | null;
};
