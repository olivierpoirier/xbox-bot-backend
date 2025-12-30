//mpv.ts
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";
import play from "play-dl";

export type MpvEvent =
  | { type: "file-loaded" }
  | { type: "playback-restart" }
  | { type: "property-change"; name: string; data: unknown };

export type MpvHandle = {
  proc: ChildProcess;
  sock: net.Socket;
  send: (cmd: unknown) => Promise<void>;
  kill: () => void;

  on: (fn: (ev: MpvEvent) => void) => void;
  waitForPlaybackStart: (timeoutMs?: number) => Promise<void>;
};

const DEFAULT_VOLUME = 70; // volume fixe
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findPlayerBinary(): string {
  const bin = (process.env.MPV_BIN || "").trim();
  if (bin) return bin;

  const ok = (cmd: string): boolean => {
    try {
      return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  };
  if (ok("mpv")) return "mpv";
  if (ok("mpvnet")) return "mpvnet";
  throw new Error("mpv introuvable. Installe mpv/mpv.net ou renseigne MPV_BIN.");
}

function splitArgs(str: string): string[] {
  const m = str.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!m) return [];
  return m.map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}

function buildAudioArgs(ipcPath: string): string[] {
  const args: string[] = [
    "--no-video",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    `--volume=${DEFAULT_VOLUME}`,
    `--input-ipc-server=${ipcPath}`,

    // 🔒 Tes réglages qui marchent (NE PAS TOUCHER)
    "--ytdl-format=bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "--ytdl=yes",

    // ✨ LES SEULS AJOUTS POUR LA QUALITÉ (Xbox)
    "--ao=wasapi",               // Utilise le moteur audio natif Xbox/Windows
    "--audio-pitch-correction=yes", // Évite les distorsions si le flux varie
    "--gapless-audio=yes",        // Transitions fluides
    "--cache=yes",                  // Activer le cache pour éviter les micro-coupures
    "--demuxer-max-bytes=128MiB",   // Buffer de 128Mo
    "--demuxer-readahead-secs=30",  // Lire 30s en avance
  ];

  // ========== Device audio (inchangé) ==========
  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) {
    args.push(`--audio-device=${audioDevice}`);
  }

  // ========== Buffer audio (inchangé) ==========
  const bufEnv = (process.env.MPV_AUDIO_BUFFER_SECS || "").trim();
  const bufVal = bufEnv ? Number(bufEnv) : 2;
  if (Number.isFinite(bufVal) && bufVal >= 0 && bufVal <= 10) {
    args.push(`--audio-buffer=${bufVal}`);
  }

  // ========== Qualité de sortie (inchangé) ==========
  const samplerate = (process.env.MPV_AUDIO_SAMPLERATE || "48000").trim();
  if (/^\d+$/.test(samplerate)) {
    args.push(`--audio-samplerate=${samplerate}`);
  }

  const channels = (process.env.MPV_AUDIO_CHANNELS || "stereo").trim();
  if (channels) {
    args.push(`--audio-channels=${channels}`);
  }

  const ao = (process.env.MPV_AO || "").trim();
  if (ao) {
    args.push(`--ao=${ao}`);
  }

  // ========== DRC / normalisation (inchangé) ==========
  const enableDRC = (process.env.MPV_ENABLE_DRC || "").trim() === "1";
  if (enableDRC) {
    // Ton filtre dynaudnorm d'origine
    args.push("--af-add=lavfi=[dynaudnorm=g=5:f=250:r=0.9:p=0.5]");
  }

  const normalizeDownmix = (process.env.MPV_AUDIO_NORMALIZE_DOWNMIX || "").trim();
  if (normalizeDownmix === "yes" || normalizeDownmix === "no") {
    args.push(`--audio-normalize-downmix=${normalizeDownmix}`);
  }

  // ========== YTDL raw options (RETOUR À TON ORIGINAL) ==========
  const rawOpts: string[] = [];
  rawOpts.push("force-ipv4=");
  rawOpts.push("extractor-args=youtube:player_client=android"); // Ton réglage stable
  if (rawOpts.length > 0) {
    args.push(`--ytdl-raw-options=${rawOpts.join(",")}`);
  }

  // ========== Options additionnelles (inchangé) ==========
  const extra = splitArgs(process.env.MPV_ADDITIONAL_OPTS || "");
  args.push(...extra);

  return args;
}


async function connectIpc(pipePath: string, timeoutMs = 20000): Promise<net.Socket> {
  const start = Date.now();
  let delay = 10;
  let lastErr: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const sock = net.connect(pipePath as any);
      await new Promise<void>((res, rej) => {
        sock.once("connect", () => res());
        sock.once("error", rej);
      });
      return sock;
    } catch (e) {
      lastErr = e;
      await wait(delay);
      delay = Math.min(Math.floor(delay * 1.5), 100);
    }
  }
  console.error("[mpv] IPC timeout", lastErr);
  throw new Error("IPC mpv timeout", { cause: lastErr as any });
}

