import { spawn } from "child_process";

export type ResolvedItem = {
  url: string;
  title?: string;
  thumb?: string;
  durationSec?: number; // NEW
};

function findYtDlpBinary(): string {
  const bin = (process.env.YTDLP_BIN || "").trim();
  if (bin) return bin;
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function runYtDlp(args: string[], inputUrl: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bin = findYtDlpBinary();
    const p = spawn(bin, [...args, inputUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("close", (code) => {
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

export async function probeSingle(url: string): Promise<ResolvedItem> {
  const jUnknown = await runYtDlp(["-J", "--no-playlist", "--no-warnings"], url);
  const j =
    (typeof jUnknown === "object" && jUnknown !== null ? (jUnknown as Record<string, unknown>) : {});

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

  return { url: pageUrl, title, thumb, durationSec };
}

async function resolvePlaylistFlat(url: string): Promise<ResolvedItem[]> {
  const jUnknown = await runYtDlp(["-J", "--flat-playlist", "--no-warnings"], url);
  const j =
    (typeof jUnknown === "object" && jUnknown !== null ? (jUnknown as Record<string, unknown>) : {});

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
  return results;
}

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
          .then((r) => {
            results[cur] = r;
          })
          .catch(() => {
            results[cur] = null;
          })
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
  try {
    const flat = await resolvePlaylistFlat(url);
    if (flat.length > 0) {
      const probed = await mapLimit(flat, 5, async (it) => probeSingle(it.url));
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
