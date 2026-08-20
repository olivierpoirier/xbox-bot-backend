process.env.PLAY_DL_SKIP_PROMPT = "true";

import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "http";
import { Server as IOServer, type Socket } from "socket.io";
import path from "node:path";
import play from "play-dl";

import { APP_CONFIG, MPV_CONFIG, SECURITY_CONFIG } from "./config.js";
import { normalizeAudioProfileName } from "./audioProfiles.js";
import { state, nextId, playing, QueueItem } from "./types.js";
import {
  ensurePlayerLoop,
  ensureMpvRunning,
  skip,
  stopPlayer,
  seekRelative,
  playPrevious,
  skipGroup,
  warmUpcomingTracks,
} from "./player.js";
import {
  mpvPause,
  mpvSetLoopFile,
  mpvSeekAbsolute,
  mpvSetAudioProfile,
} from "./mpv.js";
import {
  resolveUrlToPlayableItems,
  probeSingle,
  normalizeUrl,
  searchYoutubeVideo,
} from "./ytdlp.js";
import {
  isPlaylistUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isYoutubeSearchUrl,
} from "./platforms/index.js";
import {
  ensureAudioRoutingReady,
  getRuntimeAudioRouting,
  isVirtualAudioRoutingReady,
} from "./utils.js";
import { getMetrics } from "./metrics.js";

const app = express();
const server = http.createServer(app);

function originMatches(pattern: string, origin: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === origin;

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
  return regex.test(origin);
}

function isOriginAllowed(origin?: string): boolean {
  if (!origin || SECURITY_CONFIG.allowedOrigins.length === 0) return true;

  return SECURITY_CONFIG.allowedOrigins.some((allowedOrigin) =>
    originMatches(allowedOrigin, origin)
  );
}

function resolveCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
): void {
  callback(null, isOriginAllowed(origin));
}

const io = new IOServer(server, {
  cors: { origin: resolveCorsOrigin },
  maxHttpBufferSize: SECURITY_CONFIG.maxSocketPayloadBytes,
  perMessageDeflate: false,
});

/* --- VARIABLES DE CONTRÔLE DU CYCLE DE VIE --- */

let systemAudioWarning: string | null = null;
let activeUsers = 0;
let shutdownTimer: NodeJS.Timeout | null = null;
const SHUTDOWN_DELAY = 60_000;

type SocketRateState = {
  windowStartedAt: number;
  count: number;
  mutedUntil: number;
};

const socketRateStates = new WeakMap<Socket, SocketRateState>();

function readPayloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function sanitizeAddedBy(value: unknown): string {
  return String(value || "anon").trim().slice(0, 32) || "anon";
}

function sanitizeClientRequestId(value: unknown): string | undefined {
  return String(value || "").trim().slice(0, 120) || undefined;
}

function consumeSocketBudget(socket: Socket, action: string): boolean {
  const now = Date.now();
  const windowMs = SECURITY_CONFIG.socketRateLimitWindowMs;
  const maxEvents = SECURITY_CONFIG.socketRateLimitMax;
  const current =
    socketRateStates.get(socket) ||
    ({ windowStartedAt: now, count: 0, mutedUntil: 0 } satisfies SocketRateState);

  if (now - current.windowStartedAt > windowMs) {
    current.windowStartedAt = now;
    current.count = 0;
    current.mutedUntil = 0;
  }

  current.count += 1;
  socketRateStates.set(socket, current);

  if (current.count <= maxEvents) return true;

  if (now >= current.mutedUntil) {
    current.mutedUntil = now + 5_000;
    socket.emit("toast", "Trop de commandes envoyées. Ralentis un peu.");
    console.warn(
      `[security] socket rate limit exceeded action=${action} id=${socket.id}`
    );
  }

  return false;
}

io.use((socket, next) => {
  if (!isOriginAllowed(socket.handshake.headers.origin)) {
    next(new Error("Origin not allowed"));
    return;
  }

  next();
});

app.use(cors({ origin: resolveCorsOrigin }));
app.use(express.static(path.resolve(process.cwd(), "../frontend/dist")));

/* --- HELPERS --- */

function computePosition(now: typeof state.now): number {
  if (!now) return 0;

  if (state.control.paused || now.isBuffering || !now.startedAt) {
    return now.positionOffsetSec ?? 0;
  }

  const current = (Date.now() - now.startedAt) / 1000;
  const duration = now.durationSec ?? 0;

  if (duration > 0 && current >= duration) {
    return duration;
  }

  return Math.max(0, current);
}

function isProbablyUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || input.startsWith("spotify:");
}

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function broadcast(): void {
  const queued = state.queue.filter((q) => q.status === "queued");
  const totalDuration = queued.reduce(
    (acc, item) => acc + (item.durationSec || 0),
    0
  );

  io.emit("state", {
    ok: true,
    now: state.now,
    queue: queued,
    history: state.history.slice(0, 200),
    stats: {
      totalQueued: queued.length,
      remainingTimeSec: totalDuration,
    },
    control: state.control,
  });
}

async function enrichQueuedItem(entryId: string, url: string): Promise<void> {
  try {
    const enriched = await probeSingle(url);
    const item = state.queue.find((q) => q.id === entryId);

    if (!item) return;
    if (item.status === "done" || item.status === "error") return;

    item.title = enriched.title;
    item.thumb = enriched.thumb ?? null;
    item.durationSec = enriched.durationSec;

    if (state.now && state.now.url === item.url) {
      state.now.title = enriched.title;
      state.now.thumb = enriched.thumb ?? null;
      state.now.durationSec = enriched.durationSec;
    }

    broadcast();
  } catch (err) {
    console.warn("[probeSingle] failed", err);
  }
}

async function resolveSearchTextToVideoUrl(query: string): Promise<{
  url: string;
  title?: string;
  thumb?: string | null;
  durationSec?: number;
} | null> {
  try {
    return await searchYoutubeVideo(query);
  } catch (err) {
    console.error("[search text resolve failed]", err);
    return null;
  }
}

function pushQueueItem(
  item: Omit<QueueItem, "id" | "createdAt" | "status"> & {
    status?: QueueItem["status"];
  }
): QueueItem {
  const newItem: QueueItem = {
    id: String(nextId.current++),
    createdAt: Date.now(),
    status: item.status || "queued",
    url: item.url,
    title: item.title,
    thumb: item.thumb ?? null,
    group: item.group,
    addedBy: item.addedBy,
    durationSec: item.durationSec,
    clientRequestId: item.clientRequestId,
  };

  state.queue.push(newItem);
  return newItem;
}

function warmQueueIfPlaying(): void {
  if (playing) {
    warmUpcomingTracks();
  }
}

/* --- INITIALISATION --- */

async function setupSpotify() {
  try {
    await play.setToken({
      spotify: {
        client_id: (process.env.SPOTIFY_CLIENT_ID || "").trim(),
        client_secret: (process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
        refresh_token: (process.env.SPOTIFY_REFRESH_TOKEN || "").trim(),
        market: "FR",
      },
    });

    console.log("✅ [Spotify] Token configuré");
  } catch (e) {
    console.error("❌ [Spotify] Erreur setup:", e);
  }
}

/* --- ROUTES HTTP --- */

app.get("/health", (req, res) => {
  const memory = process.memoryUsage();

  res.json({
    status: "ok",
    uptime: process.uptime(),
    activeUsers,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    },
  });
});

app.get("/metrics", (req, res) => {
  res.json({
    status: "ok",
    metrics: getMetrics(),
  });
});

/* --- LOGIQUE SOCKET --- */

