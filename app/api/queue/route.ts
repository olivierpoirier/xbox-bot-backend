// app/api/queue/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { CONTROL, NOWPLAYING, QUEUE } from "@/lib/firebaseAdmin";

export async function GET(_req: NextRequest) {
  const [nowSnap, controlSnap, queuedSnap] = await Promise.all([
    NOWPLAYING().get(),
    CONTROL().get(),
    QUEUE()
      .where("status", "==", "queued")
      .orderBy("createdAt", "asc")
      .limit(50)
      .get(),
  ]);

  const now = nowSnap.exists ? nowSnap.data() : null;
  const control = controlSnap.exists ? controlSnap.data() : null;
  const queue = queuedSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  return NextResponse.json({ ok: true, now, queue, control });
}
