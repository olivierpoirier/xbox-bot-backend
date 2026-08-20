import fs from "node:fs";
import path from "node:path";
import { PLAYER_CONFIG } from "./config.js";

export type ProviderMatch = {
  url: string;
  title?: string;
  thumb?: string | null;
  durationSec?: number;
};

type ProviderMatchCacheVal = {
  value: ProviderMatch;
  exp: number;
};

type CacheFile = {
  version: 1;
  savedAt: number;
  entries: Array<[string, ProviderMatchCacheVal]>;
};

const providerMatchCache = new Map<string, ProviderMatchCacheVal>();
let loaded = false;

function isProviderMatch(value: unknown): value is ProviderMatch {
  if (!value || typeof value !== "object") return false;

  const candidate = value as ProviderMatch;
  return typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url);
}

function isCacheVal(value: unknown): value is ProviderMatchCacheVal {
  if (!value || typeof value !== "object") return false;

  const candidate = value as ProviderMatchCacheVal;
  return Number.isFinite(candidate.exp) && isProviderMatch(candidate.value);
}

function loadProviderMatchCache(): void {
  if (loaded) return;
  loaded = true;

  try {
    if (!fs.existsSync(PLAYER_CONFIG.providerMatchCachePath)) return;

    const raw = fs.readFileSync(
      PLAYER_CONFIG.providerMatchCachePath,
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;

    const now = Date.now();

    for (const entry of parsed.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;

      const [key, val] = entry;
      if (typeof key !== "string" || !isCacheVal(val)) continue;
      if (val.exp <= now) continue;

      providerMatchCache.set(key, {
        value: { ...val.value },
        exp: val.exp,
      });
    }

    trimProviderMatchCache();
  } catch (err) {
    console.warn("[provider-cache] failed to load", err);
  }
}

function persistProviderMatchCache(): void {
  try {
    trimProviderMatchCache();

    const dir = path.dirname(PLAYER_CONFIG.providerMatchCachePath);
    fs.mkdirSync(dir, { recursive: true });

    const payload: CacheFile = {
      version: 1,
      savedAt: Date.now(),
      entries: [...providerMatchCache.entries()],
    };
    const tempPath = `${PLAYER_CONFIG.providerMatchCachePath}.tmp`;

    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tempPath, PLAYER_CONFIG.providerMatchCachePath);
  } catch (err) {
    console.warn("[provider-cache] failed to persist", err);
  }
}

function trimProviderMatchCache(): void {
  const now = Date.now();

  for (const [key, val] of providerMatchCache) {
    if (val.exp <= now) providerMatchCache.delete(key);
  }

  while (providerMatchCache.size > PLAYER_CONFIG.providerMatchCacheMax) {
    const first = providerMatchCache.keys().next();
    if (first.done) break;
    providerMatchCache.delete(first.value);
  }
}

export function getProviderMatch(key: string): ProviderMatch | null {
  loadProviderMatchCache();

  const cached = providerMatchCache.get(key);
  if (!cached) return null;

  if (cached.exp < Date.now()) {
    providerMatchCache.delete(key);
    persistProviderMatchCache();
    return null;
  }

  return { ...cached.value };
}

export function setProviderMatch(key: string, value: ProviderMatch): void {
  loadProviderMatchCache();

  providerMatchCache.set(key, {
    value: { ...value },
    exp: Date.now() + PLAYER_CONFIG.providerMatchCacheTTLMs,
  });

  persistProviderMatchCache();
}

export function deleteProviderMatch(key: string): void {
  loadProviderMatchCache();

  if (providerMatchCache.delete(key)) {
    persistProviderMatchCache();
  }
}

export function getProviderMatchCacheSize(): number {
  loadProviderMatchCache();
  trimProviderMatchCache();
  return providerMatchCache.size;
}
