process.env.PLAY_DL_SKIP_PROMPT = "true";

import "dotenv/config";
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import path from "node:path";
import play from "play-dl";

// Imports de tes fichiers locaux
import { state, nextId, playing } from "./types";
import { ensurePlayerLoop, ensureMpvRunning, skip } from "./player";
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
import { ensureVoicemeeterReady } from "./utils";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { 
  cors: { origin: "*" },
  perMessageDeflate: false 
});

app.use(express.static(path.resolve(process.cwd(), "../frontend/dist")));

/* --- HELPERS --- */

/**
 * Calcule la position actuelle du titre en cours pour synchroniser les nouveaux clients
 */
function computePosition(now: any): number {
  if (!now) return 0;
  
  // Si en pause ou buffering, on retourne l'offset figé
  if (state.control.paused || now.isBuffering || !now.startedAt) {
    return now.positionOffsetSec ?? 0;
  }
  
  // Calcul fluide : (Maintenant - Date de début)
  const current = (Date.now() - now.startedAt) / 1000;
  
  const duration = now.durationSec ?? 0;
  if (duration > 0 && current >= duration) return duration;
  
  return Math.max(0, current);
}

/**
 * Envoie l'état global à tous les clients connectés
 */
const broadcast = () => {
  const queued = state.queue.filter(q => q.status === "queued");
  const totalDuration = queued.reduce((acc, item) => acc + (item.durationSec || 0), 0);

  io.emit("state", {
    ok: true,
    now: state.now, // Contient title, thumb, durationSec, etc.
    queue: queued.slice(0, 50),
    stats: {
        totalQueued: queued.length,
        remainingTimeSec: totalDuration,
    },
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

/* --- ROUTES HTTP --- */

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), now: !!state.now });
});

/* --- LOGIQUE SOCKET --- */

io.on("connection", (socket) => {
  // Envoi immédiat de l'état à la connexion
  broadcast();

  // Envoi de la position précise pour synchroniser le curseur du nouveau client
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
      
      const isSpotify = normalized.includes("spotify.com") || normalized.includes("open.spotify");
      const isPlaylist = normalized.includes("list=") || normalized.includes("/playlist") || normalized.includes("/sets/");

      if (isSpotify || isPlaylist) {
        // --- MODE PLAYLIST ---
        socket.emit("toast", "Analyse de la playlist...");
        const items = await resolveUrlToPlayableItems(normalized);
        
        const group = `pl_${Date.now()}`;
        for (const it of items) {
          state.queue.push({
            id: String(nextId.current++),
            url: it.url,
            title: it.title || "Titre en attente...",
            thumb: it.thumb || null,
            durationSec: it.durationSec || 0,
            addedBy, 
            group, 
            status: "queued", 
            createdAt: Date.now()
          });
        }
        socket.emit("toast", `${items.length} titres ajoutés !`);
      } else {
        // --- MODE SIMPLE ---
        const entryId = String(nextId.current++);
        
        // 1. Ajout immédiat pour le feedback visuel (Placeholder)
        state.queue.push({
          id: entryId,
          url: normalized,
          title: "Analyse du signal...",
          thumb: null,
          addedBy,
          status: "queued",
          createdAt: Date.now()
        });

        // Broadcast immédiat pour afficher le "Analyse du signal..."
        broadcast();

        // 2. Enrichissement en arrière-plan (Titre, Image, Durée)
        probeSingle(normalized).then(enriched => {
          const item = state.queue.find(q => q.id === entryId);
          if (item) {
            item.title = enriched.title;
            // Le ?? null convertit undefined en null
            item.thumb = enriched.thumb ?? null; 
            item.durationSec = enriched.durationSec;
            
            // Si le morceau est passé en lecture pendant le probe, on met à jour state.now aussi
            if (state.now && state.now.url === item.url) {
              state.now.title = enriched.title;
              state.now.thumb = enriched.thumb ?? null;
              state.now.durationSec = enriched.durationSec;
            }
            broadcast();
          }
        }).catch(() => {});
      }

      // Lancer le moteur de lecture
      broadcast();
      void ensurePlayerLoop(broadcast);

    } catch (e) {
      console.error("[Play Error]", e);
      socket.emit("toast", "Erreur d'ajout.");
    }
  });

  socket.on("command", async (payload: { cmd: string; arg?: any }) => {
    const h = playing?.handle;

    switch (payload.cmd) {
      case "pause":
        state.control.paused = true;
        if (h) await mpvPause(h, true);
        if (state.now?.startedAt) {
          state.now.positionOffsetSec = computePosition(state.now);
          state.now.startedAt = null; 
        }
        break;

      case "resume":
        state.control.paused = false;
        if (h) await mpvPause(h, false);
        if (state.now && !state.now.isBuffering) {
          state.now.startedAt = Date.now() - ((state.now.positionOffsetSec || 0) * 1000);
        }
        break;

      case "skip":
        await skip(broadcast); 
        break;

      case "seek_abs":
        if (h && typeof payload.arg === "number") {
          if (state.now) {
            state.now.positionOffsetSec = payload.arg;
            state.now.startedAt = null; 
            state.now.isBuffering = true;
          }
          await mpvSeekAbsolute(h, payload.arg);
          broadcast();
        }
        break;
        
      case "repeat":
        const isRepeat = Boolean(payload.arg);
        state.control.repeat = isRepeat;
        if (h) await mpvSetLoopFile(h, isRepeat);
        break;
    }
    broadcast();
  });

  socket.on("clear", async () => {
    state.queue.forEach(q => { if (q.status === "queued") q.status = "done"; });
    if (playing?.handle) await mpvQuit(playing.handle);
    state.now = null;
    broadcast();
  });

  socket.on("remove_queue_item", async ({ id }) => {
    const item = state.queue.find(q => q.id === id);
    if (item) {
      item.status = "done";
      if (playing && playing.item.id === id) {
        await skip(broadcast);
      } else {
        broadcast();
      }
    }
  });
  
  socket.on("reorder_queue", ({ ids }: { ids: string[] }) => {
    const queuedItems = state.queue.filter(q => q.status === "queued");
    const reordered = ids
      .map(id => queuedItems.find(item => item.id === id))
      .filter((item): item is any => !!item);

    const remaining = queuedItems.filter(q => !ids.includes(q.id));
    const completed = state.queue.filter(q => q.status !== "queued");
    
    state.queue = [...completed, ...reordered, ...remaining];
    broadcast();
  });
});

async function bootstrap() {
    await setupSpotify();

    // Vérification et Configuration Auto
    const ready = await ensureVoicemeeterReady();
    
    if (!ready) {
        console.error("VoiceMeeter n'est pas installé.");
        // Envoyer le toast au frontend ici...
    } else {
        // Continuer le lancement de MPV et du serveur
        ensureMpvRunning().catch(console.error);
        server.listen(4000, () => console.log("🚀 Server Ready"));
    }
}

bootstrap();