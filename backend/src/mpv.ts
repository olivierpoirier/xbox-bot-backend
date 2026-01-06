import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";

/* ------------------- TYPES ------------------- */

export type MpvEvent =
  | { type: "file-loaded" }
  | { type: "playback-restart" }
  | { type: "property-change"; name: string; data: unknown };

export type MpvHandle = {
  proc: ChildProcess;
  sock: net.Socket;
  send: (cmd: unknown) => Promise<void>;
  kill: () => void;
  on: (fn: (ev: MpvEvent) => void) => () => void; // Retourne une fonction pour unbind
  waitForPlaybackStart: (timeoutMs?: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------- UTILS ------------------- */

function findPlayerBinary(): string {
  const bin = (process.env.MPV_BIN || "").trim();
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
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    
    // 1. VOLUME : On descend à 80. 
    // La Xbox applique son propre gain dans les groupes. 
    // À 100, la console sature le signal avant même que tu l'entendes.
    "--volume=80",
    
    `--input-ipc-server=${ipcPath}`,
    "--ytdl-format=bestaudio/best",
    "--ytdl=yes",
    
    // --- LE NETTOYAGE CRUCIAL ---
    // aresample=resampler=soxr : On utilise le meilleur algorithme de conversion au monde (SoX).
    // lowpass=f=15000 : On coupe un peu plus bas (15kHz) car le codec Xbox ne gère pas bien 
    // les fréquences au-delà, ce qui cause le grichage des aigus.
    // loudnorm : On stabilise le tout avec une marge de sécurité (TP=-3).
    "--af=aresample=resampler=soxr,lowpass=f=15000,loudnorm=I=-20:TP=-3:LRA=7",
    
    // --- RÉGLAGES SYSTÈME XBOX ---
    "--audio-samplerate=48000",
    "--audio-format=s16", 
    "--audio-channels=stereo",
    
    // --- STABILITÉ FLUX ---
    "--audio-buffer=0.8",             // Un buffer sous la seconde pour éviter le décalage
    "--cache=yes",
    "--demuxer-max-bytes=128MiB",
    "--audio-stream-silence=yes",
    "--idle=yes",
    "--keep-open=no",

    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  ];

  if (process.platform === "win32") {
    args.push("--ao=wasapi");
  }

  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) {
    args.push(`--audio-device=${audioDevice}`);
  }

  const rawOpts = ["force-ipv4=", "extractor-args=youtube:player_client=android", "no-check-certificate="];
  args.push(`--ytdl-raw-options=${rawOpts.join(",")}`);

  return args;
}

async function connectIpc(pipePath: string, proc: ChildProcess, timeoutMs = 5000): Promise<net.Socket> {
  const start = Date.now();
  let delay = 20;

  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`MPV est mort (code: ${proc.exitCode})`);
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
  throw new Error("Impossible de se connecter à l'IPC mpv");
}

/* ------------------- CORE ------------------- */

export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\xmb_ipc_${id}` : `/tmp/xmb_mpv_${id}.sock`;

  try { if (process.platform !== "win32" && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath); } catch {}

  const args = [...buildAudioArgs(ipcPath)];

  if (url && url.trim().length > 0) {
    args.push(url);
  }
  
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  // Ajoute ces logs juste après :
  proc.stderr?.on("data", (data) => {
    console.error(`[MPV-STDERR] ${data.toString()}`);
  });

  proc.stdout?.on("data", (data) => {
    console.log(`[MPV-STDOUT] ${data.toString()}`);
  });


  let sock: net.Socket;
  try {
    sock = await connectIpc(ipcPath, proc);
  } catch (e) {
    if (proc.pid) proc.kill("SIGKILL");
    throw e;
  }

  let started = false;
  let startReject: ((e: any) => void) | null = null;
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

  // Abonnement aux propriétés essentielles
  await send({ command: ["observe_property", 1, "duration"] });
  await send({ command: ["observe_property", 2, "idle-active"] });
  await send({ command: ["observe_property", 3, "time-pos"] });

  const kill = () => {
    listeners.clear();
    try { sock.destroy(); } catch {}
    if (proc.pid) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", proc.pid.toString(), "/f", "/t"]);
      else proc.kill("SIGKILL");
    }
  };

  proc.once("exit", () => { try { sock.destroy(); } catch {} });

  return {
    proc, sock, send, kill,
    on: (fn) => { 
      listeners.add(fn); 
      return () => listeners.delete(fn); 
    },
    waitForPlaybackStart: (timeoutMs = 20000) => {
      if (started) return Promise.resolve();
      return new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error(`Timeout mpv ${timeoutMs}ms`)), timeoutMs);
        startResolve = () => { clearTimeout(to); res(); };
        startReject = (e) => { clearTimeout(to); rej(e); };
      });
    },
  };
}

/* ------------------- COMMANDES SÉCURISÉES ------------------- */

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