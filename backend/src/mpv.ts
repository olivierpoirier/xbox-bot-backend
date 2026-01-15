import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";
import { EventEmitter } from "events";
import { MPV_CONFIG } from "./config";
import { MpvEvent } from "./types";

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
  throw new Error("❌ Exécutable MPV introuvable. Vérifiez votre installation ou votre fichier .env");
}

function buildAudioArgs(ipcPath: string): string[] {
  const args: string[] = [
    ...MPV_CONFIG.baseArgs,
    `--input-ipc-server=${ipcPath}`,
    `--user-agent=${MPV_CONFIG.userAgent}`,
    "--msg-level=all=v", 
  ];

  if (MPV_CONFIG.audioFilters) {
    args.push(`--af=${MPV_CONFIG.audioFilters}`);
  }

  args.push(`--ytdl-raw-options=${MPV_CONFIG.ytdlRawOptions.join(",")}`);
  args.push("--ytdl-format=bestaudio/best");
  args.push("--ytdl=yes");

  if (process.platform === "win32") {
    args.push("--ao=wasapi");
  }
  
  if (MPV_CONFIG.audioDevice && MPV_CONFIG.audioDevice.trim() !== "") {
    args.push(`--audio-device=${MPV_CONFIG.audioDevice}`);
  }

  return args;
}

/* ------------------- CLASS DEFINITION ------------------- */

/**
 * Interface étendue pour garder la compatibilité avec ton code existant
 * tout en bénéficiant de EventEmitter
 */
export class MpvInstance extends EventEmitter {
  public proc: ChildProcess;
  public sock: net.Socket | null = null;
  public started = false;
  
  private ipcPath: string;
  private buffer = "";
  private startResolve: (() => void) | null = null;
  private lastLogs: string[] = [];

  constructor(proc: ChildProcess, ipcPath: string) {
    super();
    this.proc = proc;
    this.ipcPath = ipcPath;
    this.setupProcessListeners();
  }

  /**
   * Initialise la connexion Socket IPC
   */
  public async initialize(): Promise<void> {
    try {
      this.sock = await this.connectIpc();
      this.setupSocketListeners();
      
      // Configuration initiale des observateurs
      await this.send({ command: ["observe_property", 1, "duration"] });
      await this.send({ command: ["observe_property", 2, "idle-active"] });
      await this.send({ command: ["observe_property", 3, "time-pos"] });
    } catch (e) {
      this.handleCrash();
      throw e;
    }
  }

  /**
   * Méthode de compatibilité pour ton player.ts
   * Permet d'écouter tous les événements typés via une seule callback
   * Retourne une fonction de nettoyage (dispose)
   */
  public onEvent(fn: (ev: MpvEvent) => void): () => void {
    const wrapper = (arg: any) => fn(arg);
    this.on("mpv-event", wrapper);
    return () => this.off("mpv-event", wrapper);
  }

  /**
   * Envoi d'une commande JSON brute à MPV
   */
  public send(cmd: Record<string, any>): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.sock || this.sock.destroyed || !this.sock.writable) return resolve();
      try { 
        this.sock.write(JSON.stringify(cmd) + "\n", () => resolve()); 
      } catch { 
        resolve(); 
      }
    });
  }

  /**
   * Arrêt propre
   */
  public kill() {
    this.removeAllListeners();
    try { 
      if (this.sock) {
        this.sock.destroy(); 
        this.sock = null;
      }
    } catch {}

    if (this.proc.pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", this.proc.pid.toString(), "/f", "/t"]);
      } else {
        this.proc.kill("SIGKILL");
      }
    }
  }

  /**
   * Attend que la lecture commence réellement
   */
  public waitForPlaybackStart(timeoutMs = MPV_CONFIG.globalStartTimeoutMs): Promise<void> {
    if (this.started) return Promise.resolve();
    
    return new Promise<void>((res, rej) => {
      const to = setTimeout(() => {
        this.startResolve = null;
        rej(new Error(`Timeout lecture mpv ${timeoutMs}ms`));
      }, timeoutMs);

      this.startResolve = () => { 
        clearTimeout(to); 
        res(); 
      };
    });
  }

  // --- PRIVATE HELPERS ---

  private setupProcessListeners() {
    const capture = (data: Buffer) => {
      const s = data.toString().trim();
      if (!s) return;
      this.lastLogs.push(s);
      if (this.lastLogs.length > 50) this.lastLogs.shift();
      console.log(`[MPV-PROC] ${s}`);
    };

    this.proc.stdout?.on("data", capture);
    this.proc.stderr?.on("data", capture);
    this.proc.on("error", (err) => console.error(`[SYSTEM-ERROR] Impossible de lancer MPV :`, err));
  }

  private setupSocketListeners() {
    if (!this.sock) return;

    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      
      // Traitement ligne par ligne
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || ""; // Garde le fragment incomplet pour le prochain chunk

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.processMessage(JSON.parse(line));
        } catch {}
      }
    });
  }

  private processMessage(obj: any) {
    let eventToEmit: MpvEvent | null = null;

    if (obj?.event === "file-loaded") {
      eventToEmit = { type: "file-loaded" };
    }
    else if (obj?.event === "playback-restart") {
      if (!this.started) { this.started = true; this.startResolve?.(); }
      eventToEmit = { type: "playback-restart" };
    }
    else if (obj?.event === "property-change" && typeof obj.name === "string") {
      eventToEmit = { type: "property-change", name: obj.name, data: obj.data };
      
      // Détection de démarrage alternative
      if ((obj.name === "time-pos" || obj.name === "duration") && !this.started && typeof obj.data === "number") {
        this.started = true; 
        this.startResolve?.();
      }
    }

    if (eventToEmit) {
      // Émet l'événement "générique" pour la compatibilité avec player.ts
      this.emit("mpv-event", eventToEmit);
      
      // Émet aussi des événements spécifiques pour une utilisation plus fine si besoin
      this.emit(eventToEmit.type, eventToEmit);
    }
  }

  private async connectIpc(timeoutMs = MPV_CONFIG.ipcConnectTimeoutMs): Promise<net.Socket> {
    const start = Date.now();
    let delay = 100;
    
    while (Date.now() - start < timeoutMs) {
      if (this.proc.exitCode !== null) throw new Error("MPV a crashé avant connexion IPC");
      
      try {
        const s = net.connect(this.ipcPath as any);
        return await new Promise((res, rej) => {
          s.once("connect", () => { s.removeAllListeners("error"); res(s); });
          s.once("error", (e) => { s.destroy(); rej(e); });
        });
      } catch {
        await wait(delay);
        delay = Math.min(delay * 1.5, 500);
      }
    }
    throw new Error("Timeout connexion IPC MPV");
  }

  private handleCrash() {
    if (this.proc.pid) {
      console.error("\n--- ANALYSE DU CRASH MPV ---");
      console.error(this.lastLogs.slice(-10).join("\n"));
      console.error("-----------------------------\n");
      this.proc.kill("SIGKILL");
    }
  }
}

