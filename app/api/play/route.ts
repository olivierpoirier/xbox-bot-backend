export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { QUEUE } from "@/lib/firebaseAdmin";

function checkAuth(req: NextRequest) {
  const adminPass = process.env.ADMIN_PASS || "";
  if (!adminPass) return true; // public si vide
  const sent = req.headers.get("x-admin-pass") || "";
  return sent === adminPass;
}

interface PlayBody {
  url?: string;
  addedBy?: string;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: PlayBody = {};
  try {
    body = (await req.json()) as PlayBody;
  } catch {}

  const url = String(body.url ?? "").trim();
  const addedBy = String(body.addedBy ?? "anon").slice(0, 64);

  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: "Invalid URL" }, { status: 400 });
  }

  const doc = {
    url,
    addedBy,
    status: "queued" as const,
    createdAt: new Date(),
  };

  const ref = await QUEUE().add(doc);
  return NextResponse.json({ ok: true, id: ref.id });
}
