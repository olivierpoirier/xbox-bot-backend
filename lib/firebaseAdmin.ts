// lib/firebaseAdmin.ts
import { cert, getApps, initializeApp, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let app: App;

if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID!;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!;
  // ⚠️ sur Vercel, la clé privée contient des "\n" littéraux → on les remet en vrais sauts de ligne
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
} else {
  app = getApps()[0]!;
}

export const db = getFirestore(app);

// Collections/docs utilisés par le bot
export const QUEUE = () => db.collection("queue");
export const CONTROL = () => db.collection("control").doc("player");
export const NOWPLAYING = () => db.collection("nowPlaying").doc("current");
