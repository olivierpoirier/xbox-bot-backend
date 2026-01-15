// src/player.ts
import play from "play-dl"; // NÉCESSAIRE pour le lazy loading
import { state, playing, setPlaying, QueueItem, MpvHandle } from "./types";
import { startMpv, mpvPause, mpvLoadFile, mpvStop, mpvSetLoopFile } from "./mpv";
import { probeSingle, getDirectPlayableUrl, normalizeUrl } from "./ytdlp";
import { MPV_CONFIG } from "./config";

let globalMpvHandle: MpvHandle | null = null;
let isLooping = false;

/* ------------------- GESTION MPV ------------------- */

export async function ensureMpvRunning(): Promise<MpvHandle> {
  // Vérifie si l'instance existe et est toujours en vie
  if (globalMpvHandle && globalMpvHandle.proc.exitCode === null) {
    return globalMpvHandle;
  }
  
  console.log("[player] 🔥 Démarrage du moteur MPV...");
  // On démarre MPV en mode idle (sans URL)
  globalMpvHandle = await startMpv(""); 
  
  globalMpvHandle.proc.once("exit", () => {
    console.warn("[player] MPV s'est arrêté.");
    globalMpvHandle = null;
    // On nettoie l'état de lecture si MPV crash
    if (playing) {
      setPlaying(null);
      state.now = null;
    }
  });

  return globalMpvHandle;
}

/* ------------------- COEUR DU LECTEUR ------------------- */

async function tryPlayWith(startUrl: string, item: QueueItem, onStateChange: () => void): Promise<boolean> {
  const currentAttemptId = item.id;

  try {
    const handle = await ensureMpvRunning();
    
    // 1. Initialisation de l'état "Now Playing"
    setPlaying({ item, handle });
    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      group: item.group,
      durationSec: item.durationSec || 0,
      isBuffering: true, 
      positionOffsetSec: 0,
      startedAt: null 
    };
    onStateChange();

    // 2. Gestion des événements MPV
    // Note: handle.on est compatible avec notre nouveau mpv.ts (EventEmitter)
    handle.on((ev) => {
      // Sécurité : on ignore les événements si on a changé de morceau entre temps
      if (!playing || playing.item.id !== currentAttemptId) return;

      if (ev.type === "playback-restart") {
        if (state.now) {
          state.now.isBuffering = false;
          // On synchronise le chrono de l'UI
          state.now.startedAt = state.control.paused ? null : Date.now() - ((state.now.positionOffsetSec || 0) * 1000);
          onStateChange();
        }
      }

      if (ev.type === "property-change") {
        // --- MISE À JOUR DE LA POSITION ---
        if (ev.name === "time-pos" && typeof ev.data === "number") {
          const now = state.now;
          if (now) {
            const currentDuration = now.durationSec ?? 0;
            const lastOffset = now.positionOffsetSec ?? 0;

            // Protection contre les artefacts de fin de fichier
            if (currentDuration > 0 && ev.data >= currentDuration && lastOffset < 1) return;

            now.positionOffsetSec = ev.data;

            if (now.isBuffering) {
              now.isBuffering = false;
            }

            // Sync fluide du chrono (Correction Drift)
            if (!state.control.paused) {
              const theoreticalPos = now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0;
              const drift = Math.abs(theoreticalPos - ev.data);
              
              // On ne recalibre que si l'écart est significatif (> 1s) pour éviter les saccades
              if (drift > 1.0 || !now.startedAt) {
                now.startedAt = Date.now() - (ev.data * 1000);
              }
            }
            onStateChange();
          }
        }

        // --- MISE À JOUR DE LA DURÉE RÉELLE ---
        if (ev.name === "duration" && typeof ev.data === "number" && state.now) {
          if (ev.data > 0 && state.now.durationSec !== ev.data) {
            state.now.durationSec = ev.data;
            onStateChange();
          }
        }

        // --- DÉTECTION DE FIN DE PISTE ---
        if (ev.name === "idle-active" && ev.data === true) {
          const hasStarted = (state.now?.positionOffsetSec || 0) > 0;
          if (playing?.item.id === currentAttemptId && hasStarted) {
            handleEndOfTrack(item, onStateChange);
          }
        }
      }
    });

    // 3. Chargement effectif
    await mpvLoadFile(handle, startUrl, false);
    
    // Application de l'état Repeat (Boucle)
    await mpvSetLoopFile(handle, state.control.repeat);
    
    // Application de l'état Pause si l'utilisateur avait mis pause avant le chargement
    await mpvPause(handle, state.control.paused);
    
    // Attente du démarrage effectif du flux
    await handle.waitForPlaybackStart(MPV_CONFIG.globalStartTimeoutMs);
    
    return true;

  } catch (e) {
    console.error(`[player] Erreur de lecture sur: ${item.title}`, e);
    return false;
  }
}

