// app/api/clear/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { CONTROL, NOWPLAYING, QUEUE } from "@/lib/firebaseAdmin";
import {
  getFirestore,
  type DocumentData,
} from "firebase-admin/firestore";

function checkAuth(req: NextRequest) {
  const adminPass = process.env.ADMIN_PASS || "";
  if (!adminPass) return true;
  const sent = req.headers.get("x-admin-pass") || "";
  return sent === adminPass;
}

/** État typé du document CONTROL */
type ControlState = {
  paused?: boolean;
  volume?: number;   // 0..100
  skipSeq?: number;  // incrémenté pour signaler un skip
  updatedAt?: Date;
};

/** Lecture sûre du doc CONTROL (sans any) */
function readControlState(d: DocumentData | undefined): ControlState {
  return {
    paused: typeof d?.paused === "boolean" ? d.paused : undefined,
    volume: typeof d?.volume === "number" ? d.volume : undefined,
    skipSeq: typeof d?.skipSeq === "number" ? d.skipSeq : undefined,
    // updatedAt est écrit côté serveur, on n’a pas besoin de le relire ici
  };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const db = getFirestore();

  let clearedQueued = 0;
  let clearedPlaying = 0;

  // 1) Marquer tous les QUEUED -> DONE
  const snapQ = await QUEUE().where("status", "==", "queued").limit(1000).get();
  if (!snapQ.empty) {
    let ops = 0;
    let batch = db.batch();
    for (const doc of snapQ.docs) {
      batch.update(doc.ref, { status: "done", endedAt: new Date() });
      ops++; clearedQueued++;
      if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops > 0) await batch.commit();
  }

  // 2) Marquer tous les PLAYING -> DONE (sécurité : normalement 0 ou 1)
  const snapP = await QUEUE().where("status", "==", "playing").limit(10).get();
  if (!snapP.empty) {
    let ops = 0;
    let batch = db.batch();
    for (const doc of snapP.docs) {
      batch.update(doc.ref, { status: "done", endedAt: new Date(), errorMsg: "cleared" });
      ops++; clearedPlaying++;
      if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops > 0) await batch.commit();
  }

  // 3) Demander au worker d'arrêter immédiatement (skipSeq++)
  const controlRef = CONTROL();
  const controlSnap = await controlRef.get();
  const cur = controlSnap.exists ? readControlState(controlSnap.data() as DocumentData) : {};

  const nextSkip = (typeof cur.skipSeq === "number" ? cur.skipSeq : 0) + 1;

  await controlRef.set(
    {
      paused: true,                 // met en pause tout de suite
      skipSeq: nextSkip,            // forcer un quit mpv côté worker
      updatedAt: new Date(),
    } as ControlState,
    { merge: true }
  );

  // 4) Nettoyer NOWPLAYING (le worker le réécrira si nécessaire)
  try { await NOWPLAYING().delete(); } catch { /* ignore */ }

  return NextResponse.json({
    ok: true,
    clearedQueued,
    clearedPlaying,
  });
}
