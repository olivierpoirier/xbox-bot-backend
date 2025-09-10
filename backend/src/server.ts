import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import { startMpv, mpvPause, mpvVolume, mpvQuit, type MpvHandle } from "./mpv";
import path from "node:path";

const PORT = Number(process.env.PORT || 4000);
const ADMIN_PASS = (process.env.ADMIN_PASS || "").trim();

const app = express();
app.use(express.json());
app.use(cors());

// (Option) servir le frontend buildé (voir section 2)
const publicDir = path.resolve(process.cwd(), "../xbox-music-ui/dist");
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*" } // en dev ; en prod, restreins
});

/* ---------------- In-memory state ---------------- */
type Control = { paused: boolean; volume: number; skipSeq: number };
type Now = { url?: string; title?: string; addedBy?: string; startedAt?: number | null };
type QueueItem = { id: string; url: string; addedBy?: string; status: "queued"|"playing"|"done"|"error"; createdAt: number };

const state = {
  control: { paused: false, volume: 80, skipSeq: 0 } as Control,
  now: null as Now | null,
  queue: [] as QueueItem[],
};

let playing: { item: QueueItem; handle: MpvHandle } | null = null;
let nextId = 1;

function broadcast() {
  io.emit("state", {
    ok: true,
    now: state.now,
    queue: state.queue.filter(q => q.status === "queued"),
    control: state.control
  });
}

function checkAdmin(pass?: string) {
  if (!ADMIN_PASS) return true;
  return (pass || "") === ADMIN_PASS;
}

/* ---------------- Player loop (simple) ---------------- */
async function ensurePlayerLoop() {
  if (playing) return;

  // prend le plus ancien "queued"
  const idx = state.queue.findIndex(q => q.status === "queued");
  if (idx === -1) return;

  const item = state.queue[idx];
  item.status = "playing";
  state.now = { url: item.url, addedBy: item.addedBy, startedAt: Date.now() };
  broadcast();

  try {
    const handle = await startMpv(item.url, state.control.volume);
    playing = { item, handle };

    // appliquer l'état courant
    await mpvVolume(handle, state.control.volume);
    await mpvPause(handle, state.control.paused);

    // surveille fin du process
    handle.proc.once("exit", () => {
      // marquer terminé
      item.status = "done";
      state.now = null;
      playing = null;
      broadcast();
      // enchaîner
      setTimeout(() => { void ensurePlayerLoop(); }, 150);
    });
  } catch (err) {
    item.status = "error";
    state.now = null;
    playing = null;
    broadcast();
    setTimeout(() => { void ensurePlayerLoop(); }, 1000);
  }
}

/* ---------------- Socket handlers ---------------- */
io.on("connection", (socket) => {
  // envoie l'état initial
  socket.emit("state", { ok: true, now: state.now, queue: state.queue.filter(q => q.status === "queued"), control: state.control });

  socket.on("play", async (payload: { url?: string; addedBy?: string }) => {
    const url = String(payload?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return socket.emit("toast", "URL invalide");
    state.queue.push({
      id: String(nextId++),
      url,
      addedBy: (payload.addedBy || "anon").slice(0, 64),
      status: "queued",
      createdAt: Date.now(),
    });
    broadcast();
    void ensurePlayerLoop();
  });

  socket.on("command", async (payload: { cmd: "pause"|"resume"|"skip"|"volume"; arg?: number; adminPass?: string }) => {
    if (!checkAdmin(payload?.adminPass)) return socket.emit("toast", "Forbidden (admin)");

    if (payload.cmd === "pause") state.control.paused = true;
    else if (payload.cmd === "resume") state.control.paused = false;
    else if (payload.cmd === "volume") state.control.volume = Math.max(0, Math.min(100, Number(payload.arg ?? 80)));
    else if (payload.cmd === "skip") state.control.skipSeq++;

    // appliquer instantanément si en cours
    if (playing?.handle) {
      if (payload.cmd === "pause" || payload.cmd === "resume") await mpvPause(playing.handle, state.control.paused).catch(()=>{});
      if (payload.cmd === "volume") await mpvVolume(playing.handle, state.control.volume).catch(()=>{});
      if (payload.cmd === "skip") await mpvQuit(playing.handle).catch(()=>{});
    }
    broadcast();
  });

  socket.on("clear", async (adminPass?: string) => {
    if (!checkAdmin(adminPass)) return socket.emit("toast", "Forbidden (admin)");
    // stoppe le courant
    if (playing?.handle) await mpvQuit(playing.handle).catch(()=>{});
    // vide la file
    state.queue.forEach(q => { if (q.status === "queued" || q.status === "playing") q.status = "done"; });
    state.now = null;
    broadcast();
  });
});

/* ---------------- HTTP fallback (optionnel) ------------- */
app.get("/healthz", (_, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`🎧 Music bot on http://localhost:${PORT}`);
});
