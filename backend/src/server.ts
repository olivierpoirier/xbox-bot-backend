// server.ts
import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import path from "node:path";

import {
  startMpv,
  mpvPause,
  mpvQuit,
  mpvSetLoopFile,
  mpvSeekAbsolute,
  mpvSeekRelative,
  type MpvHandle,
} from "./mpv";
import {
  resolveUrlToPlayableItems,
  probeSingle,
  resolveQuick,
  normalizeUrl,
  type ResolvedItem,
} from "./ytdlp";
import { startSpan, pushMetrics, getMetrics, type PlayMetrics } from "./metrics";

/* -------------------- Helpers ENV -------------------- */
function intEnv(name: string, def: number, min?: number, max?: number): number {
  const raw = (process.env[name] || "").trim();
  const m = raw.match(/^\d+/);
  let n = m ? Number(m[0]) : def;
  if (Number.isNaN(n)) n = def;
  if (typeof min === "number") n = Math.max(min, n);
  if (typeof max === "number") n = Math.min(max, n);
  return n;
}

/* -------------------- Server setup -------------------- */
const PORT = intEnv("PORT", 4000);

const app = express();
app.use(express.json());
app.use(cors());

const publicDir = path.resolve(process.cwd(), "../xbox-music-ui/dist");
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*" },
  perMessageDeflate: false,
});

/* -------------------- Types & State -------------------- */
// ❌ plus de volume dans le state/control
type Control = { paused: boolean; skipSeq: number; repeat: boolean };
type Now = {
  url?: string;
  title?: string;
  thumb?: string;
  addedBy?: string;
  startedAt?: number | null;
  group?: string;
  durationSec?: number | null;
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
  durationSec?: number;
};

const state = {
  control: { paused: false, skipSeq: 0, repeat: false } as Control,
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

/* ---------- Broadcast batching & de-dup ---------- */
let broadcastTimer: NodeJS.Timeout | null = null;
let lastHash = "";

function computeHash(payload: unknown): string {
  try { return JSON.stringify(payload); }
  catch { return String(Math.random()); }
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
      queueMin: queued.map((q) => [q.id, q.status, q.title || "", q.thumb || ""]),
    });
    if (h === lastHash) return;
    lastHash = h;

    io.emit("state", payload);
  }, 20);
}

