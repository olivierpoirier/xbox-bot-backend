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

interface CommandBody {
  cmd?: string;
  arg?: string | number;
}

interface ControlState {
  paused: boolean;
  volume: number;  // 0..100
  skipSeq: number; // incrémenté pour signaler un skip
  updatedAt?: Date;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: CommandBody = {};
  try {
    body = (await req.json()) as CommandBody;
  } catch {
    // body reste {}
  }

  const cmd = (body.cmd ?? "").toLowerCase();
  const arg = body.arg;

  const controlRef = CONTROL();
  const snap = await controlRef.get();

  const existing = snap.exists ? (snap.data() as Record<string, unknown>) : {};
  const control: ControlState = {
    paused: Boolean(existing.paused ?? false),
    volume: Number(existing.volume ?? 80),
    skipSeq: Number(existing.skipSeq ?? 0),
  };

  if (cmd === "pause") control.paused = true;
  else if (cmd === "resume") control.paused = false;
  else if (cmd === "skip") control.skipSeq = (control.skipSeq || 0) + 1;
  else if (cmd === "volume") {
    const v = Math.max(0, Math.min(100, parseInt(String(arg ?? "80"), 10)));
    control.volume = v;
  } else {
    return NextResponse.json({ ok: false, error: "Unknown command" }, { status: 400 });
  }

  control.updatedAt = new Date();
  await controlRef.set(control, { merge: true });

  return NextResponse.json({ ok: true, control });
}
