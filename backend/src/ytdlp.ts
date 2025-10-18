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

/* ------------------- LRU Cache légère ------------------- */
type CacheVal<T> = { v: T; exp: number };
const PROBE_CACHE = new Map<string, CacheVal<ResolvedItem>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
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

/* --------------- yt-dlp runner --------------- */
function runYtDlp(args: string[], inputUrl: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bin = findYtDlpBinary();
    const extra = splitArgs(process.env.YTDLP_EXTRA_ARGS || "");
    const finalArgs = [...extra, ...args, inputUrl];
    const timeoutMs = intEnv("YTDLP_TIMEOUT_MS", 20_000, 3_000, 120_000);

    const p = spawn(bin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try { p.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(to);
      if (timedOut) return reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`));
      if (code === 0 && out) {
        try {
          resolve(JSON.parse(out) as unknown);
        } catch {
          reject(new Error("yt-dlp JSON parse error"));
        }
      } else {
        reject(new Error(`yt-dlp failed (${code}): ${err || out || "no output"}`));
      }
    });
  });
}

/* --------------- Déduplication des probes en cours --------------- */
const PENDING = new Map<string, Promise<ResolvedItem>>();

export async function probeSingle(url: string): Promise<ResolvedItem> {
  const c = cacheGet(PROBE_CACHE, url);
  if (c) return c;

  const pend = PENDING.get(url);
  if (pend) return pend;

  const p = (async () => {
    const jUnknown = await runYtDlp(["-J", "--no-playlist", "--no-warnings"], url);
    const j = (typeof jUnknown === "object" && jUnknown !== null ? (jUnknown as Record<string, unknown>) : {});

    const pageUrl = typeof j["webpage_url"] === "string" ? (j["webpage_url"] as string) : url;

    let thumb: string | undefined =
      typeof j["thumbnail"] === "string" ? (j["thumbnail"] as string) : undefined;

    if (!thumb && Array.isArray(j["thumbnails"])) {
      const thumbs = j["thumbnails"] as unknown[];
      for (let i = thumbs.length - 1; i >= 0; i--) {
        const t = thumbs[i];
        if (t && typeof t === "object" && typeof (t as Record<string, unknown>)["url"] === "string") {
          thumb = (t as Record<string, unknown>)["url"] as string;
          break;
        }
      }
    }

    const title =
      typeof j["title"] === "string" ? (j["title"] as string) : (pageUrl.split("/").pop() || pageUrl);

    const durationSec =
      typeof j["duration"] === "number" && Number.isFinite(j["duration"]) ? (j["duration"] as number) : undefined;

    const res: ResolvedItem = { url: pageUrl, title, thumb, durationSec };
    cacheSet(PROBE_CACHE, url, res);
    return res;
  })()
    .finally(() => PENDING.delete(url));

  PENDING.set(url, p);
  return p;
}

/* --------------- Flat playlist (rapide) --------------- */
async function resolvePlaylistFlat(url: string): Promise<ResolvedItem[]> {
  const c = cacheGet(FLAT_CACHE, url);
  if (c) return c;

  const jUnknown = await runYtDlp(["-J", "--flat-playlist", "--no-warnings"], url);
  const j = (typeof jUnknown === "object" && jUnknown !== null ? (jUnknown as Record<string, unknown>) : {});

  const entries = Array.isArray(j["entries"]) ? (j["entries"] as unknown[]) : [];
  const results: ResolvedItem[] = [];

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    let u =
      (typeof o["url"] === "string" && (o["url"] as string)) ||
      (typeof o["webpage_url"] === "string" && (o["webpage_url"] as string)) ||
      url;

    const id = typeof o["id"] === "string" ? (o["id"] as string) : undefined;
    if (id && (!u || !/^https?:\/\//i.test(u))) {
      u = `https://www.youtube.com/watch?v=${id}`;
    }
    const title = typeof o["title"] === "string" ? (o["title"] as string) : undefined;
    results.push({ url: u, title });
  }

  cacheSet(FLAT_CACHE, url, results);
  return results;
}

/* --------------- Heuristique “single vs playlist” --------------- */
function looksLikeSingle(input: string): boolean {
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      if (u.searchParams.has("list")) return false;
      if (u.pathname.includes("/playlist")) return false;
      return true;
    }
    // autres plateformes: assume single
    return true;
  } catch {
    return true;
  }
}

/* --------------- Résolution rapide (ne bloque pas) --------------- */
export async function resolveQuick(url: string): Promise<ResolvedItem[]> {
  if (looksLikeSingle(url)) return [{ url }]; // zéro spawn si single évident
  try {
    const flat = await resolvePlaylistFlat(url);
    if (flat.length > 0) return flat;
  } catch {
    // ignore flat errors
  }
  return [{ url }];
}

/* --------------- Résolution complète (avec probes) --------------- */
async function mapLimit<T, R>(
  arr: readonly T[],
  limit: number,
  worker: (t: T, i: number) => Promise<R>
): Promise<readonly (R | null)[]> {
  const results: (R | null)[] = new Array(arr.length).fill(null);
  let i = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = (): void => {
      if (i >= arr.length && active === 0) return resolve(results);
      while (active < limit && i < arr.length) {
        const cur = i++;
        active++;
        worker(arr[cur], cur)
          .then((r) => { results[cur] = r; })
          .catch(() => { results[cur] = null; })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

export async function resolveUrlToPlayableItems(url: string): Promise<ResolvedItem[]> {
  const maxConc = intEnv("YTDLP_MAX_CONCURRENCY", 5, 1, 16);

  try {
    const flat = await resolvePlaylistFlat(url);
    if (flat.length > 0) {
      const probed = await mapLimit(flat, maxConc, async (it) => probeSingle(it.url));
      return probed.filter((x): x is ResolvedItem => x !== null);
    }

    try {
      const one = await probeSingle(url);
      return [one];
    } catch {
      return [];
    }
  } catch {
    try {
      const one = await probeSingle(url);
      return [one];
    } catch {
      return [];
    }
  }
}
