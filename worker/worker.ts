// worker/worker.ts
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { CONTROL, NOWPLAYING, QUEUE, getDb } from "../lib/firebaseAdmin";
import { startMpv, mpvPause, mpvSetVolume, mpvStop, type MpvHandle } from "./mpv";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  FieldValue,
  type Transaction,
  type QueryDocumentSnapshot,
  type DocumentData,
} from "firebase-admin/firestore";

const db = getDb();

/** CLI args */
const argv = yargs(hideBin(process.argv))
  .option("poll", { type: "number", default: 1500, describe: "Intervalle de polling (ms) pour la FILE" })
  .option("log", { type: "boolean", default: true, describe: "Logs console" })
  .parseSync();

function log(...a: unknown[]) {
  if (argv.log) console.log("[worker]", ...a);
}

/** État/Docs typés côté Firestore */
type ControlState = {
  paused?: boolean;
  volume?: number;  // 0..100
  skipSeq?: number; // incrémenté pour signaler un skip
};

interface QueueDoc {
  url: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error";
  volume?: number;
  createdAt?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  errorMsg?: string;
}

/** Helpers de typage sécurisés */
function readControlState(doc: DocumentData | undefined): ControlState {
  return {
    paused: typeof doc?.paused === "boolean" ? doc.paused : undefined,
    volume: typeof doc?.volume === "number" ? doc.volume : undefined,
    skipSeq: typeof doc?.skipSeq === "number" ? doc.skipSeq : undefined,
  };
}

function readQueueDoc(doc: DocumentData): QueueDoc {
  const status = (doc?.status as QueueDoc["status"]) ?? "queued";
  return {
    url: String(doc?.url ?? ""),
    addedBy: typeof doc?.addedBy === "string" ? doc.addedBy : undefined,
    status,
    volume: typeof doc?.volume === "number" ? doc.volume : undefined,
    createdAt: doc?.createdAt,
    startedAt: doc?.startedAt,
    endedAt: doc?.endedAt,
    errorMsg: typeof doc?.errorMsg === "string" ? doc.errorMsg : undefined,
  };
}

/** Claim atomique du plus ancien "queued" via transaction */
async function claimNextQueued(): Promise<QueryDocumentSnapshot<DocumentData> | null> {
  const qs = await QUEUE()
    .where("status", "==", "queued")
    .orderBy("createdAt", "asc")
    .limit(1)
    .get();
  if (qs.empty) return null;

  const doc = qs.docs[0];
  let claimed = false;

  await db.runTransaction(async (tx: Transaction) => {
    const fresh = await tx.get(doc.ref);
    if (!fresh.exists) return;

    const data = readQueueDoc(fresh.data()!);
    if (data.status !== "queued") return; // déjà pris

    tx.update(doc.ref, {
      status: "playing",
      startedAt: FieldValue.serverTimestamp(),
    });
    claimed = true;
  });

  return claimed ? doc : null;
}

/** Nettoyage initial des états orphelins */
async function cleanupOrphans() {
  const snapP = await QUEUE().where("status", "==", "playing").limit(5).get();
  if (!snapP.empty) {
    for (const d of snapP.docs) {
      await d.ref.update({
        status: "done",
        endedAt: FieldValue.serverTimestamp(),
        errorMsg: "orphan-cleaned",
      });
    }
  }
  try { await NOWPLAYING().delete(); } catch { /* ignore */ }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Variables partagées entre boucle et listener CONTROL */
let current: QueryDocumentSnapshot<DocumentData> | null = null;
let mpv: MpvHandle | null = null;
let lastCtrl: ControlState = {};
let lastSkipSeq = 0;

/** Listener temps réel sur CONTROL (pause/volume/skip) */
function startControlListener() {
  return CONTROL().onSnapshot((snap) => {
    const raw = snap.exists ? (snap.data() as DocumentData) : undefined;
    const c = readControlState(raw);

    // On compare aux derniers états connus et on applique immédiatement
    // NB: callback non-async → on déclenche des tasks async "fire-and-forget"
    if (mpv) {
      // volume
      if (typeof c.volume === "number" && c.volume !== lastCtrl.volume) {
        void mpvSetVolume(mpv, c.volume).catch(() => {});
      }
      // pause
      if (typeof c.paused !== "undefined" && c.paused !== lastCtrl.paused) {
        void mpvPause(mpv, !!c.paused).catch(() => {});
      }
      // skip
      const nextSkip = Number(c.skipSeq ?? 0);
      if (nextSkip !== lastSkipSeq) {
        log("⏭ skip requested (realtime)");
        // stoppe immédiatement la lecture courante
        void mpvStop(mpv).catch(() => {});
        lastSkipSeq = nextSkip;
      }
    } else {
      // Même sans lecteur actif, on mémorise skipSeq pour éviter un faux-positif au démarrage suivant
      lastSkipSeq = Number(c.skipSeq ?? lastSkipSeq ?? 0);
    }

    // Mémoriser l'état courant
    lastCtrl = { ...lastCtrl, ...c };
  }, (err) => {
    console.error("[worker] CONTROL listener error:", err);
  });
}

async function playLoop() {
  // Nettoyage initial pour éviter les états zombies
  await cleanupOrphans();

  // Démarrer le listener CONTROL (réagit en vrai temps réel)
  const unsub = startControlListener();

  try {
    while (true) {
      try {
        // 1) Si rien ne joue, tenter de "claim" le prochain item
        if (!current) {
          const doc = await claimNextQueued();
          if (!doc) {
            await sleep(argv.poll); // on attend avant de re-checker la file
            continue;
          }

          const data = readQueueDoc(doc.data()!);
          const url = String(data.url || "");
          const initialVolume =
            typeof data.volume === "number" && Number.isFinite(data.volume) ? data.volume : (lastCtrl.volume ?? 80);

          await NOWPLAYING().set(
            {
              url,
              addedBy: data.addedBy ?? "anon",
              startedAt: FieldValue.serverTimestamp(),
            },
            { merge: false }
          );

          log("▶ play", url);
          mpv = await startMpv(url, initialVolume);
          current = doc;

          // Appliquer immédiatement l'état CONTROL courant (si déjà connu)
          if (typeof lastCtrl.volume === "number") {
            await mpvSetVolume(mpv, lastCtrl.volume);
          }
          if (typeof lastCtrl.paused !== "undefined") {
            await mpvPause(mpv, !!lastCtrl.paused);
          }
        }

        // 2) mpv terminé ?
        if (mpv && mpv.proc.exitCode !== null) {
          log("✔ finished");
          if (current) {
            await current.ref.update({
              status: "done",
              endedAt: FieldValue.serverTimestamp(),
            });
          }
          try { await NOWPLAYING().delete(); } catch { /* ignore */ }
          current = null;
          mpv = null;
        }

        // Petite sieste avant de re-checker la file (le contrôle est en temps réel)
        await sleep(Math.max(400, argv.poll));
      } catch (err) {
        log("Erreur boucle", err);
        if (current) {
          try {
            await current.ref.update({
              status: "error",
              endedAt: FieldValue.serverTimestamp(),
              errorMsg: String(err),
            });
          } catch { /* ignore */ }
        }
        try { await NOWPLAYING().delete(); } catch { /* ignore */ }
        if (mpv) {
          try { mpv.kill(); } catch { /* ignore */ }
        }
        current = null;
        mpv = null;

        await sleep(1200);
      }
    }
  } finally {
    try { unsub(); } catch { /* ignore */ }
  }
}

// BOOT
playLoop().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
