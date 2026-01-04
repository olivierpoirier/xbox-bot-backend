import { state, playing, setPlaying, QueueItem } from "./types";
import { startMpv, mpvPause, mpvLoadFile, mpvStop, MpvHandle } from "./mpv";
import { probeSingle, getDirectPlayableUrl, normalizeUrl } from "./ytdlp";

const START_TIMEOUT_MS = 15000;
let globalMpvHandle: MpvHandle | null = null;
let isLooping = false;

/* ------------------- GESTION MPV ------------------- */

export async function ensureMpvRunning(): Promise<MpvHandle> {
  if (globalMpvHandle && globalMpvHandle.proc.exitCode === null) {
    return globalMpvHandle;
  }
  
  console.log("[player] 🔥 Démarrage du moteur MPV...");
  globalMpvHandle = await startMpv(""); 
  
  globalMpvHandle.proc.once("exit", () => {
    console.warn("[player] MPV s'est arrêté.");
    globalMpvHandle = null;
  });

  return globalMpvHandle;
}

/* ------------------- COEUR DU LECTEUR ------------------- */

async function tryPlayWith(startUrl: string, item: QueueItem, onStateChange: () => void): Promise<boolean> {
  const currentAttemptId = item.id;

  try {
    const handle = await ensureMpvRunning();
    
    // 1. Initialisation de l'état
    setPlaying({ item, handle });
    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      group: item.group,
      durationSec: item.durationSec || 0,
      isBuffering: true, // Bloque le chrono au début
      positionOffsetSec: 0,
      startedAt: null 
    };
    onStateChange();

    // 2. Écouteurs d'événements
    handle.on((ev) => {
      if (!playing || playing.item.id !== currentAttemptId) return;

      // REPEAT / SEEK : Remise à zéro du chrono
      if (ev.type === "playback-restart") {
        if (state.now) {
          state.now.isBuffering = false;
          state.now.startedAt = state.control.paused ? null : Date.now();
          onStateChange();
        }
      }

      if (ev.type === "property-change") {
        // Mise à jour de la position (Time Pos)
        if (ev.name === "time-pos" && typeof ev.data === "number") {
          if (state.now) {
            state.now.positionOffsetSec = ev.data;
            
            // Si on sort du buffering (chargement initial ou après un seek)
            if (state.now.isBuffering) {
              state.now.isBuffering = false;
              state.now.startedAt = state.control.paused ? null : Date.now();
              console.log(`[player] 🎯 Lecture active à ${ev.data}s`);
              onStateChange();
            }
          }
        }

        // Mise à jour de la durée réelle
        if (ev.name === "duration" && typeof ev.data === "number" && state.now) {
          state.now.durationSec = ev.data;
          onStateChange();
        }

        // --- DÉTECTION DE FIN DE PISTE ---
        if (ev.name === "idle-active" && ev.data === true) {
          /**
           * SÉCURITÉ : On ne déclenche la fin que si :
           * 1. On n'est plus en train de charger (isBuffering: false)
           * 2. On a déjà une position (positionOffsetSec > 0) ou une durée
           * Cela évite que MPV ne skip la musique au moment exact où il l'ouvre.
           */
          const hasStarted = (state.now?.positionOffsetSec || 0) > 0;
          const isNotLoading = state.now?.isBuffering === false;

          if (playing?.item.id === currentAttemptId && isNotLoading && hasStarted) {
            handleEndOfTrack(item, onStateChange);
          }
        }
      }
    });

    const directUrl = normalizeUrl(startUrl);
    if (!directUrl) throw new Error("URL invalide");

    // 3. Chargement et synchro pause
    await mpvLoadFile(handle, directUrl, false);
    await mpvPause(handle, state.control.paused);

    // 4. Attente du signal de départ
    await handle.waitForPlaybackStart(START_TIMEOUT_MS);
    
    return true;

  } catch (e) {
    console.error(`[player] Erreur sur: ${item.title}`, e);
    if (playing?.item.id === currentAttemptId) {
      state.now = null;
      setPlaying(null);
      onStateChange();
    }
    return false;
  }
}

/**
 * Gère la fin de lecture d'un morceau
 */

/**
 * Gère la fin de lecture d'un morceau.
 * Cette fonction est appelée par l'événement "idle-active" de MPV.
 */
