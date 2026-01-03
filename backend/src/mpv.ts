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

// Dans mpv.ts

function buildAudioArgs(ipcPath: string): string[] {
  const args: string[] = [
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    
    // 🔉 On descend légèrement le volume de base pour laisser de la place au traitement
    `--volume=80`,                
    `--input-ipc-server=${ipcPath}`,

    // 🔒 Formats haute qualité
    "--ytdl-format=bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
    "--ytdl=yes",

    // ✨ Paramètres de sortie
    "--ao=wasapi",
    "--audio-channels=stereo",
    "--audio-samplerate=48000",

    // 🔊 CHAINE DE FILTRES ANTI-SATURATION :
    // 1. dynaudnorm : Équilibre le son pour qu'il soit constant.
    // 2. extrastereo : (Optionnel) Ajoute un peu de largeur si le son fait "étouffé".
    // 3. alimiter : Empêche mathématiquement le son de dépasser 0dB (le grésillement).
    "--af=volume=0.8,dynaudnorm=f=250:g=7:p=0.90:s=30,alimiter=limit=0.85",    
    "--audio-stream-silence=yes",
    "--audio-wait-open=0.1",
    "--cache=yes",
    "--demuxer-max-bytes=128MiB",
    "--audio-buffer=3",
  ];

  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) {
    args.push(`--audio-device=${audioDevice}`);
  }

  const rawOpts: string[] = [
    "force-ipv4=",
    "extractor-args=youtube:player_client=android", // Android a souvent des flux audio plus stables
    "no-check-certificate="
  ];
  args.push(`--ytdl-raw-options=${rawOpts.join(",")}`);

  return args;
}


async function connectIpc(pipePath: string, proc: ChildProcess, timeoutMs = 5000): Promise<net.Socket> {
  const start = Date.now();
  let delay = 20;

  while (Date.now() - start < timeoutMs) {
    // Si le processus mpv est déjà mort, on arrête d'essayer de se connecter
    if (proc.exitCode !== null) {
      throw new Error(`MPV est mort prématurément (exit code: ${proc.exitCode})`);
    }

    try {
      const sock = net.connect(pipePath as any);
      await new Promise<void>((res, rej) => {
        sock.once("connect", () => {
          sock.removeAllListeners("error");
          res();
        });
        sock.once("error", rej);
      });
      return sock;
    } catch (e) {
      await wait(delay);
      delay = Math.min(delay * 1.5, 200);
    }
  }
  throw new Error("IPC mpv timeout");
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
  
  // Utilisation d'un ID court pour le Pipe Windows (plus robuste)
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath = process.platform === "win32"
    ? `\\\\.\\pipe\\xmb_ipc_${id}`
    : `/tmp/xmb_mpv_${id}.sock`;

  // Nettoyage préventif du socket si non-windows
  try {
    if (process.platform !== "win32" && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
  } catch {}

  const args = [...buildAudioArgs(ipcPath), url];

  // Log de démarrage propre
  console.log(`[mpv] 🎵 Démarrage lecture : ${url.substring(0, 60)}...`);
  
  // "ignore" sur stdout/stderr pour éviter la pollution console et les blocages de buffer
  const stdioMode: ("ignore" | "inherit")[] = ["ignore", "ignore", "ignore"];
  const proc = spawn(bin, args, { stdio: stdioMode });

  // --- GESTION DES ÉVÉNEMENTS PROCESSUS ---
  proc.on("error", (e) => console.error("[mpv] Erreur fatale au spawn :", e));
  
  // On ne log le "exit" ici que s'il est anormal au démarrage
  proc.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`[mpv] ❌ Le processus s'est arrêté brutalement (Code: ${code}). Vérifiez votre périphérique audio.`);
    }
  });

  // --- CONNEXION IPC ---
  // On passe 'proc' à connectIpc pour détecter le crash immédiatement (Code 2)
  const sock = await connectIpc(ipcPath, proc);

  const listeners: Array<(ev: MpvEvent) => void> = [];
  const on = (fn: (ev: MpvEvent) => void) => listeners.push(fn);
  
  const emit = (ev: MpvEvent) => {
    for (const fn of listeners) {
      try { fn(ev); } catch (e) { console.error("[mpv] listener error", e); }
    }
  };

  const send = (cmd: unknown) =>
    new Promise<void>((resolve) => {
      if (!sock || sock.destroyed || !sock.writable) return resolve();
      const payload = JSON.stringify(cmd) + "\n";
      try {
        sock.write(payload, () => resolve());
      } catch {
        resolve();
      }
    });

  // --- CONFIGURATION INITIALE VIA IPC ---
  await send({ command: ["observe_property", 1, "duration"] });
  await send({ command: ["observe_property", 2, "idle-active"] });
  await send({ command: ["observe_property", 3, "time-pos"] });

  let started = false;
  let startReject: ((e: any) => void) | null = null;
  let startResolve: (() => void) | null = null;

  // --- LECTURE DES DONNÉES IPC ---
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
        
        // On considère que ça a démarré dès qu'on a une position ou une durée
        if ((obj.name === "time-pos" || obj.name === "duration") && !started && typeof obj.data === "number") {
          started = true;
          startResolve?.();
        }

        // Si mpv devient idle alors qu'on vient de lancer, c'est un échec de lecture
        if (obj.name === "idle-active" && obj.data === true && !started) {
          startReject?.(new Error("idle-before-start"));
        }
      }
    } catch {
      // JSON invalide ou partiel, on ignore
    }
  });

  // --- FONCTION DE NETTOYAGE ---
  const kill = () => {
    // 1. On ferme le socket IPC
    try { sock.destroy(); } catch {}

    // 2. On tue le processus et ses enfants
    if (proc.pid) {
      if (process.platform === "win32") {
        // Force (/f) l'arrêt de l'arbre de processus (/t)
        // C'est la seule façon de tuer MPV + yt-dlp instantanément
        spawn("taskkill", ["/pid", proc.pid.toString(), "/f", "/t"]);
      } else {
        proc.kill("SIGKILL");
      }
    }
  };

  // Sécurité si le process meurt tout seul
  proc.once("exit", () => { 
    try { sock.destroy(); } catch {} 
  });

  return {
    proc,
    sock,
    send,
    kill, // On renvoie notre nouvelle fonction kill musclée
    on,
    waitForPlaybackStart: (timeoutMs: number = 20000) => {
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
          doneKo(new Error(`Timeout de chargement (${timeoutMs}ms)`));
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
