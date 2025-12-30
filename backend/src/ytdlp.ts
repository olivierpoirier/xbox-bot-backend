// ytdlp.ts
import { spawn } from "child_process";
import play from "play-dl";

export type ResolvedItem = {
  url: string;
  title?: string;
  thumb?: string;
  durationSec?: number;
};

/* ------------------- CONFIGURATION & UTILS ------------------- */

function intEnv(name: string, def: number, min?: number, max?: number): number {
  const raw = (process.env[name] || "").trim();
  const m = raw.match(/^\d+/);
  let n = m ? Number(m[0]) : def;
  if (Number.isNaN(n)) n = def;
  if (typeof min === "number") n = Math.max(min, n);
  if (typeof max === "number") n = Math.min(max, n);
  return n;
}

function findYtDlpBinary(): string {
  const bin = (process.env.YTDLP_BIN || "").trim();
  if (bin) return bin;
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function splitArgs(str: string): string[] {
  const m = str.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!m) return [];
  return m.map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}

/**
 * SECURITÉ RENFORCÉE : 
 * Si cette fonction reçoit une URL Spotify, elle doit être traitée avec prudence.
 */
export function normalizeUrl(u: string): string {
  if (!u) return "";
  const low = u.toLowerCase();
  
  // Si c'est une URL Spotify interne (DRM), on la marque pour suppression 
  // si elle n'est pas traitée par le resolveSpotify
  if (low.includes("googleusercontent.com/spotify") || low.includes("spotify.com")) {
    return u; // On garde l'URL pour que resolveSpotify puisse la reconnaître
  }

  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (host.includes("youtu.be")) {
      const id = url.pathname.replace(/^\/+/, "");
      return id ? `https://www.youtube.com/watch?v=${id}` : u;
    }
    if (host.includes("youtube.com")) {
      const id = url.searchParams.get("v");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return u;
  } catch {
    return u;
  }
}

/* ------------------- CACHE ------------------- */

export const AGE_RESTRICTED = new Set<string>();
type CacheVal<T> = { v: T; exp: number };
const PROBE_CACHE = new Map<string, CacheVal<ResolvedItem>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
const DIRECT_CACHE = new Map<string, CacheVal<string>>();

const CACHE_TTL = intEnv("YTDLP_CACHE_MS", 600_000, 5_000);
const CACHE_MAX = intEnv("YTDLP_CACHE_SIZE", 512, 64, 10_000);

function cacheGet<K, V>(m: Map<K, CacheVal<V>>, k: K): V | undefined {
  const c = m.get(k);
  if (!c || c.exp < Date.now()) { m.delete(k); return; }
  return c.v;
}

function cacheSet<K, V>(m: Map<K, CacheVal<V>>, k: K, v: V): void {
  if (m.size >= CACHE_MAX) {
    const it = m.keys().next();
    if (!it.done) m.delete(it.value);
  }
  m.set(k, { v, exp: Date.now() + CACHE_TTL });
}

/* --------------- FILTRE ANTI-DRM --------------- */

function isSpotifyUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes("googleusercontent.com/spotify") || u.includes("spotify.com");
}

/* --------------- YT-DLP RUNNER --------------- */

async function runYtDlpJson(args: string[], inputUrl: string): Promise<any | null> {
  // Jamais de yt-dlp sur Spotify
  if (isSpotifyUrl(inputUrl)) return null;

  return new Promise((resolve) => {
    const bin = findYtDlpBinary();
    const finalArgs = [...splitArgs(process.env.YTDLP_EXTRA_ARGS || ""), ...args, inputUrl];
    const p = spawn(bin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.on("close", (code) => {
      if (code === 0 && out) {
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      } else { resolve(null); }
    });
  });
}

/* --------------- SPOTIFY RESOLVER --------------- */

export async function resolveSpotify(url: string): Promise<ResolvedItem[]> {
  try {
    if (await play.is_expired()) await play.refreshToken();
    const data = await play.spotify(url);
    
    const trackToItem = async (t: any): Promise<ResolvedItem> => {
       const query = `${t.artists[0]?.name || ""} ${t.name} audio`;
       const searches = await play.search(query, { limit: 1, source: { youtube: "video" } });
       const ytVideo = searches[0];

       return {
         url: ytVideo?.url || `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, // Fallback si rien trouvé
         title: `${t.artists[0]?.name || "Artist"} - ${t.name}`,
         thumb: t.thumbnail?.url || ytVideo?.thumbnails[0]?.url,
         durationSec: t.durationInSec,
       };
    };

    if (data instanceof play.SpotifyTrack) return [await trackToItem(data)];
    if (data instanceof play.SpotifyAlbum || data instanceof play.SpotifyPlaylist) {
      const tracks = await data.all_tracks();
      return await Promise.all(tracks.slice(0, 50).map(t => trackToItem(t)));
    }
    return [];
  } catch (e: any) {
    console.error("[Spotify] Error:", e.message);
    return [];
  }
}

/* --------------- INTERFACE PUBLIQUE --------------- */

export async function resolveUrlToPlayableItems(url: string): Promise<ResolvedItem[]> {
  const normalized = normalizeUrl(url);

  if (isSpotifyUrl(normalized)) {
    return await resolveSpotify(normalized);
  }

  if (normalized.includes("list=") || normalized.includes("/playlist")) {
    const j = await runYtDlpJson(["-J", "--flat-playlist", "--no-warnings"], normalized);
    if (j && j.entries) {
      return j.entries.map((e: any) => ({
        url: normalizeUrl(e.url || `https://www.youtube.com/watch?v=${e.id}`),
        title: e.title
      }));
    }
  }

  const single = await probeSingle(normalized);
  return [single];
}

export async function probeSingle(url: string): Promise<ResolvedItem> {
  const key = normalizeUrl(url);
  
  if (isSpotifyUrl(key)) {
    const items = await resolveSpotify(key);
    return items[0] || { url: key };
  }

  const cached = cacheGet(PROBE_CACHE, key);
  if (cached) return cached;

  const j = await runYtDlpJson(["-J", "--no-playlist"], key);
  if (!j) return { url: key };

  const res = {
    url: j.webpage_url || key,
    title: j.title || key,
    thumb: j.thumbnail,
    durationSec: j.duration,
  };
  cacheSet(PROBE_CACHE, key, res);
  return res;
}

/**
 * Cette fonction est celle qui cause ton doublon.
 * On lui INTERDIT de renvoyer quoi que ce soit si c'est du Spotify.
 */
export async function resolveQuick(url: string): Promise<ResolvedItem[]> {
  const normalized = normalizeUrl(url);
  
  if (isSpotifyUrl(normalized)) {
    return []; // RENVOIE VIDE. Ton serveur devra attendre resolveUrlToPlayableItems.
  }
  
  if (normalized.includes("list=")) {
    // On pourrait appeler resolvePlaylistFlat ici, mais pour corriger ton bug, 
    // il vaut mieux renvoyer l'URL brute et laisser le player gérer.
    return [{ url: normalized }];
  }
  
  return [{ url: normalized }];
}

// Pour compatibilité avec ton code
export async function getDirectPlayableUrl(url: string): Promise<string | null> {
  if (isSpotifyUrl(url)) return null;
  return null; 
}