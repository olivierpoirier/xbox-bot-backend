import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import {
  startMpv,
  mpvPause,
  mpvQuit,
  mpvSetLoopFile,
  mpvSeekAbsolute,
  mpvSeekRelative,
  type MpvHandle,
} from "./mpv";
import path from "node:path";
import { resolveUrlToPlayableItems, probeSingle } from "./ytdlp";

const PORT = Number(process.env.PORT || 4000);
const ADMIN_PASS = (process.env.ADMIN_PASS || "").trim();

const app = express();
app.use(express.json());
app.use(cors());

const publicDir = path.resolve(process.cwd(), "../xbox-music-ui/dist");
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*" } });

type Control = { paused: boolean; volume: number; skipSeq: number; repeat: boolean };
type Now = {
  url?: string;
  title?: string;
  thumb?: string;
  addedBy?: string;
  startedAt?: number | null;
  group?: string;
  durationSec?: number;
  positionOffsetSec?: number;
};
type QueueItem = {
  id: string;
  url: string;
  title?: string;
  thumb?: string;
  group?: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error";
  createdAt: number;
};

const state = {
  control: { paused: false, volume: 100, skipSeq: 0, repeat: false } as Control,
  now: null as Now | null,
  queue: [] as QueueItem[],
};

let playing: { item: QueueItem; handle: MpvHandle } | null = null;
let nextId = 1;

/* ---------- Helpers progression ---------- */
function computePosition(now: Now, atMs = Date.now()): number {
  const base = now.positionOffsetSec || 0;
  if (now.startedAt == null) return base;
  return base + Math.max(0, (atMs - now.startedAt) / 1000);
}

/* ---------- Broadcast batching & dedup ---------- */
let broadcastTimer: NodeJS.Timeout | null = null;
let lastHash = "";

function computeHash(payload: unknown): string {
  try {
    return JSON.stringify(payload, (_k, v) =>
      v && typeof v === "object"
        ? ("status" in v && "id" in v ? { id: (v as any).id, status: (v as any).status } : v)
        : v
    );
  } catch {
    return String(Math.random());
  }
}

function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;

    const queued = state.queue.filter((q) => q.status === "queued");
    const payload = { ok: true, now: state.now, queue: queued, control: state.control };

    const h = computeHash({
      now: state.now,
      control: state.control,
      queueMin: queued.map((q) => [q.id, q.status]),
    });
    if (h === lastHash) return;
    lastHash = h;
    io.emit("state", payload);
  }, 20);
}

function pushToast(msg: string): void {
  io.emit("toast", msg);
}

function checkAdmin(pass?: string): boolean {
  if (!ADMIN_PASS) return true;
  return (pass || "") === ADMIN_PASS;
}

function shuffleQueuedInPlace(): void {
  const queuedIdx: number[] = [];
  for (let i = 0; i < state.queue.length; i++) {
    if (state.queue[i].status === "queued") queuedIdx.push(i);
  }
  for (let k = queuedIdx.length - 1; k > 0; k--) {
    const a = queuedIdx[k];
    const b = queuedIdx[Math.floor(Math.random() * (k + 1))];
    [state.queue[a], state.queue[b]] = [state.queue[b], state.queue[a]];
  }
}

/* ---------- Lecture/auto enchaînement ---------- */
async function ensurePlayerLoop(): Promise<void> {
  if (playing) return;

  const idx = state.queue.findIndex((q) => q.status === "queued");
  if (idx === -1) return;

  const item = state.queue[idx];
  item.status = "playing";

  try {
    const info = await probeSingle(item.url);
    item.title = item.title || info.title;
    item.thumb = item.thumb || info.thumb;

    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      startedAt: null,
      group: item.group,
      durationSec: info.durationSec,
      positionOffsetSec: 0,
    };
  } catch {
    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      startedAt: null,
      group: item.group,
      durationSec: undefined,
      positionOffsetSec: 0,
    };
  }
  scheduleBroadcast();

  try {
    const handle = await startMpv(item.url, 100);
    playing = { item, handle };

    await mpvPause(handle, state.control.paused).catch(() => {});
    await mpvSetLoopFile(handle, state.control.repeat).catch(() => {});

    state.now = { ...(state.now as Now), startedAt: Date.now(), positionOffsetSec: 0 };
    scheduleBroadcast();

    /* Log console : début de piste */
    logNowPlaying();

    handle.proc.once("exit", () => {
      item.status = "done";
      state.now = null;
      playing = null;
      clearStatusLine();
      scheduleBroadcast();
      setTimeout(() => { void ensurePlayerLoop(); }, 120);
    });
  } catch {
    item.status = "error";
    state.now = null;
    playing = null;
    clearStatusLine();
    scheduleBroadcast();
    setTimeout(() => { void ensurePlayerLoop(); }, 600);
  }
}

