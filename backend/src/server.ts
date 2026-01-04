process.env.PLAY_DL_SKIP_PROMPT = "true";

import "dotenv/config";
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import path from "node:path";
import play from "play-dl";

// Imports de tes fichiers locaux
import { state, nextId, playing, setPlaying } from "./types";
import { ensurePlayerLoop, ensureMpvRunning, skip } from "./player";
import { 
  mpvPause, 
  mpvQuit, 
  mpvSetLoopFile, 
  mpvSeekAbsolute, 
  mpvStop
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
  if (!now) return 0;
  
  // Si on est en pause ou si startedAt est nul (pendant un seek), 
  // on retourne l'offset fixe sans ajouter le temps écoulé
  if (now.startedAt == null || now.isBuffering) {
    return now.positionOffsetSec || 0;
  }
  
  const elapsed = (Date.now() - now.startedAt) / 1000;
  const current = (now.positionOffsetSec || 0) + Math.max(0, elapsed);
  
  if (now.durationSec && current > now.durationSec) {
    return now.durationSec;
  }
  
  return current;
}

const broadcast = () => {
  const queued = state.queue.filter(q => q.status === "queued");
  
  // Calculer le temps total restant dans la file
  const totalDuration = queued.reduce((acc, item) => acc + (item.durationSec || 0), 0);

  io.emit("state", {
    ok: true,
    now: state.now,
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
        // On ne relance le chrono QUE si on n'est pas en train de bufferiser
        if (state.now && !state.now.isBuffering) {
          state.now.startedAt = Date.now();
        }
        break;

      case "skip":
        // PROTECTION : On appelle la fonction centralisée du player
        await skip(broadcast); 
        break;

      case "seek_abs":
        if (h && typeof payload.arg === "number") {
          // 1. Mise à jour immédiate de l'état local pour le prochain broadcast
          if (state.now) {
            state.now.positionOffsetSec = payload.arg;
            // On met startedAt à null pour "geler" le chrono de computePosition
            // Il sera relancé par l'event "time-pos" reçu de MPV dans tryPlayWith
            state.now.startedAt = null; 
            state.now.isBuffering = true; // On simule un buffering pour l'UI
          }

          // 2. Envoi de l'ordre à MPV
          await mpvSeekAbsolute(h, payload.arg);
          
          // 3. On broadcast tout de suite pour que l'UI sache que le serveur a accepté le seek
          broadcast();
        }
        break;
        
      case "repeat":
        const isRepeat = Boolean(payload.arg);
        state.control.repeat = isRepeat;
        // On informe MPV pour qu'il boucle sur le fichier actuel
        if (h) {
          await mpvSetLoopFile(h, isRepeat);
        }
        break;
    }
    broadcast();
  });

  socket.on("clear", async () => {
    state.queue.forEach(q => { if (q.status === "queued") q.status = "done"; });
    const currentPlaying = playing;
    if (currentPlaying?.handle) await mpvQuit(currentPlaying.handle);
    state.now = null;
    broadcast();
  });

  socket.on("remove_queue_item", async ({ id }) => {
    const item = state.queue.find(q => q.id === id);
    if (item) {
      item.status = "done";
      // Si on supprime ce qui est en train de jouer, on utilise le skip blindé
      if (playing && playing.item.id === id) {
        await skip(broadcast);
      } else {
        broadcast();
      }
    }
  });
  
  // Dans votre fichier serveur (ex: server.ts)
  socket.on("reorder_queue", ({ ids }: { ids: string[] }) => {
    // 1. Filtrer les éléments qui sont encore en attente (queued)
    const queuedItems = state.queue.filter(q => q.status === "queued");
    
    // 2. Créer le nouvel ordre basé sur les IDs reçus
    const reordered = ids
      .map(id => queuedItems.find(item => item.id === id))
      .filter((item): item is any => !!item);

    // 3. Récupérer les items qui ne sont pas dans la liste (sécurité)
    const remaining = queuedItems.filter(q => !ids.includes(q.id));

    // 4. Reconstruire la queue globale (garder les items "playing/done" au début)
    const completed = state.queue.filter(q => q.status !== "queued");
    
    state.queue = [...completed, ...reordered, ...remaining];

    console.log("✅ File réorganisée");
    broadcast();
  });

});

async function bootstrap() {
  await setupSpotify();
    // 🔥 PRÉCHAUFFAGE : On lance MPV tout de suite !
  // Comme ça, il sera prêt (idle) quand l'utilisateur cliquera sur Play.
  ensureMpvRunning().catch(console.error);
  const port = process.env.PORT || 4000;
  server.listen(port, () => console.log(`🚀 Server Ready on port ${port}`));
}
bootstrap();