/* ------------------- CORE FUNCTION ------------------- */

// On définit un type alias pour éviter de casser les imports ailleurs
export type MpvHandle = {
  proc: ChildProcess;
  sock: net.Socket | null;
  send: (cmd: any) => Promise<void>;
  kill: () => void;
  on: (fn: (ev: MpvEvent) => void) => () => void; // Signature compatible old-school
  waitForPlaybackStart: (timeoutMs?: number) => Promise<void>;
};

/**
 * Démarre le moteur MPV et retourne l'instance optimisée
 */
export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\xmb_ipc_${id}` : `/tmp/xmb_mpv_${id}.sock`;

  // Nettoyage socket Linux/Mac
  try { 
    if (process.platform !== "win32" && fs.existsSync(ipcPath)) {
      fs.unlinkSync(ipcPath);
    } 
  } catch {}

  const args = buildAudioArgs(ipcPath);
  if (url?.trim()) args.push(url);
  
  console.log(`[DEBUG] Cmd: ${bin} ${args.join(" ")}`);
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  // Instanciation de la classe optimisée
  const instance = new MpvInstance(proc, ipcPath);
  await instance.initialize();

  // On retourne une structure compatible avec l'interface attendue par player.ts
  // Tout en utilisant la puissance de la classe en dessous.
  return {
    proc: instance.proc,
    sock: instance.sock,
    send: instance.send.bind(instance),
    kill: instance.kill.bind(instance),
    waitForPlaybackStart: instance.waitForPlaybackStart.bind(instance),
    // Mapping crucial : on redirige .on vers notre méthode de compatibilité
    on: instance.onEvent.bind(instance) 
  };
}

/* ------------------- COMMANDES HELPERS ------------------- */

async function safeSend(h: MpvHandle, cmd: any, context: string) {
  // @ts-ignore - Le type MpvHandle défini ci-dessus est compatible structurellement
  if (!h.sock || h.sock.destroyed || !h.sock.writable) return;
  try { await h.send(cmd); } catch (e) { console.error(`[mpv] ${context} error:`, e); }
}

export const mpvPause = (h: MpvHandle, on: boolean) => safeSend(h, { command: ["set_property", "pause", on] }, "pause");
export const mpvStop = (h: MpvHandle) => safeSend(h, { command: ["stop"] }, "stop");
export const mpvQuit = (h: MpvHandle) => safeSend(h, { command: ["quit"] }, "quit");
export const mpvSetLoopFile = (h: MpvHandle, on: boolean) => safeSend(h, { command: ["set_property", "loop-file", on ? "inf" : "no"] }, "loop");
export const mpvSeekAbsolute = (h: MpvHandle, sec: number) => safeSend(h, { command: ["set_property", "time-pos", Math.max(0, sec)] }, "seek");
export const mpvLoadFile = (h: MpvHandle, url: string, append = false) => safeSend(h, { command: ["loadfile", url, append ? "append" : "replace"] }, "load");