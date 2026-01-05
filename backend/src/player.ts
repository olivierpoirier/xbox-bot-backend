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
    
    // 1. Initialisation stricte de l'état
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

    // 2. Écouteurs d'événements
    handle.on((ev) => {
      if (!playing || playing.item.id !== currentAttemptId) return;

      // REPEAT / SEEK / RESTART
      if (ev.type === "playback-restart") {
        if (state.now) {
          state.now.isBuffering = false;
          state.now.startedAt = state.control.paused ? null : Date.now();
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

            // Protection contre les artefacts de chargement (le bond au temps max)
            if (currentDuration > 0 && ev.data >= currentDuration && lastOffset < 1) {
              return;
            }

            // Mise à jour de la position brute
            now.positionOffsetSec = ev.data;

            // Sortie de buffering
            if (now.isBuffering) {
              now.isBuffering = false;
              // Premier démarrage du chrono
              if (!state.control.paused) {
                now.startedAt = Date.now() - (ev.data * 1000);
              }
            }

            // --- CORRECTION VITESSE 2X ---
            // On ne recalibre startedAt que si le décalage (drift) est important (> 1s).
            // Sinon, on laisse le Date.now() couler naturellement.
            if (!state.control.paused && now.startedAt) {
              const theoreticalPos = (Date.now() - now.startedAt) / 1000;
              const drift = Math.abs(theoreticalPos - ev.data);
              
              // Si l'écart entre MPV et le Serveur est trop grand (>1s), on resynchronise.
              // Cela évite de modifier startedAt à chaque tick (ce qui causait l'accélération).
              if (drift > 1.0) {
                 now.startedAt = Date.now() - (ev.data * 1000);
              }
            } else if (!state.control.paused && !now.startedAt) {
              // Cas de reprise après un buffering
              now.startedAt = Date.now() - (ev.data * 1000);
            }
            
            onStateChange();
          }
        }

        // --- MISE À JOUR DE LA DURÉE ---
        if (ev.name === "duration" && typeof ev.data === "number" && state.now) {
          if (ev.data > 0 && state.now.durationSec !== ev.data) {
            state.now.durationSec = ev.data;
            onStateChange();
          }
        }

        // --- DÉTECTION DE FIN DE PISTE ---
        if (ev.name === "idle-active" && ev.data === true) {
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

    await mpvLoadFile(handle, directUrl, false);
    await mpvPause(handle, state.control.paused);
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
function handleEndOfTrack(item: QueueItem, onStateChange: () => void) {
  if (item.status === "playing") {
    
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
    
    setTimeout(() => {
      ensurePlayerLoop(onStateChange);
    }, 100);
  }
}

/* ------------------- BOUCLE DE PLAYLIST COMPLÈTE ------------------- */

export async function ensurePlayerLoop(onStateChange: () => void): Promise<void> {
  // 1. Verrouillage
  if (isLooping) return;

  // 2. Vérification MPV
  if (playing && (!globalMpvHandle || globalMpvHandle.proc.exitCode !== null)) {
    console.warn("[player] MPV est mort pendant la lecture, nettoyage...");
    setPlaying(null);
    state.now = null;
  }

  // 3. Si on joue déjà, on ne fait rien
  if (playing && playing.item.status === "playing") return;

  isLooping = true;

  try {
    // 4. Recherche du prochain morceau "queued"
    const nextItem = state.queue.find(q => q.status === "queued");

    if (!nextItem) {
      state.now = null;
      setPlaying(null);
      onStateChange();
      return;
    }

    // --- OPTIMISATION : PRE-PROBE (Pré-chargement) ---
    // On regarde s'il y a un morceau APRES celui qu'on va lancer
    // et on lance son analyse YT-DLP tout de suite en arrière-plan.
    const followUpItem = state.queue.find(q => q.status === "queued" && q.id !== nextItem.id);
    if (followUpItem) {
      console.log(`[player] 🔮 Pré-analyse : ${followUpItem.title}`);
      // On ignore le catch, c'est du bonus, ça ne doit pas bloquer la lecture
      probeSingle(normalizeUrl(followUpItem.url)).catch(() => {});
    }
    // -------------------------------------------------

    console.log(`[player] 🎵 Prochain titre : ${nextItem.title}`);

    // 5. Initialisation visuelle
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

    // 6. Enrichissement (Titre/Cover)
    probeSingle(url).then(info => {
      if (state.now && playing?.item.id === nextItem.id) {
        state.now.title = info.title;
        state.now.thumb = info.thumb || state.now.thumb;
        state.now.durationSec = info.durationSec;
        onStateChange();
      }
    }).catch(() => {});

    // 7. Tentative 1
    let success = await tryPlayWith(url, nextItem, onStateChange);

    // 8. Tentative 2 (Direct URL via yt-dlp)
    if (!success) {
      console.log(`[player] Tentative de secours pour : ${nextItem.title}`);
      const direct = await getDirectPlayableUrl(url).catch(() => null);
      if (direct) {
        success = await tryPlayWith(direct, nextItem, onStateChange);
      }
    }

    // 9. Gestion échec
    if (!success) {
      console.error(`[player] ❌ Échec définitif : ${nextItem.title}`);
      nextItem.status = "error";
      state.now = null;
      setPlaying(null);
      onStateChange();
      
      setTimeout(() => {
        isLooping = false; 
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
    
    state.now = null;
    setPlaying(null);
    onStateChange();

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