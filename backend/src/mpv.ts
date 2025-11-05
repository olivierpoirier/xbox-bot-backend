import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";

export type MpvHandle = {
  proc: ChildProcess;
  sock: net.Socket;
  send: (cmd: unknown) => Promise<void>;
  kill: () => void;
};

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

function buildAudioArgs(volume: number, ipcPath: string): string[] {
  const args: string[] = [
    "--no-video",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    `--volume=${Math.max(0, Math.min(100, volume))}`,
    `--input-ipc-server=${ipcPath}`,
    // 🎧 Qualité audio: forcement m4a/webm de la meilleure qualité disponible
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

  // Forcer mpv à utiliser notre yt-dlp (chemin exact)
  const ytdlpPath = (process.env.YTDLP_BIN || "").trim();
  if (ytdlpPath) {
    const quoted = ytdlpPath.includes(" ") ? `"${ytdlpPath}"` : ytdlpPath;
    args.push(`--script-opts=ytdl_hook-ytdl_path=${quoted}`);
  }

  // Options “raw” vers yt-dlp via ytdl_hook
  const raw: string[] = [];
  raw.push("force-ipv4=");
  raw.push("extractor-args=youtube:player_client=android");
  args.push(`--ytdl-raw-options=${raw.join(",")}`);

  // Options additionnelles utilisateur
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

export async function startMpv(url: string, _volumeIgnored = 100): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(6).toString("hex");
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xmb_mpv_${Date.now()}_${id}`
      : `/tmp/xmb_mpv_${Date.now()}_${id}.sock`;

  try {
    if (process.platform !== "win32") fs.unlinkSync(ipcPath);
  } catch { /* ignore */ }

  const args = [...buildAudioArgs(100, ipcPath), url];

  if (process.env.MPV_VERBOSE === "1") {
    console.log("[mpv] spawn", bin, args.join(" "));
  }

  const stdioMode: ("ignore" | "inherit")[] =
    process.env.MPV_VERBOSE === "1" ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"];

  const proc = spawn(bin, args, { stdio: stdioMode });

  // Connexion IPC
  const sock = await connectIpc(ipcPath);

  // Writer JSONL rapide
  const send = (cmd: unknown) =>
    new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify(cmd) + "\n";
      const ok = sock.write(payload, (err) => (err ? reject(err) : resolve()));
      if (!ok && process.env.MPV_VERBOSE === "1") {
        // eslint-disable-next-line no-console
        console.log("[mpv] backpressure (drain pending)");
      }
    });

  const kill = () => {
    try { sock.destroy(); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };

  proc.once("exit", () => {
    try { sock.destroy(); } catch {}
  });

  // 🛠️ Ajout pour la robustesse: gérer les erreurs de processus
  proc.once("error", (err) => {
    if (process.env.MPV_VERBOSE === "1") {
        console.error("[mpv] Process error:", err);
    }
    try { sock.destroy(); } catch {}
  });

  return { proc, sock, send, kill };
}

export async function mpvPause(h: MpvHandle, on: boolean): Promise<void> {
  await h.send({ command: ["set_property", "pause", on] });
}

// Retiré la fonction mpvVolume selon votre demande.
// Maintenir une version no-op pour éviter les erreurs d'import/appel dans server.ts
export async function mpvVolume(_h: MpvHandle, _v: number): Promise<void> {} 

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