io.on("connection", (socket) => {
  activeUsers++;
  console.log(`👤 Client connecté. Total: ${activeUsers}`);

  if (shutdownTimer) {
    console.log("🛑 Extinction annulée : un utilisateur est revenu.");
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  if (systemAudioWarning) {
    socket.emit("error_system", systemAudioWarning);
  }

  broadcast();

  if (state.now) {
    socket.emit("progress", {
      positionSec: computePosition(state.now),
      durationSec: state.now.durationSec ?? null,
      paused: state.control.paused,
      repeat: state.control.repeat,
      title: state.now.title,
    });
  }

  socket.on(
    "play",
    async (payload: unknown) => {
      try {
        if (!consumeSocketBudget(socket, "play")) return;

        if (!isVirtualAudioRoutingReady()) {
          socket.emit(
            "toast",
            "Lecture bloquée : le routage audio virtuel du serveur n'est pas prêt."
          );
          if (systemAudioWarning) socket.emit("error_system", systemAudioWarning);
          return;
        }

        const body = readPayloadObject(payload);
        const raw = String(body.url || "").trim();
        const addedBy = sanitizeAddedBy(body.addedBy);
        const clientRequestId = sanitizeClientRequestId(body.clientRequestId);

        if (!raw) {
          socket.emit("toast", "Entrée vide.");
          return;
        }

        if (raw.length > SECURITY_CONFIG.queueInputMaxLength) {
          socket.emit("toast", "Entrée trop longue.");
          return;
        }

        if (!isProbablyUrl(raw)) {
          socket.emit("toast", "Recherche YouTube en cours...");

          const found = await resolveSearchTextToVideoUrl(raw);

          if (!found) {
            socket.emit("toast", "Aucun résultat trouvé.");
            return;
          }

          pushQueueItem({
            url: found.url,
            title: found.title || "Titre en attente...",
            thumb: found.thumb ?? null,
            durationSec: found.durationSec || 0,
            addedBy,
            clientRequestId,
          });

          broadcast();
          warmQueueIfPlaying();
          void ensurePlayerLoop(broadcast);
          return;
        }

        const normalized = normalizeUrl(raw);

        if (isYoutubeSearchUrl(normalized)) {
          socket.emit(
            "toast",
            "Ce lien est une page de recherche YouTube, pas une vidéo."
          );
          return;
        }

        const spotify = isSpotifyUrl(normalized);
        const playlist = isPlaylistUrl(normalized);
        const soundcloud = isSoundCloudUrl(normalized);

        if (spotify || playlist || soundcloud) {
          socket.emit(
            "toast",
            soundcloud && !playlist
              ? "Analyse du lien SoundCloud..."
              : "Analyse de la playlist..."
          );

          const items = await resolveUrlToPlayableItems(normalized);

          if (!items.length) {
            socket.emit("toast", "Aucun titre exploitable trouvé.");
            return;
          }

          const group = items.length > 1 ? `pl_${Date.now()}` : undefined;

          items.forEach((it, index) => {
            pushQueueItem({
              url: it.url,
              title: it.title || "Titre en attente...",
              thumb: it.thumb ?? null,
              durationSec: it.durationSec || 0,
              addedBy,
              group,
              clientRequestId: index === 0 ? clientRequestId : undefined,
            });
          });

          socket.emit(
            "toast",
            items.length > 1
              ? `${items.length} titres ajoutés !`
              : "Titre ajouté !"
          );
          broadcast();
          warmQueueIfPlaying();
          void ensurePlayerLoop(broadcast);
          return;
        }

        const queued = pushQueueItem({
          url: normalized,
          title: "Analyse du signal...",
          thumb: null,
          addedBy,
          clientRequestId,
        });

        broadcast();
        warmQueueIfPlaying();

        if (!isYoutubeSearchUrl(normalized)) {
          void enrichQueuedItem(queued.id, normalized);
        }

        void ensurePlayerLoop(broadcast);
      } catch (e) {
        console.error("[Play Error]", e);
        socket.emit("toast", "Erreur d'ajout.");
      }
    }
  );

  socket.on("command", async (payload: unknown) => {
    if (!consumeSocketBudget(socket, "command")) return;

    const body = readPayloadObject(payload);
    const cmd = String(body.cmd || "");
    const arg = body.arg;
    const h = playing?.handle;

    switch (cmd) {
      case "pause": {
        state.control.paused = true;

        if (h) {
          await mpvPause(h, true);
        }

        if (state.now?.startedAt) {
          state.now.positionOffsetSec = computePosition(state.now);
          state.now.startedAt = null;
        }
        break;
      }

      case "resume": {
        state.control.paused = false;

        if (h) {
          await mpvPause(h, false);
        }

        if (state.now && !state.now.isBuffering) {
          state.now.startedAt =
            Date.now() - ((state.now.positionOffsetSec || 0) * 1000);
        }
        break;
      }

      case "skip": {
        await skip(broadcast);
        break;
      }

      case "skip_group": {
        await skipGroup(broadcast);
        break;
      }

      case "previous": {
        await playPrevious(broadcast);
        break;
      }

      case "seek": {
        const delta = Number(arg) || 0;
        await seekRelative(delta, broadcast);
        break;
      }

      case "seek_abs": {
        if (h && typeof arg === "number") {
          if (state.now) {
            state.now.positionOffsetSec = arg;
            state.now.startedAt = null;
            state.now.isBuffering = true;
          }

          await mpvSeekAbsolute(h, arg);
          broadcast();
        }
        break;
      }

      case "repeat": {
        const isRepeat = Boolean(arg);
        state.control.repeat = isRepeat;

        if (h) {
          await mpvSetLoopFile(h, isRepeat);
        }
        break;
      }

      case "audio_profile": {
        const profile = normalizeAudioProfileName(String(arg || ""));
        state.control.audioProfile = profile;

        if (h) {
          await mpvSetAudioProfile(h, profile);
        }

        socket.emit(
          "toast",
          profile === "xbox"
            ? "Profil audio Xbox activé."
            : "Profil audio équilibré activé."
        );
        break;
      }

      case "random_mode": {
        state.control.randomMode = Boolean(arg);
        warmQueueIfPlaying();
        break;
      }

      case "shuffle_queue": {
        const queuedItems = state.queue.filter((q) => q.status === "queued");
        const shuffled = shuffleArray(queuedItems);
        const completed = state.queue.filter((q) => q.status !== "queued");
        state.queue = [...completed, ...shuffled];
        warmQueueIfPlaying();
        break;
      }

      default: {
        socket.emit("toast", "Commande inconnue.");
        return;
      }
    }

    broadcast();
  });

  socket.on("clear", async () => {
    if (!consumeSocketBudget(socket, "clear")) return;

    state.queue.forEach((q) => {
      if (q.status === "queued" || q.status === "playing") {
        q.status = "done";
      }
    });

    await stopPlayer(broadcast);
    broadcast();
  });

  socket.on("remove_queue_item", async (payload: unknown) => {
    if (!consumeSocketBudget(socket, "remove_queue_item")) return;

    const { id } = readPayloadObject(payload);
    const normalizedId = String(id || "");
    const item = state.queue.find((q) => q.id === normalizedId);
    if (!item) return;

    item.status = "done";

    if (playing && playing.item.id === id) {
      await skip(broadcast);
    } else {
      warmQueueIfPlaying();
      broadcast();
    }
  });

  socket.on("reorder_queue", (payload: unknown) => {
    if (!consumeSocketBudget(socket, "reorder_queue")) return;

    const { ids } = readPayloadObject(payload);
    if (!Array.isArray(ids)) return;
    if (ids.length > SECURITY_CONFIG.reorderMaxItems) {
      socket.emit("toast", "Trop d'éléments à réordonner.");
      return;
    }

    const queuedItems = state.queue.filter((q) => q.status === "queued");
    const normalizedIds = [...new Set(ids.map((id) => String(id)))];

    const reordered: QueueItem[] = normalizedIds
      .map((id) => queuedItems.find((item) => item.id === id))
      .filter((item): item is QueueItem => Boolean(item));

    const remaining = queuedItems.filter((q) => !normalizedIds.includes(q.id));
    const completed = state.queue.filter((q) => q.status !== "queued");

    state.queue = [...completed, ...reordered, ...remaining];
    warmQueueIfPlaying();
    broadcast();
  });

  socket.on(
    "requeue_history_item",
    (payload: unknown) => {
      if (!consumeSocketBudget(socket, "requeue_history_item")) return;

      const body = readPayloadObject(payload);
      const id = String(body.id || "");
      const targetIndex = body.targetIndex;
      const source = state.history.find((h) => h.id === id);
      if (!source) return;

      const newItem = pushQueueItem({
        url: source.url,
        title: source.title || "Titre en attente...",
        thumb: source.thumb ?? null,
        durationSec: source.durationSec || 0,
        addedBy: source.addedBy,
        group: source.group,
      });

      const queuedItems = state.queue.filter((q) => q.status === "queued");
      const completed = state.queue.filter((q) => q.status !== "queued");

      const queueOnly = queuedItems.filter((q) => q.id !== newItem.id);

      const insertAt =
        typeof targetIndex === "number"
          ? Math.max(0, Math.min(targetIndex, queueOnly.length))
          : queueOnly.length;

      queueOnly.splice(insertAt, 0, newItem);

      state.queue = [...completed, ...queueOnly];

      broadcast();
      warmQueueIfPlaying();
      void ensurePlayerLoop(broadcast);
    }
  );

  socket.on("disconnect", () => {
    activeUsers = Math.max(0, activeUsers - 1);
    console.log(`👤 Client déconnecté. Restants: ${activeUsers}`);

    if (activeUsers <= 0) {
      console.log(
        `⏳ Plus personne sur l'interface. Extinction dans ${SHUTDOWN_DELAY / 1000}s...`
      );

      shutdownTimer = setTimeout(async () => {
        console.log("🔌 Auto-shutdown : Inactivité prolongée.");

        try {
          await stopPlayer(broadcast);
        } catch {}

        process.exit(0);
      }, SHUTDOWN_DELAY);
    }
  });
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[server] ${signal} received, stopping player`);

  try {
    await stopPlayer(broadcast);
  } catch (error) {
    console.warn("[server] player shutdown failed", error);
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

/* --- BOOTSTRAP --- */

async function bootstrap() {
  state.control.audioProfile = MPV_CONFIG.defaultAudioProfile;

  await setupSpotify();

  const audioReady = await ensureAudioRoutingReady();
  const audioRouting = getRuntimeAudioRouting();

  if (audioRouting.message) {
    console.log(`[Audio] ${audioRouting.message}`);
  }

  if (!audioReady || !isVirtualAudioRoutingReady()) {
    systemAudioWarning =
      audioRouting.message ||
      "Le routage audio virtuel n'a pas pu être préparé. Le bot utilisera la sortie audio système par défaut.";
  }

  if (systemAudioWarning) {
    systemAudioWarning =
      "Le routage audio virtuel n'est pas prêt. La lecture est bloquée pour éviter toute sortie audio système.";
  } else {
    ensureMpvRunning().catch(console.error);
  }

  server.listen(APP_CONFIG.PORT, () => {
    console.log(`🚀 Server Ready on port ${APP_CONFIG.PORT}`);
  });
}

bootstrap();
