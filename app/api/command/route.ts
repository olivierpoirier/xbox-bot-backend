// app/api/command/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { CONTROL } from "@/lib/firebaseAdmin";

function checkAuth(req: NextRequest) {
  const adminPass = process.env.ADMIN_PASS || "";
  if (!adminPass) return true;
  const sent = req.headers.get("x-admin-pass") || "";
  return sent === adminPass;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const cmd = String(body?.cmd || "").toLowerCase();
  const arg = body?.arg;

  const controlRef = CONTROL();
  const snap = await controlRef.get();
  const control = snap.exists ? snap.data()! : { paused: false, volume: 80, skipSeq: 0 };

  if (cmd === "pause") control.paused = true;
  else if (cmd === "resume") control.paused = false;
  else if (cmd === "skip") control.skipSeq = (control.skipSeq || 0) + 1;
  else if (cmd === "volume") {
    const v = Math.max(0, Math.min(100, parseInt(String(arg ?? "80"), 10)));
    control.volume = v;
  } else {
    return NextResponse.json({ ok: false, error: "Unknown command" }, { status: 400 });
  }

  (control as any).updatedAt = new Date();
  await controlRef.set(control, { merge: true });
  return NextResponse.json({ ok: true, control });
}
