//server.ts
// 1. Indispensable en haut du fichier
process.env.PLAY_DL_SKIP_PROMPT = "true";

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
  getDirectPlayableUrl,
  type ResolvedItem,
  AGE_RESTRICTED,
} from "./ytdlp";
import { startSpan, pushMetrics, getMetrics, type PlayMetrics } from "./metrics";
import play from "play-dl";

// Force la fermeture du processus sur Ctrl+C même si stdin est bloqué
// Force la fermeture propre sur Ctrl+C
const shutdown = () => {
  console.log("\n👋 Arrêt du serveur (SIGINT)...");
  // On ferme le serveur HTTP pour libérer le port
  server.close();
  // On s'assure que mpv est tué si un morceau est en cours
  if (playing?.handle) {
    try { mpvQuit(playing.handle); } catch {}
  }
  // On quitte proprement
  process.exit(0);
};

process.on("SIGINT", () => {
  console.log("\n[Terminating] Arrêt en cours...");
  
  // On détruit l'entrée standard pour débloquer le terminal
  process.stdin.destroy(); 
  
  // On force la sortie après un délai très court pour laisser 
  // le temps aux logs de s'afficher
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

process.on("SIGTERM", shutdown);

async function setupSpotify() {
  try {
    const clientId = process.env.SPOTIFY_CLIENT_ID || "";
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || "";

    if (!clientId || !clientSecret) {
      console.warn("⚠️ [Spotify] Credentials manquants dans le .env");
    }

    await play.setToken({
      spotify: {
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        refresh_token: (process.env.SPOTIFY_REFRESH_TOKEN || "").trim(),
        market: 'FR'
      }
    });

    // Correction TS : pas d'argument ici
    const expired = await play.is_expired(); 
    console.log(`✅ [Spotify] play-dl configuré. Expire bientôt : ${expired}`);
  } catch (e) {
    console.error("❌ [Spotify] Initialization failed:", e);
  }
}
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
  try {
    return JSON.stringify(payload);
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

/* ---------- PREFETCH METADATA ---------- */
let prefetchRunning = false;
let prefetchSeq = 0;

// Ajoute cette petite fonction utilitaire en haut du fichier ou juste avant prefetchQueuedMetadata
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prefetchQueuedMetadata(seq: number): Promise<void> {
  if (!state.now || state.now.startedAt == null) return;

  const targets = state.queue.filter(
    (q) => q.status === "queued" && (!q.title || !q.thumb || q.durationSec == null),
  );

  if (targets.length === 0) return;

  for (const q of targets) {
    if (seq !== prefetchSeq) return;
    
    // ✨ NOUVEAU : Si c'est un lien de recherche Spotify, on ne probe pas.
    // Les infos fournies par play-dl sont déjà meilleures que ce que probeSingle trouverait.
    if (q.url.startsWith("ytsearch:")) continue;

    try {
      const info = await probeSingle(q.url);
      
      let changed = false;
      if (!q.title && info.title) { q.title = info.title; changed = true; }
      if (!q.thumb && info.thumb) { q.thumb = info.thumb; changed = true; }
      if (q.durationSec == null && info.durationSec != null) { q.durationSec = info.durationSec; changed = true; }

      if (changed) scheduleBroadcast();
      await sleep(500); 

    } catch (e) {
      console.error("[prefetch] probe error for", q.url, e);
      await sleep(1000);
    }
  }
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

/* ---------- Lecture/auto enchaînement (+ fallback direct URL) ---------- */
const START_TIMEOUT_MS = Math.max(5000, intEnv("START_TIMEOUT_MS", 15000));

async function tryPlayWith(startUrl: string, item: QueueItem, trace?: PlayMetrics): Promise<boolean> {
  const s_spawn = startSpan("mpv_spawn", { url: startUrl });
  try {
    console.log("[player] tryPlayWith =>", startUrl);
    const handle = await startMpv(startUrl);
    trace?.spans.push(s_spawn.end());

    playing = { item, handle };

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
    await mpvPause(handle, state.control.paused).catch((e) =>
      console.error("[player] pause init error", e),
    );
    await mpvSetLoopFile(handle, state.control.repeat).catch((e) =>
      console.error("[player] loop init error", e),
    );
    trace?.spans.push(s_ipc.end());

    await handle
      .waitForPlaybackStart(START_TIMEOUT_MS)
      .catch(async (e) => {
        trace?.spans.push(
          startSpan("mpv_start_fail").end({
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        console.error("[player] mpv start failed:", e);
        try {
          await mpvQuit(handle);
        } catch {}
        throw e;
      });

    state.now = { ...(state.now as Now), startedAt: Date.now(), positionOffsetSec: 0 };
    scheduleBroadcast();

    kickPrefetch();
    logNowPlaying();

    handle.proc.once("exit", () => {
      console.log("[player] mpv exit -> done current");
      item.status = "done";
      state.now = null;
      playing = null;
      clearStatusLine();
      scheduleBroadcast();
      setTimeout(() => {
        void ensurePlayerLoop();
      }, 120);
      if (trace) pushMetrics(trace);
    });

    return true;
  } catch (err) {
    trace?.spans.push(s_spawn.end({ error: true }));
    console.error("[player] failed to start mpv:", err);
    return false;
  }
}

async function ensurePlayerLoop(trace?: PlayMetrics): Promise<void> {
  if (playing) return;

  const idx = state.queue.findIndex((q) => q.status === "queued");
  if (idx === -1) return;
  const item = state.queue[idx];

  try {
    item.status = "playing";
    console.log("[player] start item:", item.url);

    // Initialisation de l'état "now"
    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      startedAt: null,
      group: item.group,
      durationSec: item.durationSec || null,
      positionOffsetSec: 0,
    };
    scheduleBroadcast();

    // 1. Récupération des métadonnées en arrière-plan (PROBE)
    // On ne le fait que si ce n'est PAS un item Spotify (ytsearch:) 
    // car Spotify a déjà ses infos complètes.
    if (!item.url.startsWith("ytsearch:")) {
      const s_probe = startSpan("probeSingle_async", { url: item.url });
      probeSingle(item.url)
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
        })
        .catch((e) => console.error("[player] probeSingle_async error:", e))
        .finally(() => trace?.spans.push(s_probe.end()));
    }

    // 2. Tentative de lecture n°1 : URL d'origine (ou ytsearch)
    const ok1 = await tryPlayWith(item.url, item, trace);
    if (ok1) return;

    // 3. Tentative de lecture n°2 : Fallback Direct URL (uniquement pour liens classiques)
    if (!item.url.startsWith("ytsearch:")) {
      const s_direct = startSpan("yt_direct_url", { url: item.url });
      const direct = await getDirectPlayableUrl(item.url).catch(() => null);
      trace?.spans.push(s_direct.end({ hasDirect: !!direct }));

      if (direct) {
        if (state.now) state.now.url = direct;
        const ok2 = await tryPlayWith(direct, item, trace);
        if (ok2) return;
      }
    }

    // 4. Échec total => Marquer en erreur et passer au suivant
    console.error("[player] both primary and direct playback failed -> skip");

    // Gestion spéciale des restrictions d'âge
    try {
      const key = normalizeUrl(item.url);
      if (AGE_RESTRICTED.has(key)) {
        pushToast("Miss Noémie est mineure et 100% pure. Skip de la musique...");
        AGE_RESTRICTED.delete(key);
      }
    } catch { /* ignore */ }

    item.status = "error";
    state.now = null;
    playing = null;
    clearStatusLine();
    scheduleBroadcast();
    
    // On relance la boucle après un court délai
    setTimeout(() => {
      void ensurePlayerLoop();
    }, 600);
    
    if (trace) pushMetrics(trace);

  } catch (e) {
    console.error("[player] ensurePlayerLoop fatal error:", e);
    item.status = "error";
    state.now = null;
    playing = null;
    clearStatusLine();
    scheduleBroadcast();
    setTimeout(() => {
      void ensurePlayerLoop();
    }, 600);
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
  console.log("[socket] client connected");
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
    try {
      const raw = String(payload?.url || "").trim();
      if (!/^https?:\/\//i.test(raw)) {
        console.warn("[socket] invalid URL", raw);
        return socket.emit("toast", "URL invalide");
      }

      const addedBy = (payload.addedBy || "anon").slice(0, 64);
      const nowTs = Date.now();
      
      const trace: PlayMetrics = {
        id: `${Date.now()}-${Math.random()}`,
        spans: [],
        startedAt: Date.now(),
      };

      // --- LOGIQUE DE DÉTECTION SPOTIFY ---
      const isSpotify = raw.includes("spotify.com") || raw.includes("googleusercontent.com/spotify");

      if (isSpotify) {
        // POUR SPOTIFY : On ne fait PAS de resolveQuick. 
        // On attend la conversion complète avant d'ajouter à la queue.
        const s_full = startSpan("resolveSpotify_blocking", { url: raw });
        try {
          const full = await resolveUrlToPlayableItems(raw);
          trace.spans.push(s_full.end({ count: full.length }));

          if (full.length === 0) {
            return socket.emit("toast", "Spotify : Aucun morceau trouvé.");
          }

          const group = full.length > 1 ? `grp_${Date.now()}_spotify` : undefined;
          
          for (const it of full) {
            state.queue.push({
              id: String(nextId++),
              url: it.url, // C'est maintenant une URL YouTube (grâce à play-dl)
              title: it.title,
              thumb: it.thumb,
              group: group,
              addedBy,
              status: "queued",
              createdAt: Date.now(),
              durationSec: it.durationSec,
            });
          }

          if (full.length > 1) pushToast(`Playlist Spotify: ${full.length} pistes ✅`);
          scheduleBroadcast();
        } catch (e) {
          console.error("[Spotify] Conversion error:", e);
          socket.emit("toast", "Erreur lors de la conversion Spotify.");
        }
      } else {
        // POUR TOUT LE RESTE (YouTube, etc.) : On garde la logique ultra-rapide
        const s_quick = startSpan("resolveQuick", { url: raw });
        let quick: ResolvedItem[] = [];
        try {
          quick = await resolveQuick(raw);
        } catch (e) {
          console.error("[play] resolveQuick error:", e);
        }
        trace.spans.push(s_quick.end({ count: quick.length }));

        const groupQuick = quick.length > 1 ? `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` : undefined;

        // Ajout immédiat (Metadata provisoires)
        if (quick.length === 0) {
          state.queue.push({
            id: String(nextId++),
            url: normalizeUrl(raw),
            status: "queued",
            addedBy,
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
        scheduleBroadcast();

        // Enrichissement en arrière-plan (Lent)
        resolveUrlToPlayableItems(raw).then((full) => {
          // ... (garder ta logique de mise à jour des métadonnées existante ici)
          // Celle qui fait le mapping via existingByUrl.set(key, q)
          // ...
          scheduleBroadcast();
        }).catch(e => console.error("[play] Background resolve error:", e));
      }

      // Lancer le player si besoin
      void ensurePlayerLoop(trace);

    } catch (e) {
      console.error("[socket.play] fatal:", e);
      socket.emit("toast", "Erreur interne côté serveur (play).");
    }
  });

  socket.on("command", async (payload: {
    cmd: "pause" | "resume" | "skip" | "skip_group" | "shuffle" | "repeat" | "seek" | "seek_abs";
    arg?: number;
  }) => {
    try {
      const now = state.now;

      switch (payload.cmd) {
        case "pause": {
          state.control.paused = true;

          // 🔊 Pause réelle côté mpv
          if (playing?.handle) {
            await mpvPause(playing.handle, true).catch((e) =>
              console.error("[pause] mpvPause error", e),
            );
          }

          if (now?.startedAt != null) {
            const elapsed = (Date.now() - now.startedAt) / 1000;
            state.now = {
              ...now,
              startedAt: null,
              positionOffsetSec: (now.positionOffsetSec || 0) + elapsed,
            };
          }
          break;
        }

        case "resume": {
          state.control.paused = false;

          // 🔊 Reprise réelle côté mpv
          if (playing?.handle) {
            await mpvPause(playing.handle, false).catch((e) =>
              console.error("[resume] mpvPause error", e),
            );
          }

          if (now) state.now = { ...now, startedAt: Date.now() };
          kickPrefetch();
          break;
        }

        case "skip": {
          state.control.skipSeq++;
          if (playing?.handle)
            await mpvQuit(playing.handle).catch((e) => console.error("[skip] quit error", e));
          break;
        }

        case "skip_group": {
          state.control.skipSeq++;
          const g = playing?.item.group;
          if (g) {
            for (const q of state.queue) {
              if (q.status === "queued" && q.group === g) q.status = "done";
            }
          }
          if (playing?.handle)
            await mpvQuit(playing.handle).catch((e) =>
              console.error("[skip_group] quit error", e),
            );
          break;
        }

        case "repeat": {
          state.control.repeat = !!Number(payload.arg ?? (state.control.repeat ? 0 : 1));
          if (playing?.handle)
            await mpvSetLoopFile(playing.handle, state.control.repeat).catch((e) =>
              console.error("[repeat] error", e),
            );
          break;
        }

        case "shuffle": {
          const before = state.queue.filter((q) => q.status === "queued").length;
          if (before > 1) {
            shuffleQueuedInPlace();
            pushToast(`🔀 Mélangé (${before})`);
            scheduleBroadcast();
          }
          break;
        }

        case "seek": {
          if (typeof payload.arg === "number") {
            if (playing?.handle) {
              await mpvSeekRelative(playing.handle, payload.arg).catch((e) =>
                console.error("[seek] rel error", e),
              );
            }
            if (now) {
              const base =
                (now.positionOffsetSec || 0) +
                (now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0);
              const dur = now.durationSec ?? Number.POSITIVE_INFINITY;
              const next = Math.max(0, Math.min(dur, base + payload.arg));
              state.now = {
                ...now,
                positionOffsetSec: next,
                startedAt: now.startedAt ? Date.now() : null,
              };
            }
          }
          break;
        }

        case "seek_abs": {
          if (typeof payload.arg === "number") {
            const target = Math.max(0, payload.arg);
            if (playing?.handle) {
              await mpvSeekAbsolute(playing.handle, target).catch((e) =>
                console.error("[seek] abs error", e),
              );
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
          break;
        }
      }

      scheduleBroadcast();

      if (process.env.PROGRESS_LOG === "1") {
        if (payload.cmd === "pause") console.log("\n⏸ pause");
        if (payload.cmd === "resume") console.log("\n▶ reprise");
        if (payload.cmd === "shuffle") console.log("\n🔀 shuffle");
        if (payload.cmd === "repeat")
          console.log(`\n🔁 repeat: ${state.control.repeat ? "on" : "off"}`);
        if (payload.cmd === "skip") console.log("\n⏭ skip");
        if (payload.cmd === "seek" || payload.cmd === "seek_abs") {
          clearStatusLine();
          lastStatusPrinted = "";
        }
      }
    } catch (e) {
      console.error("[socket.command] fatal:", e);
      socket.emit("toast", "Erreur interne côté serveur (command).");
    }
  });

  socket.on("clear", async () => {
    try {
      if (playing?.handle) await mpvQuit(playing.handle).catch(() => {});
      for (const q of state.queue) {
        if (q.status === "queued" || q.status === "playing") q.status = "done";
      }
      state.now = null;
      clearStatusLine();
      scheduleBroadcast();
    } catch (e) {
      console.error("[socket.clear] fatal:", e);
      socket.emit("toast", "Erreur interne côté serveur (clear).");
    }
  });

  socket.on("reorder_queue", ({ ids }: { ids: string[] }) => {
    const queued = state.queue.filter((q) => q.status === "queued");
    const map = new Map(queued.map((q) => [q.id, q]));

    const reordered: QueueItem[] = [];
    for (const id of ids) {
      const it = map.get(id);
      if (it) reordered.push(it);
    }

    state.queue = [
      ...state.queue.filter((q) => q.status !== "queued"),
      ...reordered,
    ];

    scheduleBroadcast();
  });

  socket.on("remove_queue_item", ({ id }: { id: string }) => {
    const q = state.queue.find((x) => x.id === id);
    if (!q) return;

    if (playing?.item.id === id && playing.handle) {
      mpvQuit(playing.handle).catch(() => {});
    }

    q.status = "done";
    scheduleBroadcast();
  });

});

/* ----------- Endpoints debug/metrics ----------- */
app.get("/now", (_req, res) => {
  try {
    if (!state.now) return res.json({ ok: true, now: null });
    const pos = computePosition(state.now);
    res.json({
      ok: true,
      now: {
        ...state.now,
        positionSec: pos,
        paused: state.control.paused,
        repeat: state.control.repeat,
      },
    });
  } catch (e) {
    console.error("/now error:", e);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

app.get("/metrics", (_req, res) => {
  try {
    res.json({ ok: true, metrics: getMetrics() });
  } catch (e) {
    console.error("/metrics error:", e);
    res.status(500).json({ ok: false });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

async function bootstrap() {
  // 1. On attend Spotify d'abord
  console.log("⏳ Initialisation de Spotify (répondez aux questions si nécessaire)...");
  await setupSpotify();

  // 2. Une fois que c'est fait, on lance le serveur
  server.listen(PORT, () => {
    console.log(`\n🎧 Music bot on http://localhost:${PORT}`);
  });
}

// Lancer le démarrage
bootstrap();

/* ================= Console status helpers ================= */
function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString()}:${r.toString().padStart(2, "0")}`;
}
function renderStatusLine(opts: {
  paused: boolean;
  repeat: boolean;
  pos: number;
  dur: number | null;
  title: string;
}) {
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
  process.stdout.write(
    "\r" + " ".repeat(process.stdout.columns || lastStatusPrinted.length) + "\r",
  );
  lastStatusPrinted = "";
}
function logNowPlaying() {
  if (!state.now) return;
  clearStatusLine();
  console.log(
    `🎵 Now playing: ${state.now.title || "(sans titre)"} ${
      state.now.durationSec ? "— " + fmtTime(state.now.durationSec) : ""
    }`,
  );
}

