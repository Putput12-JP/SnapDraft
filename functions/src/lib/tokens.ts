// ═══════════════════════════════════════════════════════════════
// Encrypted Sleeper-token store (Firestore, admin-only path).
// ═══════════════════════════════════════════════════════════════
// Doc: sleeperTokens/{uid}. Firestore security rules deny ALL client
// access to this collection; only Cloud Functions (Admin SDK) touch it.
// The token is stored encrypted (AES-256-GCM) and only ever decrypted
// in-memory during a Sleeper call.

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { TOKENS_COLLECTION } from "../config";
import { encryptToken, decryptToken, Encrypted } from "./crypto";

interface TokenDoc extends Encrypted {
  sleeperUserId: string;
  sleeperUsername: string;
  verified: boolean;
  nextAllowedAt: Timestamp | null; // per-user throttle gate
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Connection {
  connected: boolean;
  sleeperUserId?: string;
  sleeperUsername?: string;
  verified?: boolean;
}

function ref(uid: string) {
  return db.collection(TOKENS_COLLECTION).doc(uid);
}

export async function saveToken(
  uid: string,
  token: string,
  sleeperUserId: string,
  sleeperUsername: string,
  hexKey: string,
  verified = false
): Promise<void> {
  const enc = encryptToken(token, hexKey);
  const now = Timestamp.now();
  const existing = await ref(uid).get();
  await ref(uid).set(
    {
      ...enc,
      sleeperUserId,
      sleeperUsername,
      verified,
      nextAllowedAt: null,
      createdAt: existing.exists ? (existing.data() as TokenDoc).createdAt : now,
      updatedAt: now,
    } as TokenDoc,
    { merge: false }
  );
}

/** Decrypt and return the live token + identity, or null if not connected. */
export async function getToken(
  uid: string,
  hexKey: string
): Promise<{ token: string; sleeperUserId: string; sleeperUsername: string } | null> {
  const snap = await ref(uid).get();
  if (!snap.exists) return null;
  const d = snap.data() as TokenDoc;
  return {
    token: decryptToken({ ct: d.ct, iv: d.iv, tag: d.tag }, hexKey),
    sleeperUserId: d.sleeperUserId,
    sleeperUsername: d.sleeperUsername,
  };
}

/** Public-safe connection status — never includes the token. */
export async function getConnection(uid: string): Promise<Connection> {
  const snap = await ref(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data() as TokenDoc;
  return {
    connected: true,
    sleeperUserId: d.sleeperUserId,
    sleeperUsername: d.sleeperUsername,
    verified: d.verified,
  };
}

export async function setVerified(uid: string, verified: boolean): Promise<void> {
  await ref(uid).set({ verified, updatedAt: Timestamp.now() }, { merge: true });
}

export async function deleteToken(uid: string): Promise<void> {
  await ref(uid).delete();
}

/**
 * Transactionally enforce the per-user throttle. If the user's cooldown
 * has elapsed, reserves the next slot (nextAllowedAt = now + gapMs) and
 * returns { allowed: true }. Otherwise returns { allowed: false, waitMs }.
 */
export async function reserveThrottleSlot(
  uid: string,
  gapMs: number
): Promise<{ allowed: boolean; waitMs: number }> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(uid));
    if (!snap.exists) return { allowed: false, waitMs: 0 };
    const d = snap.data() as TokenDoc;
    const now = Date.now();
    const nextAllowed = d.nextAllowedAt ? d.nextAllowedAt.toMillis() : 0;
    if (now < nextAllowed) {
      return { allowed: false, waitMs: nextAllowed - now };
    }
    tx.set(
      ref(uid),
      { nextAllowedAt: Timestamp.fromMillis(now + gapMs) },
      { merge: true }
    );
    return { allowed: true, waitMs: 0 };
  });
}
