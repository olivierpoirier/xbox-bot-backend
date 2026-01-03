import { state, playing, setPlaying, QueueItem } from "./types";
import { startMpv, mpvPause, mpvSetLoopFile } from "./mpv";
import { probeSingle, getDirectPlayableUrl, normalizeUrl } from "./ytdlp";

const START_TIMEOUT_MS = 15000;
let isLooping = false; // Verrou pour empêcher plusieurs boucles en parallèle

export async function tryPlayWith(startUrl: string, item: QueueItem, onStateChange: () => void): Promise<boolean> {
  let handle: any = null;
  let hasExited = false; // Flag pour savoir si le process est mort pendant qu'on l'attendait

  try {
    const cleanUrl = normalizeUrl(startUrl);
    console.log("[player] Tentative lecture :", cleanUrl);

    handle = await startMpv(cleanUrl);
    setPlaying({ item, handle });

    // On écoute la mort du processus
    handle.proc.once("exit", () => {
      hasExited = true; 
      console.log("[player] MPV a quitté (Skip ou Fin)");
      
      // Nettoyage de l'état
      item.status = "done";
      state.now = null;
      setPlaying(null);
      onStateChange();

      // On relance la boucle après un délai pour laisser Windows libérer l'audio
      setTimeout(() => void ensurePlayerLoop(onStateChange), 400);
    });

    // Forcer la lecture pour remplir le buffer
    await mpvPause(handle, false);

    try {
      // On attend que le son commence réellement
      await handle.waitForPlaybackStart(START_TIMEOUT_MS);
      
      // CRUCIAL : Si l'utilisateur a Skip pendant l'attente (hasExited est true), 
      // on s'arrête immédiatement pour ne pas configurer un cadavre.
      if (hasExited) return false;

    } catch (e) {
      if (!hasExited) {
        console.warn("[player] Chargement interrompu ou timeout.");
        if (handle) handle.kill();
      }
      return false;
    }

    // Configuration des événements de durée
    handle.on((ev: any) => {
      if (ev.type === "property-change" && ev.name === "duration" && state.now) {
        const d = typeof ev.data === "number" ? ev.data : null;
        if (d && state.now.durationSec !== d) {
          state.now.durationSec = d;
          onStateChange();
        }
      }
    });

    // Appliquer les réglages
    await mpvPause(handle, state.control.paused);
    await mpvSetLoopFile(handle, state.control.repeat);

    if (state.now) {
      state.now.startedAt = state.control.paused ? null : Date.now();
      state.now.positionOffsetSec = 0;
    }

    onStateChange();
    return true;

  } catch (err) {
    console.error("[player] Erreur tryPlayWith :", err);
    if (handle) handle.kill();
    return false;
  }
}

export async function ensurePlayerLoop(onStateChange: () => void): Promise<void> {
  // Si on joue déjà ou si une boucle est déjà en cours d'initialisation, on stop.
  if (playing || isLooping) return;

  isLooping = true; // On pose le verrou

  try {
    const item = state.queue.find((q) => q.status === "queued");
    if (!item) return;

    const url = normalizeUrl(item.url || "");
    item.status = "playing";

    state.now = {
      url: url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      group: item.group,
      durationSec: item.durationSec || null,
      startedAt: null,
      positionOffsetSec: 0,
    };
    onStateChange();

    // Enrichissement asynchrone
    probeSingle(url).then(info => {
      const currentUrl = state.now?.url;
      if (state.now && currentUrl && normalizeUrl(currentUrl) === url) {
        state.now.title = info.title ?? state.now.title;
        state.now.thumb = info.thumb ?? state.now.thumb;
        state.now.durationSec = info.durationSec ?? state.now.durationSec;
        onStateChange();
      }
    }).catch(() => {});

    // Tentative de lecture
    if (await tryPlayWith(url, item, onStateChange)) return;

    // Fallback si échec
    const direct = await getDirectPlayableUrl(url).catch(() => null);
    if (direct && await tryPlayWith(direct, item, onStateChange)) return;

    // Échec définitif
    console.error("[player] Échec total pour :", url);
    item.status = "error";
    state.now = null;
    setPlaying(null);
    onStateChange();

    setTimeout(() => void ensurePlayerLoop(onStateChange), 1000);
  } finally {
    isLooping = false; // On libère le verrou quoi qu'il arrive
  }
}