function handleEndOfTrack(item: QueueItem, onStateChange: () => void) {
  if (item.status === "playing") {
    
    // CAS DU REPEAT :
    // Si le mode repeat est actif, MPV ne passe pas réellement en mode "idle"
    // de manière définitive, il reboucle. L'événement "playback-restart" 
    // dans tryPlayWith s'occupe de remettre le chrono à zéro.
    // On sort donc de la fonction pour ne pas marquer le morceau comme "done".
    if (state.control.repeat) {
      return; 
    }

    // CAS NORMAL : Le morceau est terminé, on passe au suivant
    console.log(`[player] ✅ Terminé : ${item.title}`);
    
    // 1. Marquer l'item actuel comme terminé
    item.status = "done";
    
    // 2. Nettoyer l'état global de lecture
    state.now = null;
    setPlaying(null);
    
    // 3. Notifier les clients que la lecture est finie (la file va se mettre à jour)
    onStateChange();
    
    // 4. Lancer la lecture du prochain morceau après un court délai
    // Ce délai de 100ms permet à MPV de bien finaliser son état interne.
    setTimeout(() => {
      ensurePlayerLoop(onStateChange);
    }, 100);
  }
}

/* ------------------- BOUCLE DE PLAYLIST ------------------- */

export async function ensurePlayerLoop(onStateChange: () => void): Promise<void> {
  // 1. Verrouillage pour éviter que deux boucles tournent en même temps
  if (isLooping) return;

  // 2. Vérification de l'état actuel de MPV
  // Si on pense être en train de jouer mais que MPV est mort, on reset
  if (playing && (!globalMpvHandle || globalMpvHandle.proc.exitCode !== null)) {
    console.warn("[player] MPV est mort pendant la lecture, nettoyage...");
    setPlaying(null);
    state.now = null;
  }

  // 3. Si on est déjà en train de jouer quelque chose de valide, on ne fait rien
  if (playing && playing.item.status === "playing") return;

  isLooping = true;

  try {
    // 4. Recherche du prochain morceau "queued"
    // Note: l'ordre dans state.queue détermine l'ordre de lecture.
    const nextItem = state.queue.find(q => q.status === "queued");

    if (!nextItem) {
      // Plus rien dans la file d'attente
      state.now = null;
      setPlaying(null);
      onStateChange();
      return;
    }

    console.log(`[player] 🎵 Prochain titre : ${nextItem.title}`);

    // 5. Initialisation visuelle immédiate (Feedback utilisateur)
    nextItem.status = "playing";
    state.now = {
      url: nextItem.url,
      title: nextItem.title,
      thumb: nextItem.thumb,
      addedBy: nextItem.addedBy,
      group: nextItem.group,
      durationSec: nextItem.durationSec || 0,
      startedAt: null,
      positionOffsetSec: 0,
      isBuffering: true
    };
    onStateChange();

    const url = normalizeUrl(nextItem.url);

    // 6. Enrichissement des métadonnées en arrière-plan (si nécessaire)
    probeSingle(url).then(info => {
      // On ne met à jour que si le morceau est toujours celui qui doit jouer
      if (state.now && playing?.item.id === nextItem.id) {
        state.now.title = info.title;
        state.now.thumb = info.thumb || state.now.thumb;
        state.now.durationSec = info.durationSec;
        onStateChange();
      }
    }).catch(() => {});

    // 7. Tentative de lecture n°1 (URL normale ou cache)
    let success = await tryPlayWith(url, nextItem, onStateChange);

    // 8. Tentative de lecture n°2 (URL directe via yt-dlp si la première a échoué)
    if (!success) {
      console.log(`[player] Tentative de secours pour : ${nextItem.title}`);
      const direct = await getDirectPlayableUrl(url).catch(() => null);
      if (direct) {
        success = await tryPlayWith(direct, nextItem, onStateChange);
      }
    }

    // 9. Gestion de l'échec définitif
    if (!success) {
      console.error(`[player] ❌ Échec définitif : ${nextItem.title}`);
      nextItem.status = "error";
      state.now = null;
      setPlaying(null);
      onStateChange();
      
      // On attend 1 seconde avant de tenter le morceau suivant pour éviter le spam en cas de coupure internet
      setTimeout(() => {
        isLooping = false; // On libère avant le réappel
        ensurePlayerLoop(onStateChange);
      }, 1000);
      return;
    }

  } catch (err) {
    console.error("[player] Erreur critique dans la boucle :", err);
  } finally {
    isLooping = false;
  }
}

/* ------------------- ACTIONS UTILISATEUR ------------------- */

export async function skip(onStateChange: () => void) {
  if (playing) {
    console.log("[player] ⏭️ Skip");
    const h = playing.handle;
    playing.item.status = "done";
    
    // On nettoie l'état AVANT de stopper MPV pour éviter les flashs d'UI
    state.now = null;
    setPlaying(null);
    onStateChange();

    // Stopper MPV déclenchera l'idle-active mais l'ID aura déjà changé
    await mpvStop(h); 
    void ensurePlayerLoop(onStateChange);
  } else {
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