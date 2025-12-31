import { state, playing, setPlaying, QueueItem } from "./types";
import { startMpv, mpvPause, mpvSetLoopFile, mpvQuit } from "./mpv";
import { probeSingle, getDirectPlayableUrl, AGE_RESTRICTED, normalizeUrl } from "./ytdlp";

const START_TIMEOUT_MS = 15000;

export async function tryPlayWith(startUrl: string, item: QueueItem, onStateChange: () => void): Promise<boolean> {
  let handle: any = null;
  
  try {
    const cleanUrl = normalizeUrl(startUrl);
    console.log("[player] Tentative lecture :", cleanUrl);
    
    handle = await startMpv(cleanUrl);
    setPlaying({ item, handle });

    // --- CRUCIAL : On écoute la mort du processus dès maintenant ---
    // Si on skip pendant le chargement, ce code s'exécutera.
    handle.proc.once("exit", () => {
      console.log("[player] MPV a quitté (Skip ou Fin)");
      item.status = "done";
      state.now = null;
      setPlaying(null);
      onStateChange();
      // On relance la boucle
      setTimeout(() => void ensurePlayerLoop(onStateChange), 50);
    });

    // Forcer la lecture pour remplir le buffer
    await mpvPause(handle, false); 

    // On attend le début du son (si on Skip ici, handle.proc émet "exit" et l'await rejette)
    try {
      await handle.waitForPlaybackStart(START_TIMEOUT_MS);
    } catch (e) {
      console.warn("[player] Chargement interrompu ou timeout.");
      // On s'assure que le process est mort si c'est un timeout
      if (handle) handle.kill(); 
      return false;
    }

    // Si on arrive ici, le son a commencé. On synchronise l'état.
    handle.on((ev: any) => {
      if (ev.type === "property-change" && ev.name === "duration" && state.now) {
        const d = typeof ev.data === "number" ? ev.data : null;
        if (d && state.now.durationSec !== d) {
          state.now.durationSec = d;
          onStateChange();
        }
      }
    });

    // Appliquer les réglages de l'utilisateur (Pause, Loop)
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
  if (playing) return;

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

  // Enrichissement asynchrone (ne bloque pas le démarrage)
    // 2. Enrichissement asynchrone
    probeSingle(url).then(info => {
    // On vérifie : 
    // 1. Que state.now existe toujours
    // 2. Que son URL est définie
    // 3. Que c'est toujours la même chanson qu'au début de la fonction
    const currentUrl = state.now?.url;

    if (state.now && currentUrl && normalizeUrl(currentUrl) === url) {
        state.now.title = info.title ?? state.now.title;
        state.now.thumb = info.thumb ?? state.now.thumb;
        state.now.durationSec = info.durationSec ?? state.now.durationSec;
        onStateChange();
    }
    }).catch(() => {});

  // Tentative 1 : Lecture
  if (await tryPlayWith(url, item, onStateChange)) return;

  // Tentative 2 : Fallback
  const direct = await getDirectPlayableUrl(url).catch(() => null);
  if (direct && await tryPlayWith(direct, item, onStateChange)) return;

  // Échec définitif pour ce morceau
  console.error("[player] Échec total pour :", url);
  item.status = "error";
  state.now = null;
  setPlaying(null);
  onStateChange();
  
  setTimeout(() => void ensurePlayerLoop(onStateChange), 1000);
}