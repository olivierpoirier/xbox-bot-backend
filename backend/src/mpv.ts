import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";
import { MPV_CONFIG } from "./config";
import { MpvEvent, MpvHandle } from "./types";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------- UTILS ------------------- */

/**
 * Tente de trouver l'exécutable MPV
 */
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
  throw new Error("❌ Exécutable MPV introuvable. Vérifiez votre installation ou votre fichier .env");
}

/**
 * Construit les arguments pour le lancement de MPV
 */
function buildAudioArgs(ipcPath: string): string[] {
  const args: string[] = [
    ...MPV_CONFIG.baseArgs,
    `--input-ipc-server=${ipcPath}`,
    `--user-agent=${MPV_CONFIG.userAgent}`,
    // On force un niveau de log verbeux pour voir les erreurs d'initialisation audio
    "--msg-level=all=v", 
  ];

  if (MPV_CONFIG.audioFilters) {
    args.push(`--af=${MPV_CONFIG.audioFilters}`);
  }

  // Options yt-dlp
  args.push(`--ytdl-raw-options=${MPV_CONFIG.ytdlRawOptions.join(",")}`);
  args.push("--ytdl-format=bestaudio/best");
  args.push("--ytdl=yes");

  // Sortie audio WASAPI pour Windows
  if (process.platform === "win32") {
    args.push("--ao=wasapi");
  }
  
  if (MPV_CONFIG.audioDevice && MPV_CONFIG.audioDevice.trim() !== "") {
    args.push(`--audio-device=${MPV_CONFIG.audioDevice}`);
  }

  return args;
}

/* ------------------- CORE ------------------- */

/**
 * Démarre le moteur MPV et établit la connexion IPC
 */
export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\xmb_ipc_${id}` : `/tmp/xmb_mpv_${id}.sock`;

  // Nettoyage de l'ancien socket sur Linux/Mac
  try { 
    if (process.platform !== "win32" && fs.existsSync(ipcPath)) {
      fs.unlinkSync(ipcPath);
    } 
  } catch {}

  const args = buildAudioArgs(ipcPath);
  if (url?.trim()) args.push(url);
  
  console.log(`[DEBUG] Commande complète : ${bin} ${args.join(" ")}`);

  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  // --- CAPTURE DES LOGS ---
  const lastLogs: string[] = [];
  const capture = (data: Buffer) => {
    const s = data.toString().trim();
    if (!s) return;
    lastLogs.push(s);
    if (lastLogs.length > 50) lastLogs.shift(); // Garde les 50 dernières lignes
    console.log(`[MPV-PROCESS] ${s}`);
  };

  proc.stdout.on("data", capture);
  proc.stderr.on("data", capture);

  proc.on('error', (err) => {
    console.error(`[SYSTEM-ERROR] Impossible de lancer MPV :`, err);
  });

  let sock: net.Socket;
  try {
    sock = await connectIpc(ipcPath, proc, lastLogs);
  } catch (e) {
    if (proc.pid) {
        console.error("\n--- ANALYSE DU CRASH MPV ---");
        console.error("Derniers messages reçus de MPV :");
        console.error(lastLogs.slice(-10).join("\n"));
        console.error("-----------------------------\n");
        proc.kill("SIGKILL");
    }
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

  // Observation des propriétés pour le tracking de lecture
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
        const to = setTimeout(() => rej(new Error(`Timeout lecture mpv ${timeoutMs}ms`)), timeoutMs);
        startResolve = () => { clearTimeout(to); res(); };
      });
    },
  };
}

/**
 * Gère la connexion au socket IPC avec retry
 */
async function connectIpc(pipePath: string, proc: ChildProcess, lastLogs: string[], timeoutMs = MPV_CONFIG.ipcConnectTimeoutMs): Promise<net.Socket> {
  const start = Date.now();
  let delay = 100;
  
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`MPV Crash (Code ${proc.exitCode}).\nLogs récents:\n${lastLogs.slice(-5).join("\n")}`);
    }
    
    try {
      const sock = net.connect(pipePath as any);
      return await new Promise<net.Socket>((res, rej) => {
        sock.once("connect", () => {
          sock.removeAllListeners("error");
          res(sock);
        });
        sock.once("error", (e) => {
          sock.destroy();
          rej(e);
        });
      });
    } catch {
      await wait(delay);
      delay = Math.min(delay * 1.5, 500);
    }
  }
  throw new Error("Impossible d'établir la connexion IPC avec MPV (Timeout). Vérifiez si MPV est bloqué.");
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