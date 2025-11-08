// mpv.ts
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";

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
  waitForPlaybackStart: () => Promise<void>;
};

const DEFAULT_VOLUME = 70; // 🔒 volume fixé côté MPV, aucune API côté serveur/front
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findPlayerBinary(): string {
  const bin = (process.env.MPV_BIN || "").trim();
  if (bin) return bin;

  const ok = (cmd: string): boolean => {
    try { return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0; }
    catch { return false; }
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
    `--volume=${DEFAULT_VOLUME}`,              // ✅ volume figé à 70%
    `--input-ipc-server=${ipcPath}`,
    "--ytdl-format=bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "--ytdl=yes",
  ];

  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) {
    args.push(`--audio-device=${audioDevice}`);
    if (process.env.MPV_VERBOSE === "1") {
      console.log("[mpv] audio-device =", audioDevice);
    }
  }

  const bufEnv = (process.env.MPV_AUDIO_BUFFER_SECS || "").trim();
  const bufVal = bufEnv ? Number(bufEnv) : 2;
  if (Number.isFinite(bufVal) && bufVal >= 0 && bufVal <= 10) {
    args.push(`--audio-buffer=${bufVal}`);
  }

  const ytdlpPath = (process.env.YTDLP_BIN || "").trim();
  if (ytdlpPath) {
    const quoted = ytdlpPath.includes(" ") ? `"${ytdlpPath}"` : ytdlpPath;
    args.push(`--script-opts=ytdl_hook-ytdl_path=${quoted}`);
  }

  const raw: string[] = [];
  raw.push("force-ipv4=");
  raw.push("extractor-args=youtube:player_client=android");
  args.push(`--ytdl-raw-options=${raw.join(",")}`);

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
  throw new Error("IPC mpv timeout", { cause: lastErr });
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

  try { if (process.platform !== "win32") fs.unlinkSync(ipcPath); } catch {}

  const args = [...buildAudioArgs(ipcPath), url];

  if (process.env.MPV_VERBOSE === "1") {
    console.log("[mpv] spawn", bin, args.join(" "));
  }

  const stdioMode: ("ignore" | "inherit")[] =
    process.env.MPV_VERBOSE === "1" ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"];

  const proc = spawn(bin, args, { stdio: stdioMode });
  const sock = await connectIpc(ipcPath);

  const listeners: Array<(ev: MpvEvent) => void> = [];
  const on = (fn: (ev: MpvEvent) => void) => listeners.push(fn);
  const emit = (ev: MpvEvent) => { for (const fn of listeners) { try { fn(ev); } catch {} } };

  const send = (cmd: unknown) =>
    new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify(cmd) + "\n";
      const ok = sock.write(payload, (err) => (err ? reject(err) : resolve()));
      if (!ok && process.env.MPV_VERBOSE === "1") {
        console.log("[mpv] backpressure (drain pending)");
      }
    });

  // Observe properties
  await send({ command: ["observe_property", 1, "duration"] });
  await send({ command: ["observe_property", 2, "idle-active"] });
  await send({ command: ["observe_property", 3, "time-pos"] });

  let started = false;
  let startedResolver: (() => void) | null = null;
  const startedPromise = new Promise<void>((res) => (startedResolver = res));

  lineReader(sock, (line) => {
    try {
      const obj = JSON.parse(line);

      if (obj?.event === "file-loaded") {
        emit({ type: "file-loaded" });
      }
      if (obj?.event === "playback-restart") {
        if (!started) { started = true; startedResolver?.(); }
        emit({ type: "playback-restart" });
      }
      if (obj?.event === "property-change" && typeof obj.name === "string") {
        emit({ type: "property-change", name: obj.name, data: obj.data });
        if (obj.name === "time-pos" && !started && typeof obj.data === "number") {
          started = true; startedResolver?.();
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  });

  const kill = () => { try { sock.destroy(); } catch {}; try { proc.kill("SIGKILL"); } catch {} };
  proc.once("exit", () => { try { sock.destroy(); } catch {} });
  proc.once("error", () => { try { sock.destroy(); } catch {} });

  return { proc, sock, send, kill, on, waitForPlaybackStart: () => startedPromise };
}

export async function mpvPause(h: MpvHandle, on: boolean): Promise<void> {
  await h.send({ command: ["set_property", "pause", on] });
}

export async function mpvQuit(h: MpvHandle): Promise<void> {
  await h.send({ command: ["quit"] });
}
export async function mpvSetLoopFile(h: MpvHandle, on: boolean): Promise<void> {
  await h.send({ command: ["set_property", "loop-file", on ? "inf" : "no"] });
}
export async function mpvSeekAbsolute(h: MpvHandle, seconds: number): Promise<void> {
  await h.send({ command: ["set_property", "time-pos", Math.max(0, seconds)] });
}
export async function mpvSeekRelative(h: MpvHandle, deltaSeconds: number): Promise<void> {
  await h.send({ command: ["seek", deltaSeconds, "relative+exact"] });
}
export async function mpvLoadFile(h: MpvHandle, url: string, append: boolean = false): Promise<void> {
  const mode = append ? "append" : "replace";
  await h.send({ command: ["loadfile", url, mode] });
}
