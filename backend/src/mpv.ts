// src/mpv.ts
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";
import { MPV_CONFIG } from "./config";
import { MpvEvent, MpvHandle } from "./types";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------- UTILS ------------------- */

function findPlayerBinary(): string {
  const bin = MPV_CONFIG.bin;
  if (bin) return bin;

  const ok = (cmd: string): boolean => {
    try {
      return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
    } catch { return false; }
  };
  
  if (ok("mpv")) return "mpv";
  if (ok("mpvnet")) return "mpvnet";
  throw new Error("mpv introuvable.");
}

function buildAudioArgs(ipcPath: string): string[] {
  const args: string[] = [
    ...MPV_CONFIG.baseArgs,
    `--input-ipc-server=${ipcPath}`,
    `--af=${MPV_CONFIG.audioFilters}`,
    `--user-agent=${MPV_CONFIG.userAgent}`,
    `--ytdl-raw-options=${MPV_CONFIG.ytdlRawOptions.join(",")}`,
    "--ytdl-format=bestaudio/best",
    "--ytdl=yes"
  ];

  if (process.platform === "win32") args.push("--ao=wasapi");
  if (MPV_CONFIG.audioDevice) args.push(`--audio-device=${MPV_CONFIG.audioDevice}`);

  return args;
}

/* ------------------- CORE ------------------- */

export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\xmb_ipc_${id}` : `/tmp/xmb_mpv_${id}.sock`;

  try { if (process.platform !== "win32" && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath); } catch {}

  const args = [...buildAudioArgs(ipcPath)];
  if (url?.trim()) args.push(url);
  
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let sock: net.Socket;
  try {
    sock = await connectIpc(ipcPath, proc);
  } catch (e) {
    if (proc.pid) proc.kill("SIGKILL");
    throw e;
  }

  let started = false;
  let startResolve: (() => void) | null = null;
  const listeners = new Set<(ev: MpvEvent) => void>();

  const emit = (ev: MpvEvent) => {
    listeners.forEach(fn => { try { fn(ev); } catch {} });
  };

  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.event === "file-loaded") emit({ type: "file-loaded" });
        if (obj?.event === "playback-restart") {
          if (!started) { started = true; startResolve?.(); }
          emit({ type: "playback-restart" });
        }
        if (obj?.event === "property-change" && typeof obj.name === "string") {
          emit({ type: "property-change", name: obj.name, data: obj.data });
          if ((obj.name === "time-pos" || obj.name === "duration") && !started && typeof obj.data === "number") {
            started = true; startResolve?.();
          }
        }
      } catch {}
    }
  });

  const send = (cmd: unknown) => new Promise<void>((resolve) => {
    if (!sock || sock.destroyed || !sock.writable) return resolve();
    try { sock.write(JSON.stringify(cmd) + "\n", () => resolve()); } catch { resolve(); }
  });

  await send({ command: ["observe_property", 1, "duration"] });
  await send({ command: ["observe_property", 2, "idle-active"] });
  await send({ command: ["observe_property", 3, "time-pos"] });

  return {
    proc, sock, send, 
    kill: () => {
      listeners.clear();
      try { sock.destroy(); } catch {}
      if (proc.pid) {
        if (process.platform === "win32") spawn("taskkill", ["/pid", proc.pid.toString(), "/f", "/t"]);
        else proc.kill("SIGKILL");
      }
    },
    on: (fn) => { 
      listeners.add(fn); 
      return () => listeners.delete(fn); 
    },
    waitForPlaybackStart: (timeoutMs = MPV_CONFIG.globalStartTimeoutMs) => {
      if (started) return Promise.resolve();
      return new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error(`Timeout mpv ${timeoutMs}ms`)), timeoutMs);
        startResolve = () => { clearTimeout(to); res(); };
      });
    },
  };
}

async function connectIpc(pipePath: string, proc: ChildProcess, timeoutMs = MPV_CONFIG.ipcConnectTimeoutMs): Promise<net.Socket> {
  const start = Date.now();
  let delay = 20;
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error("MPV exit");
    try {
      const sock = net.connect(pipePath as any);
      await new Promise<void>((res, rej) => {
        sock.once("connect", () => { sock.removeAllListeners("error"); res(); });
        sock.once("error", rej);
      });
      return sock;
    } catch {
      await wait(delay);
      delay = Math.min(delay * 1.5, 200);
    }
  }
  throw new Error("IPC Timeout");
}

/* ------------------- COMMANDES ------------------- */
async function safeSend(h: MpvHandle, cmd: any, context: string) {
  if (!h.sock || h.sock.destroyed || !h.sock.writable) return;
  try { await h.send(cmd); } catch (e) { console.error(`[mpv] ${context} error:`, e); }
}

export const mpvPause = (h: MpvHandle, on: boolean) => safeSend(h, { command: ["set_property", "pause", on] }, "pause");
export const mpvStop = (h: MpvHandle) => safeSend(h, { command: ["stop"] }, "stop");
export const mpvQuit = (h: MpvHandle) => safeSend(h, { command: ["quit"] }, "quit");
export const mpvSetLoopFile = (h: MpvHandle, on: boolean) => safeSend(h, { command: ["set_property", "loop-file", on ? "inf" : "no"] }, "loop");
export const mpvSeekAbsolute = (h: MpvHandle, sec: number) => safeSend(h, { command: ["set_property", "time-pos", Math.max(0, sec)] }, "seek");
export const mpvLoadFile = (h: MpvHandle, url: string, append = false) => safeSend(h, { command: ["loadfile", url, append ? "append" : "replace"] }, "load");