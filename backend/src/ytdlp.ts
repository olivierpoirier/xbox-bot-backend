// src/ytdlp.ts
import { spawn, exec } from "child_process";
import { promisify } from "util";
import play from "play-dl";
import { YTDLP_CONFIG } from "./config";
import { ProbeResult, ResolvedItem } from "./types";

const execAsync = promisify(exec);

/* ------------------- CACHE (Utilise YTDLP_CONFIG) ------------------- */
type CacheVal<T> = { v: T; exp: number };
const PROBE_CACHE = new Map<string, CacheVal<ProbeResult>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
const DIRECT_CACHE = new Map<string, CacheVal<string>>();

function cacheGet<K, V>(m: Map<K, CacheVal<V>>, k: K): V | undefined {
  const c = m.get(k);
  if (!c || c.exp < Date.now()) { m.delete(k); return; }
  return c.v;
}

function cacheSet<K, V>(m: Map<K, CacheVal<V>>, k: K, v: V): void {
  if (m.size >= YTDLP_CONFIG.cacheMax) {
    const it = m.keys().next();
    if (!it.done) m.delete(it.value);
  }
  m.set(k, { v, exp: Date.now() + YTDLP_CONFIG.cacheTTL });
}

/* ------------------- UTILS ------------------- */

export function normalizeUrl(u: string): string {
  if (!u) return "";
  const low = u.toLowerCase();
  // Gestion spécifique des URLs déjà traitées ou internes
  if (low.includes("googleusercontent.com") || low.includes("spotify.com")) return u;
  
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
  } catch { return u; }
}

function isSpotifyUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes("spotify.com") || u.includes("googleusercontent.com/spotify");
}

/* --------------- YT-DLP RUNNER --------------- */

async function runYtDlpJson(args: string[], inputUrl: string): Promise<any | null> {
  if (isSpotifyUrl(inputUrl)) return null;
  return new Promise((resolve) => {
    // On utilise le binaire et les arguments de la config
    const bin = YTDLP_CONFIG.bin;
    const finalArgs = [...YTDLP_CONFIG.extraArgs, ...args, inputUrl];
    
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
    // play.setToken est déjà appelé dans server.ts, on vérifie juste l'expiration
    if (play.is_expired()) await play.refreshToken();

    const data = await play.spotify(url);
    
    const trackToItem = async (t: any): Promise<ResolvedItem> => {
       const artist = t.artists[0]?.name || "";
       const title = t.name;
       const query = `${artist} - ${title}`;
       const targetDuration = t.durationInSec || 0;

       // Recherche YouTube pour trouver le meilleur match
       const searches = await play.search(query, { limit: 5, source: { youtube: "video" } });
       
       if (searches.length === 0) {
         return {
           url: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, // Fallback
           title: query,
           durationSec: targetDuration
         };
       }

       // Scoring simple : mots-clés + proximité de durée
       const searchWords = query.toLowerCase().split(/[\s\-]+/).filter(w => w.length > 1);
       const bestMatch = searches.sort((a, b) => {
          const scoreA = searchWords.reduce((acc, w) => acc + (a.title?.toLowerCase().includes(w) ? 1 : 0), 0);
          const scoreB = searchWords.reduce((acc, w) => acc + (b.title?.toLowerCase().includes(w) ? 1 : 0), 0);
          if (scoreA !== scoreB) return scoreB - scoreA;
          return Math.abs((a.durationInSec || 0) - targetDuration) - Math.abs((b.durationInSec || 0) - targetDuration);
       })[0];

       return {
         url: bestMatch.url,
         title: query,
         thumb: t.thumbnail?.url || bestMatch.thumbnails[0]?.url,
         durationSec: targetDuration 
       };
    };

    if (data instanceof play.SpotifyTrack) return [await trackToItem(data)];
    if (data instanceof play.SpotifyAlbum || data instanceof play.SpotifyPlaylist) {
      const tracks = await data.all_tracks();
      // On limite à 100 morceaux pour éviter de saturer les APIs
      return await Promise.all(tracks.slice(0, 100).map(t => trackToItem(t)));
    }
    return [];
  } catch (e: any) {
    console.error("[ytdlp] Spotify Error:", e.message);
    return [];
  }
}

/* --------------- INTERFACE PUBLIQUE --------------- */

export async function resolveUrlToPlayableItems(url: string): Promise<ResolvedItem[]> {
  const normalized = normalizeUrl(url);
  const cached = cacheGet(FLAT_CACHE, normalized);
  if (cached) return cached;

  if (isSpotifyUrl(normalized)) return await resolveSpotify(normalized);

  // Détection Playlists (YouTube, SoundCloud, etc.)
  if (normalized.includes("list=") || normalized.includes("/playlist") || normalized.includes("/sets/") || normalized.includes("soundcloud.com")) {
    const args = ["-J", "--flat-playlist", "--no-warnings"];
    const j = await runYtDlpJson(args, normalized);
    
    if (j && j.entries) {
      const items: ResolvedItem[] = j.entries
        .filter((e: any) => e !== null)
        .map((e: any) => ({
            url: e.url || (e.id ? (normalized.includes("soundcloud") ? `https://soundcloud.com/${e.id}` : `https://www.youtube.com/watch?v=${e.id}`) : ""),
            title: e.title || "Titre inconnu",
            thumb: e.thumbnail,
            durationSec: Number(e.duration) || 0
        })).filter((i: any) => i.url);

      cacheSet(FLAT_CACHE, normalized, items);
      return items;
    }
  }

  const single = await probeSingle(normalized);
  return [{ ...single, url: normalized }];
}

export async function probeSingle(url: string): Promise<ProbeResult> {
  const cached = cacheGet(PROBE_CACHE, url);
  if (cached) return cached;

  // 1. YouTube rapide via play-dl
  if (play.yt_validate(url) === "video") {
    try {
      const info = await play.video_info(url);
      const res: ProbeResult = {
        title: info.video_details.title || "YouTube Video",
        thumb: info.video_details.thumbnails.pop()?.url,
        durationSec: info.video_details.durationInSec || 0
      };
      cacheSet(PROBE_CACHE, url, res);
      return res;
    } catch { /* fallback to yt-dlp */ }
  }

  // 2. Cas général via yt-dlp
  try {
    const { stdout } = await execAsync(
      `"${YTDLP_CONFIG.bin}" --simulate --print-json --format "bestaudio/best" "${url}"`
    );
    const data = JSON.parse(stdout);

    if (data.url) cacheSet(DIRECT_CACHE, url, data.url);

    const res: ProbeResult = {
      title: data.title || "Lien externe",
      thumb: data.thumbnail,
      durationSec: Number(data.duration) || 0
    };

    cacheSet(PROBE_CACHE, url, res);
    return res;
  } catch (err) {
    return { title: "Morceau inconnu", durationSec: 0 };
  }
}

export async function getDirectPlayableUrl(url: string): Promise<string | null> {
  const cached = cacheGet(DIRECT_CACHE, url);
  if (cached) return cached;
  
  try {
    const { stdout } = await execAsync(`"${YTDLP_CONFIG.bin}" -g -f "bestaudio/best" "${url}"`);
    const direct = stdout.trim();
    if (direct) cacheSet(DIRECT_CACHE, url, direct);
    return direct;
  } catch { return null; }
}