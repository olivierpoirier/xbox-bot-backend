// worker/mpv.ts
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";

export type MpvHandle = {
  proc: ChildProcess;
  pipe: string;
  sock: net.Socket;
  send: (cmd: unknown) => Promise<void>;
  kill: () => void;
};

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** mpv / mpvnet binary resolution */
function findPlayerBinary(): string {
  const bin = (process.env.MPV_BIN || "").trim();
  if (bin) return bin;
  const ok = (cmd: string) => {
    try { return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0; }
    catch { return false; }
  };
  if (ok("mpv")) return "mpv";
  if (ok("mpvnet")) return "mpvnet";
  throw new Error(
    "mpv introuvable. Installe-le (Scoop: 'scoop bucket add extras' puis 'scoop install mpv'),\n" +
    "ou définis MPV_BIN vers l'exécutable (ex.: C:\\\\Program Files\\\\mpv.net\\\\mpvnet.exe)."
  );
}

/** Essaye de se connecter à la named pipe, avec retry jusqu'au timeout */
async function connectPipeWithRetry(pipePath: string, timeoutMs = 25000, stepMs = 100) {
  const start = Date.now();
  let lastErr: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      // ping court
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(pipePath);
        sock.once("connect", () => resolve());
        sock.once("error", reject);
        setTimeout(() => { try { sock.destroy(new Error("IPC connect timeout step")); } catch {} }, stepMs * 2);
      });
      // connexion réelle à retourner
      const sock = net.connect(pipePath);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", () => resolve());
        sock.once("error", reject);
      });
      return sock;
    } catch (e) {
      lastErr = e;
      await delay(stepMs);
    }
  }
  throw new Error("MPV IPC pipe not ready (timeout)", { cause: lastErr });
}

/** Split d'options en respectant les guillemets doubles ; retourne des tokens sans guillemets */
function splitArgs(str: string): string[] {
  const m = str.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!m) return [];
  return m.map(s => (s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1) : s);
}

/** Construit la liste d'options audio: device + qualité + overrides via env */
function buildAudioArgs(volume: number, pipe: string): string[] {
  const args: string[] = [
    "--no-video",
    "--idle=no",
    `--volume=${Math.max(0, Math.min(100, volume))}`,
    `--input-ipc-server=${pipe}`,
  ];

  // Device cible (ex: wasapi/{GUID} ou friendly name)
  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) args.push(`--audio-device=${audioDevice}`);

  // Qualité par défaut
  const defaults: string[] = [
    "--ytdl-format=bestaudio",
    "--audio-samplerate=48000",
  ];

  // Buffer par défaut: 2.0 s (0..10 s accepté)
  const bufEnv = (process.env.MPV_AUDIO_BUFFER_SECS || "").trim();
  const bufVal = bufEnv ? Number(bufEnv) : 2.0;
  if (Number.isFinite(bufVal) && bufVal >= 0 && bufVal <= 10) {
    defaults.push(`--audio-buffer=${bufVal}`);
  }

  // Overrides / ajouts via env (ex: MPV_ADDITIONAL_OPTS="--ytdl-format=bestaudio[ext=webm]/bestaudio --no-config")
  const extraEnv = splitArgs(process.env.MPV_ADDITIONAL_OPTS || "");

  const hasPrefix = (list: string[], prefix: string) => list.some(opt => opt.startsWith(prefix));

  if (!hasPrefix(extraEnv, "--ytdl-format=")) args.push(defaults[0]);
  if (!hasPrefix(extraEnv, "--audio-samplerate=")) args.push(defaults[1]);
  if (!hasPrefix(extraEnv, "--audio-buffer=") && defaults[2]) args.push(defaults[2]);

  // Puis appendre les extras utilisateur (dans l'ordre donné)
  args.push(...extraEnv);

  return args;
}

export async function startMpv(
  url: string,
  volume = 80,
  pipeName = `xmb_mpv_${Date.now()}`
): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const pipe = `\\\\.\\pipe\\${pipeName}`;

  // nettoyer une éventuelle pipe résiduelle
  try { if (fs.existsSync(pipe)) fs.unlinkSync(pipe); } catch {}

  const args = [...buildAudioArgs(volume, pipe), url];

  const proc = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });

  // Si mpv s'arrête immédiatement, on ne boucle pas indéfiniment
  let exited = false;
  proc.once("exit", () => { exited = true; });

  // Attente de l'IPC prêt
  let sock: net.Socket | null = null;
  try {
    sock = await Promise.race([
      (async () => await connectPipeWithRetry(pipe, 25000, 120))(),
      (async () => {
        while (!exited) { await delay(50); }
        throw new Error("MPV exited before IPC became ready");
      })(),
    ]);
  } catch (e) {
    try { if (!exited) proc.kill("SIGKILL"); } catch {}
    throw e;
  }

  const send = async (cmd: unknown) => {
    return new Promise<void>((resolve, reject) => {
      const line = JSON.stringify(cmd) + "\n";
      sock!.write(line, (err) => (err ? reject(err) : resolve()));
    });
  };

  const kill = () => {
    try { sock?.destroy(); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };

  proc.on("exit", () => { try { sock?.destroy(); } catch {} });

  return { proc, pipe, sock, send, kill };
}

export async function mpvPause(h: MpvHandle, on: boolean) {
  await h.send({ command: ["set_property", "pause", on] });
}
export async function mpvSetVolume(h: MpvHandle, v: number) {
  await h.send({ command: ["set_property", "volume", Math.max(0, Math.min(100, v))] });
}
export async function mpvStop(h: MpvHandle) {
  await h.send({ command: ["quit"] });
}