/* ---------- Ticker de progression (événement 'progress') + console ---------- */
const TICK_MS = Math.max(250, Number(process.env.PROGRESS_TICK_MS || 1000));
const WANT_CONSOLE = process.env.PROGRESS_LOG === "1";

let lastProgressKey = "";
let lastStatusPrinted = "";

setInterval(() => {
  const now = state.now;
  if (!now) return;

  const pos = computePosition(now);
  const dur = now.durationSec ?? null;

  // emet côté clients (utile si tu l'utilises)
  const key = `${Math.floor(pos)}|${state.control.paused ? 1 : 0}|${dur ?? -1}`;
  if (key !== lastProgressKey) {
    lastProgressKey = key;
    io.emit("progress", {
      positionSec: pos,
      durationSec: dur,
      paused: state.control.paused,
      repeat: state.control.repeat,
      title: now.title,
      url: now.url,
    });
  }

  // Affichage console (si activé)
  if (WANT_CONSOLE) {
    const line = renderStatusLine({
      paused: state.control.paused,
      repeat: state.control.repeat,
      pos,
      dur,
      title: now.title || "(sans titre)",
    });
    if (line !== lastStatusPrinted) {
      lastStatusPrinted = line;
      writeStatusLine(line);
    }
  }
}, TICK_MS);