function lineReader(sock: net.Socket, onLine: (l: string) => void) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(6).toString("hex");
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xmb_mpv_${Date.now()}_${id}`
      : `/tmp/xmb_mpv_${Date.now()}_${id}.sock`;

  try {
    if (process.platform !== "win32") fs.unlinkSync(ipcPath);
  } catch {}

  const args = [...buildAudioArgs(ipcPath), url];

  console.log("[mpv] spawn", bin, args.join(" "));
  const stdioMode: ("ignore" | "inherit")[] = ["ignore", "inherit", "inherit"];

  const proc = spawn(bin, args, { stdio: stdioMode });
  proc.on("error", (e) => console.error("[mpv] proc error:", e));
  proc.on("exit", (code, sig) => console.log("[mpv] proc exit", { code, sig }));

  const sock = await connectIpc(ipcPath);
  sock.on("error", (e) => console.error("[mpv] socket error:", e));

  const listeners: Array<(ev: MpvEvent) => void> = [];
  const on = (fn: (ev: MpvEvent) => void) => listeners.push(fn);
  const emit = (ev: MpvEvent) => {
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error("[mpv] listener error", e);
      }
    }
  };

  const send = (cmd: unknown) =>
    new Promise<void>((resolve) => {
      if (!sock || (sock as any).writableEnded || sock.destroyed) return resolve();
      const payload = JSON.stringify(cmd) + "\n";
      try {
        sock.write(payload, () => resolve());
      } catch {
        return resolve();
      }
    });

  await send({ command: ["observe_property", 1, "duration"] });
  await send({ command: ["observe_property", 2, "idle-active"] });
  await send({ command: ["observe_property", 3, "time-pos"] });

  let started = false;
  let startReject: ((e: any) => void) | null = null;
  let startResolve: (() => void) | null = null;

  const startedPromise = new Promise<void>((res, rej) => {
    startResolve = res;
    startReject = rej;
  });

  lineReader(sock, (line) => {
    try {
      const obj = JSON.parse(line);

      if (obj?.event === "file-loaded") {
        emit({ type: "file-loaded" });
      }
      if (obj?.event === "playback-restart") {
        if (!started) {
          started = true;
          startResolve?.();
        }
        emit({ type: "playback-restart" });
      }
      if (obj?.event === "property-change" && typeof obj.name === "string") {
        emit({ type: "property-change", name: obj.name, data: obj.data });
        if (obj.name === "time-pos" && !started && typeof obj.data === "number") {
          started = true;
          startResolve?.();
        }
        if (obj.name === "idle-active" && obj.data === true && !started) {
          console.error("[mpv] idle-active before start (unavailable media?)");
          startReject?.(new Error("idle-before-start"));
        }
      }
    } catch {
      // ignore
    }
  });

  const kill = () => {
    try {
      sock.destroy();
    } catch {}
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  proc.once("exit", () => {
    try {
      sock.destroy();
    } catch {}
  });
  proc.once("error", () => {
    try {
      sock.destroy();
    } catch {}
  });

  return {
    proc,
    sock,
    send,
    kill,
    on,
    waitForPlaybackStart: (timeoutMs: number = 15000) => {
      if (started) return Promise.resolve();
      let to: NodeJS.Timeout | null = null;
      return new Promise<void>((resolve, reject) => {
        const doneOk = () => {
          if (to) clearTimeout(to);
          resolve();
        };
        const doneKo = (e: any) => {
          if (to) clearTimeout(to);
          reject(e);
        };
        startResolve = doneOk;
        startReject = doneKo;
        to = setTimeout(() => {
          console.error("[mpv] start timeout after", timeoutMs, "ms");
          doneKo(new Error("start-timeout"));
        }, timeoutMs);
      });
    },
  };
}

export async function mpvPause(h: MpvHandle, on: boolean): Promise<void> {
  try {
    await h.send({ command: ["set_property", "pause", on] });
  } catch (e) {
    console.error("[mpv] pause error:", e);
  }
}

export async function mpvQuit(h: MpvHandle): Promise<void> {
  try {
    await h.send({ command: ["quit"] });
  } catch (e) {
    console.error("[mpv] quit error:", e);
  }
}

export async function mpvSetLoopFile(h: MpvHandle, on: boolean): Promise<void> {
  try {
    await h.send({ command: ["set_property", "loop-file", on ? "inf" : "no"] });
  } catch (e) {
    console.error("[mpv] loop-file error:", e);
  }
}

export async function mpvSeekAbsolute(h: MpvHandle, seconds: number): Promise<void> {
  try {
    await h.send({ command: ["set_property", "time-pos", Math.max(0, seconds)] });
  } catch (e) {
    console.error("[mpv] seek abs error:", e);
  }
}

export async function mpvSeekRelative(h: MpvHandle, deltaSeconds: number): Promise<void> {
  try {
    await h.send({ command: ["seek", deltaSeconds, "relative+exact"] });
  } catch (e) {
    console.error("[mpv] seek rel error:", e);
  }
}

export async function mpvLoadFile(h: MpvHandle, url: string, append: boolean = false): Promise<void> {
  const mode = append ? "append" : "replace";
  try {
    await h.send({ command: ["loadfile", url, mode] });
  } catch (e) {
    console.error("[mpv] loadfile error:", e);
  }
}