function pushToast(msg: string): void {
  io.emit("toast", msg);
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

/* ---------- PREFETCH METADATA après démarrage lecture ---------- */
let prefetchRunning = false;
let prefetchSeq = 0;

async function prefetchQueuedMetadata(seq: number): Promise<void> {
  if (!state.now || state.now.startedAt == null) return;

  const targets = state.queue.filter(
    (q) => q.status === "queued" && (!q.title || !q.thumb || q.durationSec == null)
  );
  if (targets.length === 0) return;

  const updates = targets.map(async (q) => {
    if (seq !== prefetchSeq) return;
    try {
      const info = await probeSingle(q.url);
      q.title ||= info.title;
      q.thumb ||= info.thumb;
      if (info.durationSec != null) q.durationSec = info.durationSec;
    } catch {}
  });

  await Promise.allSettled(updates);
  if (seq === prefetchSeq) scheduleBroadcast();
}

function kickPrefetch(): void {
  if (prefetchRunning) return;
  if (!state.now || state.now.startedAt == null) return;
  prefetchRunning = true;
  const seq = ++prefetchSeq;
  prefetchQueuedMetadata(seq).finally(() => {
    if (seq === prefetchSeq) prefetchRunning = false;
  });
}

/* ---------- Lecture/auto enchaînement ---------- */
async function ensurePlayerLoop(trace?: PlayMetrics): Promise<void> {
  if (playing) return;

  const idx = state.queue.findIndex((q) => q.status === "queued");
  if (idx === -1) return;
  const item = state.queue[idx];
  item.status = "playing";

  // Probe async (ne bloque pas)
  const s_probe = startSpan("probeSingle_async", { url: item.url });
  const probePromise = probeSingle(item.url)
    .then((info) => {
      item.title ||= info.title;
      item.thumb ||= info.thumb;
      if (state.now?.url === item.url) {
        state.now = {
          ...(state.now as Now),
          title: item.title,
          thumb: item.thumb,
          durationSec: info.durationSec ?? state.now?.durationSec ?? null,
        };
        scheduleBroadcast();
      }
      return info;
    })
    .finally(() => trace?.spans.push(s_probe.end()))
    .catch(() => null);

  // NOW minimal immédiat
  state.now = {
    url: item.url,
    title: item.title,
    thumb: item.thumb,
    addedBy: item.addedBy,
    startedAt: null,
    group: item.group,
    durationSec: null,
    positionOffsetSec: 0,
  };
  scheduleBroadcast();

  // Spawn mpv
  const s_spawn = startSpan("mpv_spawn");
  try {
    const handle = await startMpv(item.url);
    trace?.spans.push(s_spawn.end());

    playing = { item, handle };

    // Abonnements MPV (récupérer la durée)
    handle.on((ev) => {
      if (!state.now) return;
      if (ev.type === "property-change" && ev.name === "duration") {
        const d = typeof ev.data === "number" && isFinite(ev.data) ? ev.data : null;
        if (d != null && d > 0 && state.now.durationSec !== d) {
          state.now = { ...state.now, durationSec: d };
          scheduleBroadcast();
        }
      }
    });

    const s_ipc = startSpan("mpv_ipc_prep");
    await mpvPause(handle, state.control.paused).catch(() => {});
    await mpvSetLoopFile(handle, state.control.repeat).catch(() => {});
    trace?.spans.push(s_ipc.end());

    // ⚠️ Attendre le vrai démarrage
    await handle.waitForPlaybackStart();

    // Horloge UI démarre ici
    state.now = { ...(state.now as Now), startedAt: Date.now(), positionOffsetSec: 0 };
    scheduleBroadcast();

    // Prefetch une fois la lecture effective
    kickPrefetch();

    logNowPlaying();

    handle.proc.once("exit", () => {
      item.status = "done";
      state.now = null;
      playing = null;
      clearStatusLine();
      scheduleBroadcast();
      setTimeout(() => { void ensurePlayerLoop(); }, 120);
      if (trace) pushMetrics(trace);
    });

    void probePromise;
  } catch {
    trace?.spans.push(s_spawn.end({ error: true }));
    item.status = "error";
    state.now = null;
    playing = null;
    clearStatusLine();
    scheduleBroadcast();
    setTimeout(() => { void ensurePlayerLoop(); }, 600);
    if (trace) pushMetrics(trace);
  }
}

/* ---------- Ticker progression + console ---------- */
const TICK_MS = Math.max(250, intEnv("PROGRESS_TICK_MS", 1000));
const WANT_CONSOLE = process.env.PROGRESS_LOG === "1";

let lastProgressKey = "";
let lastStatusPrinted = "";

setInterval(() => {
  const now = state.now;
  if (!now) return;

  const pos = computePosition(now);
  const dur = now.durationSec ?? null;

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

    const trace: PlayMetrics = { id: `${Date.now()}-${Math.random()}`, spans: [], startedAt: Date.now() };
    const s_recv = startSpan("fe->be_receive");
    trace.spans.push(s_recv.end({ url: raw }));

    const s_quick = startSpan("resolveQuick", { url: raw });
    let quick: ResolvedItem[] = [];
    try { quick = await resolveQuick(raw); } catch {}
    trace.spans.push(s_quick.end({ count: quick.length }));

    const s_enqueue = startSpan("enqueue");
    const groupQuick = quick.length > 1 ? `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` : undefined;
    const addedBy = (payload.addedBy || "anon").slice(0, 64);
    const nowTs = Date.now();

    if (quick.length === 0) {
      state.queue.push({
        id: String(nextId++),
        url: normalizeUrl(raw),
        title: undefined,
        thumb: undefined,
        group: undefined,
        addedBy,
        status: "queued",
        createdAt: nowTs,
      });
    } else {
      for (const it of quick) {
        state.queue.push({
          id: String(nextId++),
          url: normalizeUrl(it.url),
          title: it.title,
          thumb: it.thumb,
          group: groupQuick,
          addedBy,
          status: "queued",
          createdAt: nowTs,
        });
      }
    }
    trace.spans.push(s_enqueue.end({ queued: quick.length || 1 }));

    scheduleBroadcast();
    kickPrefetch();

    const s_full = startSpan("resolveUrlToPlayableItems", { url: raw });
    resolveUrlToPlayableItems(raw)
      .then((full) => {
        trace.spans.push(s_full.end({ count: full.length }));

        const hadGroup = !!groupQuick;
        let targetGroup = groupQuick;
        if (full.length > 1 && !hadGroup) {
          targetGroup = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        }

        const existingByUrl = new Map<string, QueueItem | null>();
        for (const q of state.queue) {
          if (q.status !== "done" && q.url) {
            const key = normalizeUrl(q.url);
            if (!existingByUrl.has(key)) existingByUrl.set(key, q);
          }
        }

        const seen = new Set<string>();
        for (const it of full) {
          const key = normalizeUrl(it.url);
          seen.add(key);
          const q = existingByUrl.get(key);
          if (q) {
            q.title = q.title || it.title;
            q.thumb = q.thumb || it.thumb;
            if (it.durationSec != null && q.durationSec == null) q.durationSec = it.durationSec;
            if (!q.group && targetGroup) q.group = targetGroup;
          } else {
            state.queue.push({
              id: String(nextId++),
              url: key,
              title: it.title,
              thumb: it.thumb,
              group: targetGroup,
              addedBy,
              status: "queued",
              createdAt: Date.now(),
              durationSec: it.durationSec,
            });
          }
        }

        if (state.now && state.now.url) {
          const curKey = normalizeUrl(state.now.url);
          if (seen.has(curKey)) {
            const cur = full.find((x) => normalizeUrl(x.url) === curKey);
            if (cur) {
              state.now = {
                ...state.now,
                title: state.now.title || cur.title,
                thumb: state.now.thumb || cur.thumb,
                durationSec: state.now.durationSec ?? cur.durationSec ?? null,
              };
            }
          }
        }

        scheduleBroadcast();
        kickPrefetch();

        if (full.length > 1) {
          pushToast(`Playlist ajoutée: ${full.length} pistes ✅`);
        }
      })
      .catch((e) => {
        trace.spans.push(s_full.end({ error: e instanceof Error ? e.message : String(e) }));
      });

    void ensurePlayerLoop(trace);
  });

  socket.on("command", async (payload: {
    cmd: "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat" | "seek" | "seek_abs";
    arg?: number;
  }) => {
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
        kickPrefetch();
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

    if (WANT_CONSOLE) {
      if (payload.cmd === "pause") console.log("\n⏸ pause");
      if (payload.cmd === "resume") console.log("\n▶ reprise");
      if (payload.cmd === "shuffle") console.log("\n🔀 shuffle");
      if (payload.cmd === "repeat") console.log(`\n🔁 repeat: ${state.control.repeat ? "on" : "off"}`);
      if (payload.cmd === "skip") console.log("\n⏭ skip");
      if (payload.cmd === "seek" || payload.cmd === "seek_abs") {
        clearStatusLine();
        lastStatusPrinted = "";
      }
    }
  });

  socket.on("clear", async () => {
    if (playing?.handle) await mpvQuit(playing.handle).catch(() => {});
    for (const q of state.queue) {
      if (q.status === "queued" || q.status === "playing") q.status = "done";
    }
    state.now = null;
    clearStatusLine();
    scheduleBroadcast();
  });
});

/* ----------- Endpoints debug/metrics ----------- */
app.get("/now", (_req, res) => {
  if (!state.now) return res.json({ ok: true, now: null });
  const pos = computePosition(state.now);
  res.json({
    ok: true,
    now: { ...state.now, positionSec: pos, paused: state.control.paused, repeat: state.control.repeat },
  });
});

app.get("/metrics", (_req, res) => {
  res.json({ ok: true, metrics: getMetrics() });
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