/* ---------------- Socket handlers ---------------- */
io.on("connection", (socket) => {
  socket.emit("state", {
    ok: true,
    now: state.now,
    queue: state.queue.filter((q) => q.status === "queued"),
    control: state.control,
  });

  if (state.now) {
    socket.emit("progress", {
      positionSec: computePosition(state.now),
      durationSec: state.now.durationSec ?? null,
      paused: state.control.paused,
      repeat: state.control.repeat,
      title: state.now.title,
      url: state.now.url,
    });
  }

  socket.on("play", async (payload: { url?: string; addedBy?: string }) => {
    const raw = String(payload?.url || "").trim();
    if (!/^https?:\/\//i.test(raw)) return socket.emit("toast", "URL invalide");

    try {
      const items = await resolveUrlToPlayableItems(raw);
      if (!items.length) {
        return socket.emit("toast", "Aucune piste jouable (supprimée/bloquée ?).");
      }

      const group =
        items.length > 1 ? `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` : undefined;

      const addedBy = (payload.addedBy || "anon").slice(0, 64);
      const nowTs = Date.now();

      for (const it of items) {
        state.queue.push({
          id: String(nextId++),
          url: it.url,
          title: it.title,
          thumb: it.thumb,
          group,
          addedBy,
          status: "queued",
          createdAt: nowTs,
        });
      }

      if (items.length > 1) {
        pushToast(`Playlist ajoutée: ${items.length} pistes valides ✅`);
      }
      scheduleBroadcast();
      void ensurePlayerLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "yt-dlp";
      socket.emit("toast", `Erreur d’analyse: ${msg}`);
    }
  });

  socket.on("command", async (payload: {
    cmd: "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat" | "seek" | "seek_abs";
    arg?: number;
    adminPass?: string;
  }) => {
    if (!checkAdmin(payload?.adminPass)) return socket.emit("toast", "Forbidden (admin)");

    const now = state.now;

    switch (payload.cmd) {
      case "pause": {
        state.control.paused = true;
        if (now?.startedAt != null) {
          const elapsed = (Date.now() - now.startedAt) / 1000;
          state.now = { ...now, startedAt: null, positionOffsetSec: (now.positionOffsetSec || 0) + elapsed };
        }
        break;
      }
      case "resume": {
        state.control.paused = false;
        if (now) state.now = { ...now, startedAt: Date.now() };
        break;
      }
      case "skip": {
        state.control.skipSeq++;
        break;
      }
      case "skip_group": {
        state.control.skipSeq++;
        break;
      }
      case "repeat": {
        state.control.repeat = !!Number(payload.arg ?? (state.control.repeat ? 0 : 1));
        break;
      }
      case "shuffle": {
        const before = state.queue.filter((q) => q.status === "queued").length;
        if (before > 1) {
          shuffleQueuedInPlace();
          pushToast(`🔀 Mélangé (${before})`);
        }
        break;
      }
      case "seek": {
        if (typeof payload.arg === "number") {
          if (playing?.handle) {
            await mpvSeekRelative(playing.handle, payload.arg).catch(() => {});
          }
          if (now) {
            const base = (now.positionOffsetSec || 0) + (now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0);
            const dur = now.durationSec ?? Number.POSITIVE_INFINITY;
            const next = Math.max(0, Math.min(dur, base + payload.arg));
            state.now = { ...now, positionOffsetSec: next, startedAt: now.startedAt ? Date.now() : null };
          }
        }
        break;
      }
      case "seek_abs": {
        if (typeof payload.arg === "number") {
          const target = Math.max(0, payload.arg);
          if (playing?.handle) {
            await mpvSeekAbsolute(playing.handle, target).catch(() => {});
          }
          if (now) {
            const dur = now.durationSec ?? Number.POSITIVE_INFINITY;
            const clamped = Math.max(0, Math.min(dur, target));
            state.now = { ...now, positionOffsetSec: clamped, startedAt: now.startedAt ? Date.now() : null };
          }
        }
        break;
      }
    }

    if (playing?.handle) {
      if (payload.cmd === "pause" || payload.cmd === "resume") {
        await mpvPause(playing.handle, state.control.paused).catch(() => {});
      }
      if (payload.cmd === "repeat") {
        await mpvSetLoopFile(playing.handle, state.control.repeat).catch(() => {});
      }
      if (payload.cmd === "skip") {
        await mpvQuit(playing.handle).catch(() => {});
      }
      if (payload.cmd === "skip_group") {
        const g = playing.item.group;
        if (g) {
          for (const q of state.queue) {
            if (q.status === "queued" && q.group === g) q.status = "done";
          }
        }
        await mpvQuit(playing.handle).catch(() => {});
      }
    }

    scheduleBroadcast();

    // petits logs utiles
    if (WANT_CONSOLE) {
      if (payload.cmd === "pause") console.log("\n⏸ pause");
      if (payload.cmd === "resume") console.log("\n▶ reprise");
      if (payload.cmd === "shuffle") console.log("\n🔀 shuffle");
      if (payload.cmd === "repeat") console.log(`\n🔁 repeat: ${state.control.repeat ? "on" : "off"}`);
      if (payload.cmd === "skip") console.log("\n⏭ skip");
      if (payload.cmd === "seek" || payload.cmd === "seek_abs") {
        clearStatusLine(); // force la ligne à se recalculer proprement
        lastStatusPrinted = "";
      }
    }
  });

  socket.on("clear", async (adminPass?: string) => {
    if (!checkAdmin(adminPass)) return socket.emit("toast", "Forbidden (admin)");
    if (playing?.handle) await mpvQuit(playing.handle).catch(() => {});
    for (const q of state.queue) {
      if (q.status === "queued" || q.status === "playing") q.status = "done";
    }
    state.now = null;
    clearStatusLine();
    scheduleBroadcast();
  });
});

/* ----------- Debug minimal (optionnel) ----------- */
app.get("/now", (_req, res) => {
  if (!state.now) return res.json({ ok: true, now: null });
  const pos = computePosition(state.now);
  res.json({
    ok: true,
    now: { ...state.now, positionSec: pos, paused: state.control.paused, repeat: state.control.repeat },
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`🎧 Music bot on http://localhost:${PORT}`);
});

/* ================= Console status helpers ================= */
function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString()}:${r.toString().padStart(2, "0")}`;
}
function renderStatusLine(opts: { paused: boolean; repeat: boolean; pos: number; dur: number | null; title: string }) {
  const icon = opts.paused ? "⏸" : "▶";
  const rep = opts.repeat ? "R:on" : "R:off";
  const left = `${icon} ${fmtTime(opts.pos)} / ${fmtTime(opts.dur)} | ${rep} | `;
  const termW = process.stdout.columns || 120;
  const maxTitle = Math.max(10, termW - left.length - 1);
  let t = opts.title.replace(/\s+/g, " ").trim();
  if (t.length > maxTitle) t = t.slice(0, Math.max(0, maxTitle - 1)) + "…";
  return left + `"${t}"`;
}
function writeStatusLine(line: string) {
  // efface ligne puis écrit (Windows/Unix ok)
  process.stdout.write("\r" + line.padEnd(process.stdout.columns || line.length));
}
function clearStatusLine() {
  if (!lastStatusPrinted) return;
  process.stdout.write("\r" + " ".repeat(process.stdout.columns || lastStatusPrinted.length) + "\r");
  lastStatusPrinted = "";
}
function logNowPlaying() {
  if (!state.now) return;
  clearStatusLine();
  console.log(`🎵 Now playing: ${state.now.title || "(sans titre)"} ${state.now.durationSec ? "— " + fmtTime(state.now.durationSec) : ""}`);
}
