import { spawn } from "child_process";

export type ResolvedItem = {
  url: string;
  title?: string;
  thumb?: string;
  durationSec?: number;
};

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

/* ------------------- Normalisation URL ------------------- */
export function normalizeUrl(u: string): string {
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

/* ------------------- Age restriction tracking ------------------- */
export const AGE_RESTRICTED = new Set<string>();

/* ------------------- LRU Cache ------------------- */
type CacheVal<T> = { v: T; exp: number };
const PROBE_CACHE = new Map<string, CacheVal<ResolvedItem>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
const DIRECT_CACHE = new Map<string, CacheVal<string>>();

const CACHE_TTL = intEnv("YTDLP_CACHE_MS", 600_000, 5_000);
const CACHE_MAX = intEnv("YTDLP_CACHE_SIZE", 512, 64, 10_000);

function cacheGet<K, V>(m: Map<K, CacheVal<V>>, k: K): V | undefined {
  const c = m.get(k);
  if (!c) return;
  if (c.exp < Date.now()) {
    m.delete(k);
    return;
  }
  m.delete(k);
  m.set(k, c);
  return c.v;
}
function cacheSet<K, V>(m: Map<K, CacheVal<V>>, k: K, v: V): void {
  if (m.size >= CACHE_MAX) {
    const it = m.keys().next();
    if (!it.done) m.delete(it.value);
  }
  m.set(k, { v, exp: Date.now() + CACHE_TTL });
}

/* --------------- yt-dlp runners (sans cookies) --------------- */
function runYtDlpJson(args: string[], inputUrl: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const bin = findYtDlpBinary();
    const extra = splitArgs(process.env.YTDLP_EXTRA_ARGS || "");
    const finalArgs = [...extra, ...args, inputUrl];
    const timeoutMs = intEnv("YTDLP_TIMEOUT_MS", 20_000, 3_000, 120_000);

    const p = spawn(bin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    console.log("[ytdlp] spawn JSON:", bin, finalArgs.join(" "));

    let out = "";
    let err = "";
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(to);
      if (timedOut) {
        console.warn(`[ytdlp] JSON timeout after ${timeoutMs}ms for`, inputUrl);
        return resolve(null);
      }

      if (code === 0 && out) {
        try {
          const parsed = JSON.parse(out) as unknown;
          return resolve(parsed);
        } catch (e) {
          console.error("[ytdlp] JSON parse error:", e);
          return resolve(null);
        }
      } else {
        // 🔎 Analyse du stderr pour détecter le 18+
        const lower = (err || "").toLowerCase();
        if (
          lower.includes("age-restricted") ||
          lower.includes("confirm your age") ||
          lower.includes("sign in to confirm your age")
        ) {
          const key = normalizeUrl(inputUrl);
          AGE_RESTRICTED.add(key);
          console.warn("[ytdlp] marked as age-restricted:", key);
        }

        if (code !== 0 || err) {
          console.error("[ytdlp] JSON failed:", {
            code,
            err: err?.slice(0, 400),
          });
        }
        return resolve(null);
      }
    });
  });
}

function runYtDlpRaw(args: string[], inputUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = findYtDlpBinary();
    const extra = splitArgs(process.env.YTDLP_EXTRA_ARGS || "");
    const finalArgs = [...extra, ...args, inputUrl];
    const timeoutMs = intEnv("YTDLP_TIMEOUT_MS", 20_000, 3_000, 120_000);

    const p = spawn(bin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    console.log("[ytdlp] spawn RAW:", bin, finalArgs.join(" "));

    let out = "";
    let err = "";
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(to);
      if (timedOut) {
        console.warn(`[ytdlp] RAW timeout after ${timeoutMs}ms for`, inputUrl);
        return resolve(null);
      }

      if (code === 0) {
        return resolve(out.trim());
      } else {
        const lower = (err || "").toLowerCase();
        if (
          lower.includes("age-restricted") ||
          lower.includes("confirm your age") ||
          lower.includes("sign in to confirm your age")
        ) {
          const key = normalizeUrl(inputUrl);
          AGE_RESTRICTED.add(key);
          console.warn("[ytdlp] marked as age-restricted (RAW):", key);
        }

        if (code !== 0 || err) {
          console.error("[ytdlp] RAW failed:", {
            code,
            err: err?.slice(0, 400),
          });
        }
        return resolve(null);
      }
    });
  });
}

/* --------------- Déduplication des probes --------------- */
const PENDING = new Map<string, Promise<ResolvedItem>>();

/* --------------- Direct URL (fallback) --------------- */
export async function getDirectPlayableUrl(url: string): Promise<string | null> {
  const key = normalizeUrl(url);
  const c = cacheGet(DIRECT_CACHE, key);
  if (c) return c;

  try {
    const raw = await runYtDlpRaw(["-g", "-f", "bestaudio/best", "--no-warnings"], key);
    if (!raw) return null;
    const first = raw
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim();
    if (first) {
      cacheSet(DIRECT_CACHE, key, first);
      return first;
    }
  } catch (e) {
    console.error("[ytdlp] getDirectPlayableUrl error:", e);
  }
  return null;
}

