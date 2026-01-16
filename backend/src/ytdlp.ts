import { spawn } from "child_process";
import play from "play-dl";
import { YTDLP_CONFIG } from "./config";
import { ProbeResult, ResolvedItem } from "./types";

/* ------------------- CACHE ------------------- */
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

/* --------------- YT-DLP SPANNER (Sécurisé) --------------- */

async function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP_CONFIG.bin, [...YTDLP_CONFIG.extraArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err || `Exit code ${code}`));
    });
  });
}

/* --------------- SPOTIFY (FAST RESOLVE) --------------- */

/**
 * Optimisation : On ne cherche PAS sur YouTube ici.
 * On crée juste un "placeholder" que player.ts résoudra au dernier moment.
 */
export async function resolveSpotify(url: string): Promise<ResolvedItem[]> {
  try {
    if (play.is_expired()) await play.refreshToken();
    const data = await play.spotify(url);

    const trackToPlaceholder = (t: any): ResolvedItem => {
      const artist = t.artists?.[0]?.name || "";
      const title = t.name;
      const query = `${artist} - ${title}`;
      return {
        // Préfixe spécial pour que player.ts sache qu'il faut chercher
        url: `provider:spotify:${query}`, 
        title: title,
        thumb: t.thumbnail?.url || null,
        durationSec: t.durationInSec || 0
      };
    };

    if (data instanceof play.SpotifyTrack) return [trackToPlaceholder(data)];
    if (data instanceof play.SpotifyAlbum || data instanceof play.SpotifyPlaylist) {
      const tracks = await data.all_tracks();
      return tracks.slice(0, 200).map(t => trackToPlaceholder(t));
    }
    return [];
  } catch (e) {
    console.error("[ytdlp] Spotify Error:", e);
    return [];
  }
}

/* --------------- INTERFACE PUBLIQUE --------------- */

export async function resolveUrlToPlayableItems(url: string): Promise<ResolvedItem[]> {
  const normalized = normalizeUrl(url);
  
  // 1. Cache
  const cached = cacheGet(FLAT_CACHE, normalized);
  if (cached) return cached;

  // 2. Spotify (Ultra rapide avec les placeholders)
  if (normalized.includes("spotify.com")) {
    const items = await resolveSpotify(normalized);
    cacheSet(FLAT_CACHE, normalized, items);
    return items;
  }

  // 3. Playlists (YouTube / SoundCloud)
  if (normalized.includes("list=") || normalized.includes("/playlist") || normalized.includes("/sets/")) {
    try {
      const json = await runYtDlp(["--flat-playlist", "-J", normalized]);
      const data = JSON.parse(json);
      if (data.entries) {
        const items = data.entries.map((e: any) => ({
          url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ""),
          title: e.title || "Titre inconnu",
          thumb: e.thumbnail || (e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : null),
          durationSec: Number(e.duration) || 0
        })).filter((i: any) => i.url);
        cacheSet(FLAT_CACHE, normalized, items);
        return items;
      }
    } catch (e) {
      console.error("[ytdlp] Playlist error:", e);
    }
  }

  // 4. Single
  const single = await probeSingle(normalized);
  return [{ ...single, url: normalized }];
}

export async function probeSingle(url: string): Promise<ProbeResult> {
  // Ignorer les placeholders
  if (url.startsWith("provider:")) return { title: url.split(":").pop() || "Track", durationSec: 0 };

  const cached = cacheGet(PROBE_CACHE, url);
  if (cached) return cached;

  // Priorité play-dl (plus rapide que spawn yt-dlp)
  if (play.yt_validate(url) === "video") {
    try {
      const info = await play.video_info(url);
      const res = {
        title: info.video_details.title || "YouTube Video",
        thumb: info.video_details.thumbnails.pop()?.url || null,
        durationSec: info.video_details.durationInSec || 0
      };
      cacheSet(PROBE_CACHE, url, res);
      return res;
    } catch {}
  }

  // Fallback yt-dlp
  try {
    const json = await runYtDlp(["--simulate", "--print-json", url]);
    const data = JSON.parse(json);
    const res = {
      title: data.title || "Lien externe",
      thumb: data.thumbnail || null,
      durationSec: Number(data.duration) || 0
    };
    if (data.url) cacheSet(DIRECT_CACHE, url, data.url);
    cacheSet(PROBE_CACHE, url, res);
    return res;
  } catch {
    return { title: "Morceau inconnu", durationSec: 0 };
  }
}

export async function getDirectPlayableUrl(url: string): Promise<string | null> {
  if (url.startsWith("provider:")) return null;

  const cached = cacheGet(DIRECT_CACHE, url);
  if (cached) return cached;
  
  try {
    const direct = await runYtDlp(["-g", "-f", "bestaudio/best", url]);
    if (direct) cacheSet(DIRECT_CACHE, url, direct);
    return direct;
  } catch {
    return null;
  }
}