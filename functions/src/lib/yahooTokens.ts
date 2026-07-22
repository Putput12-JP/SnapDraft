// ═══════════════════════════════════════════════════════════════
// Encrypted Yahoo OAuth token store (Firestore, admin-only path).
// ═══════════════════════════════════════════════════════════════
// Doc: yahooTokens/{uid}. Same discipline as sleeperTokens — security
// rules deny ALL client access; only Cloud Functions (Admin SDK) touch it,
// and both tokens are AES-256-GCM encrypted at rest.
//
// Yahoo differs from Sleeper in one way that matters here: there are TWO
// secrets, with very different lifetimes. The access token expires in an
// hour and is disposable. The refresh token is the durable credential —
// leaking it is equivalent to leaking the account, so it gets the same
// treatment as a Sleeper token and is never returned to the client.

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { YAHOO_TOKENS_COLLECTION } from "../config";
import { encryptToken, decryptToken, Encrypted } from "./crypto";

interface YahooTokenDoc {
  access: Encrypted;
  refresh: Encrypted;
  /** Absolute expiry of the ACCESS token (ms since epoch). */
  expiresAt: number;
  /** Yahoo's opaque user id (GUID) — the identity anchor for ownership checks. */
  guid: string;
  /** Whether the connection has completed a successful call since connecting. */
  verified: boolean;
  nextAllowedAt: Timestamp | null; // per-user write throttle gate
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface YahooConnection {
  connected: boolean;
  guid?: string;
  verified?: boolean;
  /** Surfaced so the UI can pre-empt a reconnect prompt. Never the token itself. */
  expiresAt?: number;
}

export interface YahooTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  guid: string;
}

function ref(uid: string) {
  return db.collection(YAHOO_TOKENS_COLLECTION).doc(uid);
}

export async function saveYahooTokens(
  uid: string,
  accessToken: string,
  refreshToken: string,
  expiresInSec: number,
  guid: string,
  hexKey: string,
  verified = false
): Promise<void> {
  const now = Timestamp.now();
  const existing = await ref(uid).get();
  await ref(uid).set(
    {
      access: encryptToken(accessToken, hexKey),
      refresh: encryptToken(refreshToken, hexKey),
      expiresAt: Date.now() + expiresInSec * 1000,
      guid,
      verified,
      nextAllowedAt: null,
      createdAt: existing.exists ? (existing.data() as YahooTokenDoc).createdAt : now,
      updatedAt: now,
    } as YahooTokenDoc,
    { merge: false }
  );
}

/**
 * Replace only the token pair after a refresh, preserving guid, verified and
 * the throttle gate. A refresh must never reset the user's cooldown — that
 * would turn "token expired mid-batch" into a way to skip the throttle.
 */
export async function updateYahooAccess(
  uid: string,
  accessToken: string,
  refreshToken: string,
  expiresInSec: number,
  hexKey: string
): Promise<void> {
  await ref(uid).set(
    {
      access: encryptToken(accessToken, hexKey),
      refresh: encryptToken(refreshToken, hexKey),
      expiresAt: Date.now() + expiresInSec * 1000,
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
}

/** Decrypt and return the live token pair, or null if not connected. */
export async function getYahooTokens(
  uid: string,
  hexKey: string
): Promise<YahooTokens | null> {
  const snap = await ref(uid).get();
  if (!snap.exists) return null;
  const d = snap.data() as YahooTokenDoc;
  return {
    accessToken: decryptToken(d.access, hexKey),
    refreshToken: decryptToken(d.refresh, hexKey),
    expiresAt: d.expiresAt,
    guid: d.guid,
  };
}

/** Public-safe status — never includes either token. */
export async function getYahooConnection(uid: string): Promise<YahooConnection> {
  const snap = await ref(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data() as YahooTokenDoc;
  return { connected: true, guid: d.guid, verified: d.verified, expiresAt: d.expiresAt };
}

export async function setYahooVerified(uid: string, verified: boolean): Promise<void> {
  await ref(uid).set({ verified, updatedAt: Timestamp.now() }, { merge: true });
}

export async function deleteYahooTokens(uid: string): Promise<void> {
  await ref(uid).delete();
}

/**
 * Transactionally enforce the per-user WRITE throttle, mirroring
 * reserveThrottleSlot() for Sleeper. Reads deliberately don't take this —
 * Yahoo sanctions read traffic, and the cache plus the rate limit already
 * bound it.
 */
export async function reserveYahooThrottleSlot(
  uid: string,
  gapMs: number
): Promise<{ allowed: boolean; waitMs: number }> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(uid));
    if (!snap.exists) return { allowed: false, waitMs: 0 };
    const d = snap.data() as YahooTokenDoc;
    const now = Date.now();
    const nextAllowed = d.nextAllowedAt ? d.nextAllowedAt.toMillis() : 0;
    if (now < nextAllowed) return { allowed: false, waitMs: nextAllowed - now };
    tx.set(ref(uid), { nextAllowedAt: Timestamp.fromMillis(now + gapMs) }, { merge: true });
    return { allowed: true, waitMs: 0 };
  });
}