export async function probeSingle(url: string): Promise<ResolvedItem> {
  const key = normalizeUrl(url);
  const c = cacheGet(PROBE_CACHE, key);
  if (c) return c;

  const pend = PENDING.get(key);
  if (pend) return pend;

  const p = (async () => {
    const jUnknown = await runYtDlpJson(["-J", "--no-playlist", "--no-warnings"], key);
    if (!jUnknown || typeof jUnknown !== "object") {
      console.warn("[ytdlp] probeSingle: no JSON for", url);
      const fallback: ResolvedItem = { url: key };
      cacheSet(PROBE_CACHE, key, fallback);
      return fallback;
    }

    const j = jUnknown as Record<string, unknown>;

    const pageUrl = typeof j["webpage_url"] === "string" ? (j["webpage_url"] as string) : key;

    let thumb: string | undefined =
      typeof j["thumbnail"] === "string" ? (j["thumbnail"] as string) : undefined;

    if (!thumb && Array.isArray(j["thumbnails"])) {
      const thumbs = j["thumbnails"] as unknown[];
      for (let i = thumbs.length - 1; i >= 0; i--) {
        const t = thumbs[i];
        if (
          t &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>)["url"] === "string"
        ) {
          thumb = (t as Record<string, unknown>)["url"] as string;
          break;
        }
      }
    }

    const title =
      typeof j["title"] === "string"
        ? (j["title"] as string)
        : pageUrl.split("/").pop() || pageUrl;

    const durationSec =
      typeof j["duration"] === "number" && Number.isFinite(j["duration"])
        ? (j["duration"] as number)
        : undefined;

    const res: ResolvedItem = {
      url: normalizeUrl(pageUrl),
      title,
      thumb,
      durationSec,
    };
    cacheSet(PROBE_CACHE, key, res);
    return res;
  })()
    .catch((e) => {
      console.error("[ytdlp] probeSingle error:", e, "url:", url);
      const fallback: ResolvedItem = { url: key };
      cacheSet(PROBE_CACHE, key, fallback);
      return fallback;
    })
    .finally(() => PENDING.delete(key));

  PENDING.set(key, p);
  return p;
}

/* --------------- Playlist flat --------------- */
async function resolvePlaylistFlat(url: string): Promise<ResolvedItem[]> {
  const key = normalizeUrl(url);
  const c = cacheGet(FLAT_CACHE, key);
  if (c) return c;

  const jUnknown = await runYtDlpJson(["-J", "--flat-playlist", "--no-warnings"], key);
  if (!jUnknown || typeof jUnknown !== "object") {
    console.warn("[ytdlp] resolvePlaylistFlat: no JSON for", url);
    cacheSet(FLAT_CACHE, key, []);
    return [];
  }
  const j = jUnknown as Record<string, unknown>;

  const entries = Array.isArray(j["entries"]) ? (j["entries"] as unknown[]) : [];
  const results: ResolvedItem[] = [];

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;

    let u =
      (typeof o["url"] === "string" && (o["url"] as string)) ||
      (typeof o["webpage_url"] === "string" && (o["webpage_url"] as string)) ||
      key;

    const id = typeof o["id"] === "string" ? (o["id"] as string) : undefined;
    if (id && (!u || !/^https?:\/\//i.test(u))) {
      u = `https://www.youtube.com/watch?v=${id}`;
    }

    const title = typeof o["title"] === "string" ? (o["title"] as string) : undefined;
    results.push({ url: normalizeUrl(u), title });
  }

  cacheSet(FLAT_CACHE, key, results);
  return results;
}

/* --------------- Heuristique single vs playlist --------------- */
function looksLikeSingle(input: string): boolean {
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      if (u.searchParams.has("list")) return false;
      if (u.pathname.includes("/playlist")) return false;
      return true;
    }
    return true;
  } catch {
    return true;
  }
}

/* --------------- Résolution rapide --------------- */
export async function resolveQuick(url: string): Promise<ResolvedItem[]> {
  if (looksLikeSingle(url)) return [{ url: normalizeUrl(url) }];
  try {
    const flat = await resolvePlaylistFlat(url);
    if (flat.length > 0) return flat;
  } catch (e) {
    console.error("[ytdlp] resolveQuick flat error:", e);
  }
  return [{ url: normalizeUrl(url) }];
}

/* --------------- Résolution complète --------------- */
export async function resolveUrlToPlayableItems(url: string): Promise<ResolvedItem[]> {
  // On ne garde maxConc que si on décide de l'utiliser plus tard, 
  // mais pour l'instant on veut éviter le probing de masse.
  // const maxConc = intEnv("YTDLP_MAX_CONCURRENCY", 5, 1, 16);

  try {
    // 1. On tente la récupération rapide ("flat")
    const flat = await resolvePlaylistFlat(url);
    
    if (flat.length > 0) {
      // OPTIMISATION MAJEURE ICI :
      // Avant : On faisait un `mapLimit` pour probe chaque item (Lent + Risque 429)
      // Maintenant : On retourne direct la liste (URL + Titre).
      // Le backend (server.ts) se chargera de charger les thumbnails un par un via le prefetch.
      console.log(`[ytdlp] Playlist detected: ${flat.length} items. Returning flat list immediately.`);
      return flat;
    }
  } catch (e) {
    console.warn("[ytdlp] Flat resolve failed, fallback single:", e);
  }

  // 2. Si ce n'est pas une playlist (ou si flat a échoué), on probe l'URL unique
  // Là on veut le détail complet tout de suite pour lancer la lecture.
  try {
    const one = await probeSingle(url);
    return [one];
  } catch (e) {
    console.error("[ytdlp] Single probe failed:", e);
    return [];
  }
}
