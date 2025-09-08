// lib/firebaseAdmin.ts
import { cert, getApps, initializeApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

/**
 * Normalise une clé privée en clair (fallback si pas de B64).
 */
function normalizePrivateKey(raw?: string) {
  let pk = (raw ?? "").trim();
  if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
    pk = pk.slice(1, -1);
  }
  pk = pk.replace(/\\r/g, "\r").replace(/\\n/g, "\n"); // échappements -> vrais retours
  pk = pk.replace(/\r\n/g, "\n").trim();
  return pk;
}

/**
 * Résout la clé privée depuis B64 (recommandé sur Vercel), sinon en clair.
 */
function resolvePrivateKey(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_B64?.trim();
  if (b64) {
    return Buffer.from(b64, "base64").toString("utf8").trim();
  }
  return normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
}

let _app: App | undefined;

/**
 * Initialisation paresseuse (pas à l'import).
 * À appeler uniquement dans du code exécuté côté serveur (runtime Node.js).
 */
export function getAdminApp(): App {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!;
    const privateKey = resolvePrivateKey();

    if (!privateKey.startsWith("-----BEGIN")) {
      throw new Error("FIREBASE_PRIVATE_KEY mal formatée (ne commence pas par -----BEGIN).");
    }

    _app = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  } else {
    _app = getApps()[0]!;
  }
  return _app!;
}

/**
 * Récupère une instance Firestore à la demande.
 */
export function getDb(): Firestore {
  return getFirestore(getAdminApp());
}

/**
 * Petits helpers de collections/documents, évalués à l'appel (pas à l'import).
 */
export const QUEUE = () => getDb().collection("queue");
export const CONTROL = () => getDb().collection("control").doc("player");
export const NOWPLAYING = () => getDb().collection("nowPlaying").doc("current");
