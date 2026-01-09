import { spawn, exec } from "child_process";
import { promisify } from "util";
import play from "play-dl";

const execAsync = promisify(exec);

export type ResolvedItem = {
  url: string;
  title: string;
  thumb?: string;
  durationSec: number;
};

export type ProbeResult = {
  title: string;
  thumb?: string;
  durationSec: number;
};

// --- CACHE ---
type CacheVal<T> = { v: T; exp: number };
const PROBE_CACHE = new Map<string, CacheVal<ProbeResult>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
const DIRECT_CACHE = new Map<string, CacheVal<string>>();

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

export function normalizeUrl(u: string): string {
  if (!u) return "";
  const low = u.toLowerCase();
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

/* --------------- SPOTIFY RESOLVER OPTIMISÉ --------------- */

export async function resolveSpotify(url: string): Promise<ResolvedItem[]> {
  try {
    if (play.is_expired()) await play.refreshToken();

    const data = await play.spotify(url);
    
    const trackToItem = async (t: any): Promise<ResolvedItem> => {
       const artist = t.artists[0]?.name || "";
       const title = t.name;
       const query = `${artist} - ${title}`;
       const targetDuration = t.durationInSec || 0;

       // On récupère 10 résultats pour avoir un plus large choix de comparaison
       const searches = await play.search(query, { limit: 10, source: { youtube: "video" } });
       
       if (searches.length === 0) {
         return {
           url: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
           title: `${artist} - ${title}`,
           durationSec: targetDuration
         };
       }

       // --- SYSTÈME DE SCORE PAR MOTS-CLÉS ---
       // On prépare la liste des mots importants (minuscules, sans ponctuation)
       const searchWords = query.toLowerCase().split(/[\s\-\(\)\[\]]+/).filter(w => w.length > 1);

       const sorted = searches.sort((a, b) => {
          const titleA = (a.title || "").toLowerCase();
          const titleB = (b.title || "").toLowerCase();

          // On compte combien de mots de la recherche sont présents dans le titre YouTube
          const scoreA = searchWords.reduce((acc, word) => acc + (titleA.includes(word) ? 1 : 0), 0);
          const scoreB = searchWords.reduce((acc, word) => acc + (titleB.includes(word) ? 1 : 0), 0);

          // 1. Priorité absolue : celui qui a le plus de mots correspondants (ex: "DIO")
          if (scoreA !== scoreB) {
            return scoreB - scoreA; 
          }

          // 2. Si le score est identique, on utilise la durée comme juge de paix
          const diffA = Math.abs((a.durationInSec || 0) - targetDuration);
          const diffB = Math.abs((b.durationInSec || 0) - targetDuration);
          return diffA - diffB;
       });

       const bestMatch = sorted[0];

       return {
         url: bestMatch.url,
         title: `${artist} - ${title}`,
         thumb: t.thumbnail?.url || bestMatch.thumbnails[0]?.url,
         durationSec: targetDuration 
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
  const cached = cacheGet(FLAT_CACHE, normalized);
  if (cached) return cached;

  if (isSpotifyUrl(normalized)) return await resolveSpotify(normalized);

  // Détection SoundCloud, YouTube Playlist, etc.
  if (normalized.includes("list=") || normalized.includes("/playlist") || normalized.includes("/sets/") || normalized.includes("soundcloud.com")) {
    const isSoundCloud = normalized.includes("soundcloud.com");
    const args = ["-J", "--flat-playlist", "--no-warnings", "--no-check-certificates"];
    const j = await runYtDlpJson(args, normalized);
    
    if (j && j.entries) {
      const items: ResolvedItem[] = j.entries
        .filter((e: any) => e !== null)
        .map((e: any) => {
          const thumb = e.thumbnail || (e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : j.thumbnail);
          let finalTitle = e.title || "Titre inconnu";
          const artist = e.uploader || e.artist || j.uploader;
          
          if (artist && !finalTitle.toLowerCase().includes(artist.toLowerCase())) {
            finalTitle = `${artist} - ${finalTitle}`;
          }

          // Correction URL : Si yt-dlp ne donne que l'ID, on reconstruit l'URL complète
          let finalUrl = e.url || e.webpage_url;
          if (finalUrl && !finalUrl.startsWith('http')) {
             finalUrl = isSoundCloud ? `https://soundcloud.com/${e.id}` : `https://www.youtube.com/watch?v=${e.id}`;
          }

          return {
            url: finalUrl || `https://www.youtube.com/watch?v=${e.id}`,
            title: finalTitle,
            thumb: thumb,
            durationSec: Number(e.duration) || 0
          };
        });
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

  // 1. Cas spécifique YouTube (Rapide via play-dl)
  if (play.yt_validate(url) === "video") {
    try {
      // On utilise video_info pour obtenir des détails plus profonds
      const info = await play.video_info(url);
      const res: ProbeResult = {
        title: info.video_details.title || "Titre inconnu",
        thumb: info.video_details.thumbnails[info.video_details.thumbnails.length - 1]?.url,
        durationSec: info.video_details.durationInSec || 0
      };

      // Tentative de récupération du flux direct pour le DIRECT_CACHE
      // On utilise stream_from_info car c'est plus performant quand on a déjà l'objet 'info'
      play.stream_from_info(info, { quality: 2 }).then(stream => {
        // Assertion 'as any' pour accéder à l'URL car l'interface TS de play-dl la cache
        const directUrl = (stream as any).url;
        if (directUrl) {
          cacheSet(DIRECT_CACHE, url, directUrl);
        }
      }).catch(() => {});

      cacheSet(PROBE_CACHE, url, res);
      return res;
    } catch (e) {
      console.warn(`[ytdlp] play-dl échoué pour ${url}, basculement sur yt-dlp.`);
    }
  }

  // 2. Cas général (yt-dlp) - Gère SoundCloud, Twitch, et les erreurs YouTube
  try {
    /** * On demande le JSON complet. 
     * L'option --format "bestaudio/best" force yt-dlp à trouver l'URL directe 
     * que MPV pourra lire instantanément.
     */
    const { stdout } = await execAsync(
      `${findYtDlpBinary()} --simulate --print-json --format "bestaudio/best" --no-warnings "${url}"`
    );
    const data = JSON.parse(stdout);

    // Extraction et mise en cache de l'URL directe
    if (data.url) {
      cacheSet(DIRECT_CACHE, url, data.url);
    }

    const res: ProbeResult = {
      title: data.title || "Signal inconnu",
      thumb: data.thumbnail || (data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : undefined),
      durationSec: Number(data.duration) || 0
    };

    cacheSet(PROBE_CACHE, url, res);
    return res;
  } catch (err) {
    console.error(`[ytdlp] Erreur de probing sur ${url}:`, err);
    // Retour par défaut pour ne pas bloquer la file d'attente
    return { 
      title: "Lien externe", 
      durationSec: 0,
      thumb: undefined
    };
  }
}

export async function getDirectPlayableUrl(url: string): Promise<string | null> {
  const cached = cacheGet(DIRECT_CACHE, url);
  if (cached) return cached;
  
  try {
    const { stdout } = await execAsync(`${findYtDlpBinary()} -g -f "bestaudio/best" "${url}"`);
    const direct = stdout.trim();
    if (direct) cacheSet(DIRECT_CACHE, url, direct);
    return direct;
  } catch { return null; }
}