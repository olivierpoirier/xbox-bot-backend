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
  control: { paused: false, volume: 100, skipSeq: 0, repeat: false } as Control, // volume 100 fixé
  now: null as Now | null,
  queue: [] as QueueItem[],
};

let playing: { item: QueueItem; handle: MpvHandle } | null = null;
let nextId = 1;

function broadcast(): void {
  io.emit("state", {
    ok: true,
    now: state.now,
    queue: state.queue.filter((q) => q.status === "queued"),
    control: state.control,
  });
}

function checkAdmin(pass?: string): boolean {
  if (!ADMIN_PASS) return true;
  return (pass || "") === ADMIN_PASS;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function ensurePlayerLoop(): Promise<void> {
  if (playing) return;

  const idx = state.queue.findIndex((q) => q.status === "queued");
  if (idx === -1) return;

  const item = state.queue[idx];
  item.status = "playing";

  // --- Enrichissement: on PROBE TOUJOURS pour récupérer la durée ---
  try {
    const info = await probeSingle(item.url);
    // complète titre/thumb si absents
    item.title = item.title || info.title;
    item.thumb = item.thumb || info.thumb;

    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      startedAt: null,            // sera défini juste après le spawn
      group: item.group,
      durationSec: info.durationSec, // ✅ durée si dispo
      positionOffsetSec: 0,
    };
  } catch {
    // Pas de métadonnées: on avance sans durée (le slider restera en "chargement")
    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      startedAt: null,
      group: item.group,
      durationSec: undefined,      // ❌ pas de slider ; boutons ±15s OK
      positionOffsetSec: 0,
    };
  }

  // Un seul broadcast ici suffit
  broadcast();

  try {
    const handle = await startMpv(item.url, 100); // volume forcé à 100%
    playing = { item, handle };

    // appliquer état initial
    await mpvPause(handle, state.control.paused).catch(() => {});
    await mpvSetLoopFile(handle, state.control.repeat).catch(() => {});

    // démarrage logique (horloge locale)
    state.now = { ...(state.now as Now), startedAt: Date.now(), positionOffsetSec: 0 };
    broadcast();

    handle.proc.once("exit", () => {
      item.status = "done";
      state.now = null;
      playing = null;
      broadcast();
      setTimeout(() => { void ensurePlayerLoop(); }, 150);
    });
  } catch {
    item.status = "error";
    state.now = null;
    playing = null;
    broadcast();
    setTimeout(() => { void ensurePlayerLoop(); }, 1000);
  }
}

/* ---------------- Socket handlers ---------------- */
io.on("connection", (socket) => {
  socket.emit("state", {
    ok: true,
    now: state.now,
    queue: state.queue.filter((q) => q.status === "queued"),
    control: state.control,
  });

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

      for (const it of items) {
        state.queue.push({
          id: String(nextId++),
          url: it.url,
          title: it.title,
          thumb: it.thumb,
          group,
          addedBy: (payload.addedBy || "anon").slice(0, 64),
          status: "queued",
          createdAt: Date.now(),
        });
      }

      if (items.length > 1) {
        io.emit("toast", `Playlist ajoutée: ${items.length} pistes valides ✅`);
      }
      broadcast();
      void ensurePlayerLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "yt-dlp";
      socket.emit("toast", `Erreur d’analyse: ${msg}`);
    }
  });

  // Commandes: pause/resume/skip/skip_group/shuffle/repeat/seek/seek_abs
  socket.on("command", async (payload: {
    cmd: "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat" | "seek" | "seek_abs";
    arg?: number;        // repeat(0/1), seek delta en secondes, seek_abs = seconde absolue
    adminPass?: string;
  }) => {
    if (!checkAdmin(payload?.adminPass)) return socket.emit("toast", "Forbidden (admin)");

    const now = state.now;

    if (payload.cmd === "pause") {
      state.control.paused = true;
      // geler le temps logique
      if (now?.startedAt != null) {
        const elapsed = (Date.now() - now.startedAt) / 1000;
        state.now = { ...now, startedAt: null, positionOffsetSec: (now.positionOffsetSec || 0) + elapsed };
      }
    } else if (payload.cmd === "resume") {
      state.control.paused = false;
      // repartir le chrono logique
      if (now) state.now = { ...now, startedAt: Date.now() };
    } else if (payload.cmd === "skip") {
      state.control.skipSeq++;
    } else if (payload.cmd === "skip_group") {
      state.control.skipSeq++;
    } else if (payload.cmd === "repeat") {
      state.control.repeat = !!Number(payload.arg ?? (state.control.repeat ? 0 : 1));
    } else if (payload.cmd === "shuffle") {
      const queued = state.queue.filter((q) => q.status === "queued");
      if (queued.length > 1) {
        shuffleInPlace(queued);
        const others = state.queue.filter((q) => q.status !== "queued");
        state.queue = [...others, ...queued];
        io.emit("toast", `🔀 Mélangé (${queued.length})`);
      }
    } else if (payload.cmd === "seek" && typeof payload.arg === "number") {
      if (playing?.handle) {
        await mpvSeekRelative(playing.handle, payload.arg).catch(() => {});
      }
      // Ajustement logique
      if (now) {
        const base = (now.positionOffsetSec || 0) + (now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0);
        const dur = now.durationSec ?? Number.POSITIVE_INFINITY;
        const next = Math.max(0, Math.min(dur, base + payload.arg));
        state.now = {
          ...now,
          positionOffsetSec: next,
          startedAt: now.startedAt ? Date.now() : null,
        };
      }
    } else if (payload.cmd === "seek_abs" && typeof payload.arg === "number") {
      const target = Math.max(0, payload.arg);
      if (playing?.handle) {
        await mpvSeekAbsolute(playing.handle, target).catch(() => {});
      }
      if (now) {
        const dur = now.durationSec ?? Number.POSITIVE_INFINITY;
        const clamped = Math.max(0, Math.min(dur, target));
        state.now = {
          ...now,
          positionOffsetSec: clamped,
          startedAt: now.startedAt ? Date.now() : null,
        };
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
          state.queue.forEach((q) => {
            if (q.status === "queued" && q.group === g) q.status = "done";
          });
        }
        await mpvQuit(playing.handle).catch(() => {});
      }
    }

    broadcast();
  });

  socket.on("clear", async (adminPass?: string) => {
    if (!checkAdmin(adminPass)) return socket.emit("toast", "Forbidden (admin)");
    if (playing?.handle) await mpvQuit(playing.handle).catch(() => {});
    state.queue.forEach((q) => {
      if (q.status === "queued" || q.status === "playing") q.status = "done";
    });
    state.now = null;
    broadcast();
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`🎧 Music bot on http://localhost:${PORT}`);
});