function handleEndOfTrack(item: QueueItem, onStateChange: () => void) {
  if (item.status === "playing") {
    // Si le mode REPEAT est activé, MPV boucle tout seul (loop-file=inf)
    // On reset juste le chrono UI
    if (state.control.repeat) {
      if (state.now) {
        state.now.positionOffsetSec = 0;
        state.now.startedAt = Date.now();
      }
      return; 
    }

    console.log(`[player] ✅ Terminé : ${item.title}`);
    item.status = "done";
    state.now = null;
    setPlaying(null);
    onStateChange();
    
    // Petit délai avant de passer au suivant pour laisser l'IPC respirer
    setTimeout(() => {
      ensurePlayerLoop(onStateChange);
    }, 200);
  }
}

/* ------------------- BOUCLE DE PLAYLIST ------------------- */

export async function ensurePlayerLoop(onStateChange: () => void): Promise<void> {
  if (isLooping) return;
  
  // Si on joue déjà, on ne fait rien
  if (playing && playing.item.status === "playing") return;

  isLooping = true;

  try {
    const nextItem = state.queue.find(q => q.status === "queued");

    if (!nextItem) {
      state.now = null;
      setPlaying(null);
      onStateChange();
      return;
    }

    // 🔮 Pré-analyse du morceau suivant (Bonus performance)
    const followUpItem = state.queue.find(q => q.status === "queued" && q.id !== nextItem.id);
    if (followUpItem && !followUpItem.url.startsWith("provider:")) {
      probeSingle(normalizeUrl(followUpItem.url)).catch(() => {});
    }

    console.log(`[player] 🎵 Préparation : ${nextItem.title}`);

    // --- LAZY LOADING / RESOLUTION À LA VOLÉE ---
    // C'est ici qu'on transforme le lien Spotify "placeholder" en vrai lien YouTube
    if (nextItem.url.startsWith("provider:spotify:")) {
      console.log(`[player] 🔎 Résolution Spotify pour : ${nextItem.title}`);
      try {
        const query = nextItem.url.replace("provider:spotify:", "");
        // Recherche YouTube ciblée (rapide)
        const searchResults = await play.search(query, { limit: 1, source: { youtube: "video" } });
        
        if (searchResults && searchResults.length > 0) {
          nextItem.url = searchResults[0].url; // Mise à jour avec la vraie URL
          console.log(`[player] ✅ Lien YouTube trouvé : ${nextItem.url}`);
        } else {
          throw new Error("Introuvable sur YouTube");
        }
      } catch (e) {
        console.error(`[player] ❌ Échec résolution : ${nextItem.title}`, e);
        nextItem.status = "error";
        
        // On skip proprement et on passe au suivant
        setPlaying(null);
        state.now = null;
        onStateChange();
        setTimeout(() => ensurePlayerLoop(onStateChange), 100);
        return; // Important : on sort de la boucle actuelle
      }
    }
    // --------------------------------------------

    nextItem.status = "playing";
    const url = normalizeUrl(nextItem.url);

    // Tentative 1 : URL directe (YouTube/SoundCloud/etc via MPV)
    let success = await tryPlayWith(url, nextItem, onStateChange);

    // Tentative 2 : Si échec, on demande à yt-dlp de nous donner le lien brut
    if (!success) {
      console.log(`[player] 🔄 Tentative de secours (Direct URL) pour : ${nextItem.title}`);
      const direct = await getDirectPlayableUrl(url).catch(() => null);
      if (direct) {
        success = await tryPlayWith(direct, nextItem, onStateChange);
      }
    }

    // Gestion de l'échec définitif
    if (!success) {
      console.error(`[player] ❌ Échec définitif pour : ${nextItem.title}`);
      nextItem.status = "error";
      state.now = null;
      setPlaying(null);
      onStateChange();
      
      // On passe au morceau suivant après une petite pause
      setTimeout(() => {
        isLooping = false; 
        ensurePlayerLoop(onStateChange);
      }, 1000);
      return;
    }

  } catch (err) {
    console.error("[player] Erreur critique boucle :", err);
  } finally {
    isLooping = false;
  }
}

/* ------------------- ACTIONS ------------------- */

export async function skip(onStateChange: () => void) {
  if (playing) {
    console.log("[player] ⏭️ Skip demandé");
    const h = playing.handle;
    playing.item.status = "done";
    
    state.now = null;
    setPlaying(null);
    onStateChange();

    await mpvStop(h); 
    void ensurePlayerLoop(onStateChange);
  } else {
    // Si rien ne joue, on tente de lancer la file
    void ensurePlayerLoop(onStateChange);
  }
}

export async function stopPlayer(onStateChange: () => void) {
  if (globalMpvHandle) {
    globalMpvHandle.kill();
    globalMpvHandle = null;
  }
  setPlaying(null);
  state.now = null;
  onStateChange();
}