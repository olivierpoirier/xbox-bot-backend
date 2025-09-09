// app/api/queue/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { CONTROL, NOWPLAYING, QUEUE } from "@/lib/firebaseAdmin";

export async function GET() {
  const [nowSnap, controlSnap, queuedSnap] = await Promise.all([
    NOWPLAYING().get(),
    CONTROL().get(),
    QUEUE().where("status", "==", "queued").orderBy("createdAt", "asc").limit(50).get(),
  ]);

  const now = nowSnap.exists ? (nowSnap.data() as Record<string, unknown>) : null;
  const control = controlSnap.exists ? (controlSnap.data() as Record<string, unknown>) : null;

  const queue = queuedSnap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      url: String(data.url ?? ""),
      addedBy: typeof data.addedBy === "string" ? data.addedBy : undefined,
      status: (data.status as "queued" | "playing" | "done" | "error") ?? "queued",
      createdAt: data.createdAt,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      workerId: typeof data.workerId === "string" ? data.workerId : undefined,
    };
  });

  // expose paused / volume pour l'UI
  const uiControl = {
    paused: Boolean(control?.paused ?? false),
    volume: Number(control?.volume ?? 80),
    skipSeq: Number(control?.skipSeq ?? 0),
  };

  return NextResponse.json({ ok: true, now, queue, control: uiControl });
}
