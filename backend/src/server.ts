process.env.PLAY_DL_SKIP_PROMPT = "true";

import "dotenv/config";
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import path from "node:path";
import play from "play-dl";

// Imports de tes fichiers locaux
import { state, nextId, playing } from "./types";
import { ensurePlayerLoop } from "./player";
import { 
  mpvPause, 
  mpvQuit, 
  mpvSetLoopFile, 
  mpvSeekAbsolute 
} from "./mpv";
import { 
  resolveUrlToPlayableItems, 
  probeSingle,
  normalizeUrl 
} from "./ytdlp";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { 
  cors: { origin: "*" },
  perMessageDeflate: false 
});

app.use(express.static(path.resolve(process.cwd(), "../xbox-music-ui/dist")));

/* --- HELPERS --- */

function computePosition(now: any): number {
  const base = now.positionOffsetSec || 0;
  if (now.startedAt == null) return base;
  return base + Math.max(0, (Date.now() - now.startedAt) / 1000);
}

const broadcast = () => {
  const queued = state.queue.filter(q => q.status === "queued");
  io.emit("state", {
    ok: true,
    now: state.now,
    queue: queued.slice(0, 50),
    totalQueued: queued.length,
    control: state.control
  });
};

/* --- INITIALISATION --- */

async function setupSpotify() {
  try {
    await play.setToken({
      spotify: {
        client_id: (process.env.SPOTIFY_CLIENT_ID || "").trim(),
        client_secret: (process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
        refresh_token: (process.env.SPOTIFY_REFRESH_TOKEN || "").trim(),
        market: 'FR'
      }
    });
    console.log("✅ [Spotify] Token configuré");
  } catch (e) {
    console.error("❌ [Spotify] Erreur setup:", e);
  }
}

/* --- LOGIQUE SOCKET --- */

io.on("connection", (socket) => {
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

  socket.on("play", async (payload: { url?: string; addedBy?: string }) => {
    try {
      const raw = String(payload?.url || "").trim();
      if (!raw.startsWith("http")) return socket.emit("toast", "Lien invalide");

      const addedBy = (payload.addedBy || "anon").slice(0, 32);
      const normalized = normalizeUrl(raw);
      
      const isSpotify = normalized.includes("spotify.com") || normalized.includes("googleusercontent.com/spotify");
      const isPlaylist = normalized.includes("list=") || normalized.includes("/playlist") || normalized.includes("/sets/");

      if (isSpotify || isPlaylist) {
        // --- MODE PLAYLIST (Traitement groupé) ---
        socket.emit("toast", "Analyse de la playlist...");
        const items = await resolveUrlToPlayableItems(normalized);
        const group = `pl_${Date.now()}`;
        
        for (const it of items) {
          state.queue.push({
            id: String(nextId.current++),
            url: it.url,
            title: it.title || "Chargement...",
            thumb: it.thumb,
            durationSec: it.durationSec,
            addedBy, group, status: "queued", createdAt: Date.now()
          });
        }
      } else {
        // --- MODE SIMPLE (Vitesse maximale) ---
        const entryId = String(nextId.current++);
        
        // On ajoute immédiatement avec un titre temporaire
        state.queue.push({
          id: entryId,
          url: normalized,
          title: "Analyse du signal...",
          addedBy,
          status: "queued",
          createdAt: Date.now()
        });

        // On lance l'enrichissement (titre/pochette) en arrière-plan
        probeSingle(normalized).then(enriched => {
          const item = state.queue.find(q => q.id === entryId);
          if (item) {
            item.title = enriched.title;
            item.thumb = enriched.thumb;
            item.durationSec = enriched.durationSec;
            broadcast();
          }
        }).catch(() => {});
      }

      // On broadcast l'ajout (même partiel) et on lance le moteur de lecture
      broadcast();
      void ensurePlayerLoop(broadcast);

    } catch (e) {
      console.error("[Play Error]", e);
      socket.emit("toast", "Erreur d'ajout.");
    }
  });

  socket.on("command", async (payload: { cmd: string; arg?: any }) => {
    const currentPlaying = playing; 
    try {
      switch (payload.cmd) {
        case "pause":
          state.control.paused = true;
          if (currentPlaying?.handle) await mpvPause(currentPlaying.handle, true);
          if (state.now?.startedAt) {
             const elapsed = (Date.now() - state.now.startedAt) / 1000;
             state.now.positionOffsetSec = (state.now.positionOffsetSec || 0) + elapsed;
             state.now.startedAt = null;
          }
          break;

        case "resume":
          state.control.paused = false;
          if (currentPlaying?.handle) await mpvPause(currentPlaying.handle, false);
          if (state.now) state.now.startedAt = Date.now();
          break;

        case "skip":
          if (currentPlaying?.handle) {
            console.log("[command] Force Skip...");
            currentPlaying.handle.kill(); // On utilise .kill() (SIGKILL) au lieu de mpvQuit
          }
          break;

        case "repeat":
          state.control.repeat = !state.control.repeat;
          if (currentPlaying?.handle) await mpvSetLoopFile(currentPlaying.handle, state.control.repeat);
          break;

        case "seek_abs":
          if (typeof payload.arg === "number" && currentPlaying?.handle) {
            await mpvSeekAbsolute(currentPlaying.handle, payload.arg);
            if (state.now) {
              state.now.positionOffsetSec = payload.arg;
              state.now.startedAt = state.now.startedAt ? Date.now() : null;
            }
          }
          break;
      }
      broadcast();
    } catch (e) {
      console.error("[command] Error:", e);
    }
  });

  socket.on("clear", async () => {
    state.queue.forEach(q => { if (q.status === "queued") q.status = "done"; });
    const currentPlaying = playing;
    if (currentPlaying?.handle) await mpvQuit(currentPlaying.handle);
    state.now = null;
    broadcast();
  });

  socket.on("remove_queue_item", ({ id }) => {
    const item = state.queue.find(q => q.id === id);
    const currentPlaying = playing; 

    if (item) {
      item.status = "done";
      if (currentPlaying && currentPlaying.item.id === id && currentPlaying.handle) {
        mpvQuit(currentPlaying.handle).catch(() => {});
      }
      broadcast();
    }
  });
});

async function bootstrap() {
  await setupSpotify();
  const port = process.env.PORT || 4000;
  server.listen(port, () => console.log(`🚀 Server Ready on port ${port}`));
}
bootstrap();