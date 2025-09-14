import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";

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
    `--volume=${Math.max(0, Math.min(100, volume))}`,
    `--input-ipc-server=${ipcPath}`,
    "--ytdl-format=bestaudio/best",
  ];

  const audioDevice = (process.env.MPV_AUDIO_DEVICE || "").trim();
  if (audioDevice) {
    args.push(`--audio-device=${audioDevice}`);
    console.log("[mpv] audio-device =", audioDevice);
  }

  const bufEnv = (process.env.MPV_AUDIO_BUFFER_SECS || "").trim();
  const bufVal = bufEnv ? Number(bufEnv) : 2;
  if (Number.isFinite(bufVal) && bufVal >= 0 && bufVal <= 10) {
    args.push(`--audio-buffer=${bufVal}`);
  }

  const extra = splitArgs(process.env.MPV_ADDITIONAL_OPTS || "");
  args.push(...extra);

  return args;
}

async function connectIpc(pipePath: string, timeoutMs = 20000): Promise<net.Socket> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const sock = net.connect(pipePath);
      await new Promise<void>((res, rej) => {
        sock.once("connect", () => res());
        sock.once("error", rej);
      });
      return sock;
    } catch (e) {
      lastErr = e;
      await wait(120);
    }
  }
  throw new Error("IPC mpv timeout", { cause: lastErr });
}

export async function startMpv(url: string, _volumeIgnored = 100): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xmb_mpv_${Date.now()}`
      : `/tmp/xmb_mpv_${Date.now()}.sock`;

  try {
    fs.unlinkSync(ipcPath);
  } catch {
    /* ignore */
  }

  // ⚠️ Volume forcé à 100%
  const args = [...buildAudioArgs(100, ipcPath), url];
  console.log("[mpv] spawn", bin, args.join(" "));

  const proc = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  const sock = await connectIpc(ipcPath);

  const send = (cmd: unknown) =>
    new Promise<void>((resolve, reject) => {
      sock.write(JSON.stringify(cmd) + "\n", (err) => (err ? reject(err) : resolve()));
    });

  const kill = () => {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  proc.once("exit", () => {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  });

  return { proc, sock, send, kill };
}

export async function mpvPause(h: MpvHandle, on: boolean): Promise<void> {
  await h.send({ command: ["set_property", "pause", on] });
}

// Laisse l'API exister, mais c’est un no-op côté serveur (volume toujours 100)
export async function mpvVolume(_h: MpvHandle, _v: number): Promise<void> {
  // no-op
}

export async function mpvQuit(h: MpvHandle): Promise<void> {
  await h.send({ command: ["quit"] });
}
export async function mpvSetLoopFile(h: MpvHandle, on: boolean): Promise<void> {
  await h.send({ command: ["set_property", "loop-file", on ? "inf" : "no"] });
}

// NEW: Seek commandes
export async function mpvSeekAbsolute(h: MpvHandle, seconds: number): Promise<void> {
  // set_property time-pos attend un float en secondes
  await h.send({ command: ["set_property", "time-pos", Math.max(0, seconds)] });
}
export async function mpvSeekRelative(h: MpvHandle, deltaSeconds: number): Promise<void> {
  await h.send({ command: ["seek", deltaSeconds, "relative+exact"] });
}
