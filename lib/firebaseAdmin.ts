// lib/firebaseAdmin.ts
import { cert, getApps, initializeApp, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function normalizePrivateKey(raw?: string) {
  let pk = (raw ?? "").trim();
  if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
    pk = pk.slice(1, -1);
  }
  pk = pk.replace(/\\r/g, "\r").replace(/\\n/g, "\n"); // Vercel => vrais retours
  pk = pk.replace(/\r\n/g, "\n").trim();
  return pk;
}

function resolvePrivateKey(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_B64;
  if (b64 && b64.trim()) {
    return Buffer.from(b64.trim(), "base64").toString("utf8").trim();
  }
  return normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
}

let app: App;
if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID!;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!;
  const privateKey = resolvePrivateKey();

  if (!privateKey.startsWith("-----BEGIN")) {
    throw new Error("FIREBASE_PRIVATE_KEY mal formatée (ne commence pas par -----BEGIN).");
  }

  app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
} else {
  app = getApps()[0]!;
}

export const db = getFirestore(app);
export const QUEUE = () => db.collection("queue");
export const CONTROL = () => db.collection("control").doc("player");
export const NOWPLAYING = () => db.collection("nowPlaying").doc("current");
