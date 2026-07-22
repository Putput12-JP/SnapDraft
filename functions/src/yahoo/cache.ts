// ═══════════════════════════════════════════════════════════════
// Yahoo response cache (Firestore, per user).
// ═══════════════════════════════════════════════════════════════
// Doc: users/{uid}/yahooCache/{hashedKey}. Server-only — the rules deny
// client access, because a cache the client can write is a cache the client
// can poison.
//
// This exists because Yahoo sends no CORS headers. On Sleeper and ESPN a
// roster paint is a free browser fetch; on Yahoo it is a billed function
// invocation plus a round trip to Yahoo. Without this, opening Portfolio
// across a dozen leagues would fan out to dozens of calls every time the
// page rendered.
//
// Keys are hashed for the document id because raw keys contain league and
// team keys with dots, which are legal in Firestore ids but make for awkward
// paths — and hashing keeps ids fixed-length regardless of query shape.

import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/firebase";
import { YAHOO_CACHE_SUBCOLLECTION } from "../config";

interface CacheDoc {
  /** Raw cache key, kept for prefix-based invalidation. */
  key: string;
  /** JSON-serialised payload. Firestore rejects deeply nested arrays-of-arrays. */
  body: string;
  cachedAt: Timestamp;
  /** Set a Firestore TTL policy on this field to auto-purge stale entries. */
  expiresAt: Timestamp;
}

/** Firestore caps a document at ~1MB; skip caching anything near that. */
const MAX_CACHE_BYTES = 700 * 1024;

function col(uid: string) {
  return db.collection("users").doc(uid).collection(YAHOO_CACHE_SUBCOLLECTION);
}
function docId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 40);
}

/** Return a cached payload if present and still inside its TTL. */
export async function readCache(
  uid: string,
  key: string
): Promise<Record<string, unknown> | null> {
  const snap = await col(uid).doc(docId(key)).get();
  if (!snap.exists) return null;
  const d = snap.data() as CacheDoc;
  if (d.expiresAt.toMillis() <= Date.now()) return null;
  try {
    return JSON.parse(d.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function writeCache(
  uid: string,
  key: string,
  payload: Record<string, unknown>,
  ttlMs: number
): Promise<void> {
  const body = JSON.stringify(payload);
  // An oversized response is still a perfectly good response — serve it,
  // just don't try to store it and fail the whole read on a Firestore error.
  if (Buffer.byteLength(body, "utf8") > MAX_CACHE_BYTES) return;
  const now = Date.now();
  await col(uid)
    .doc(docId(key))
    .set({
      key,
      body,
      cachedAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + ttlMs),
    } as CacheDoc)
    .catch(() => undefined); // cache writes are best-effort, never fatal
}

/**
 * Drop every cached entry whose key starts with one of `prefixes`. Called
 * after a write so the next read reflects it rather than serving the
 * pre-write state until the TTL lapses.
 *
 * Firestore has no prefix delete, so this uses a range query on the stored
 * key: [prefix, prefix + ￿] covers exactly the keys with that prefix.
 */
export async function invalidateCache(uid: string, prefixes: string[]): Promise<void> {
  if (!prefixes.length) return;
  await Promise.all(
    prefixes.map(async (p) => {
      const snap = await col(uid)
        .where("key", ">=", p)
        .where("key", "<", `${p}￿`)
        .get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    })
  ).catch(() => undefined); // never fail a successful write on cleanup
}

/** Wipe a user's whole cache — used on disconnect so nothing outlives the grant. */
export async function clearCache(uid: string): Promise<void> {
  const snap = await col(uid).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit().catch(() => undefined);
}
