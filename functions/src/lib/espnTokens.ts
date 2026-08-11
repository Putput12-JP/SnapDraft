// ═══════════════════════════════════════════════════════════════
// Encrypted ESPN cookie store (Firestore, admin-only path).
// ═══════════════════════════════════════════════════════════════
// Doc: espnTokens/{uid}. Same discipline as sleeperTokens / yahooTokens —
// security rules deny ALL client access; only Cloud Functions (Admin SDK)
// touch it, and both cookies are AES-256-GCM encrypted at rest.
//
// ESPN's credential is a pair of browser cookies:
//   SWID     — the account id, wrapped in braces: {XXXXXXXX-XXXX-...}
//   espn_s2  — a long %-encoded session token
// Together they are read+write access to the user's ESPN fantasy account, so
// they get the exact same treatment as a Sleeper token: encrypted, never
// returned to the client, decrypted in-memory only at the moment of a call.
//
// Unlike Yahoo there is no refresh token — espn_s2 is long-lived but rotates
// on logout / password change. When it does, ESPN answers 401 and the client
// is prompted to reconnect (mirrors SleeperAuthError → "reconnect").

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { ESPN_TOKENS_COLLECTION } from "../config";
import { encryptToken, decryptToken, Encrypted } from "./crypto";

interface EspnTokenDoc {
  swid: Encrypted;
  s2: Encrypted;
  /** Whether the pair has completed a successful ESPN call since connecting. */
  verified: boolean;
  /** A league the cookies were verified against — the reconnect prompt re-checks it. */
  verifiedLeagueId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface EspnConnection {
  connected: boolean;
  verified?: boolean;
  /** A stable, non-secret hint the UI can show ("connected as {…1234}"). Never the token. */
  swidHint?: string;
}

export interface EspnCookies {
  swid: string;
  s2: string;
}

function ref(uid: string) {
  return db.collection(ESPN_TOKENS_COLLECTION).doc(uid);
}

/** Last 4 of the SWID's uuid — enough for "you're connected", useless as a credential. */
function hintOf(swid: string): string {
  const hex = swid.replace(/[^0-9a-fA-F]/g, "");
  return hex ? `…${hex.slice(-4)}` : "";
}

export async function saveEspnCookies(
  uid: string,
  swid: string,
  s2: string,
  hexKey: string,
  verified = false,
  verifiedLeagueId: string | null = null
): Promise<void> {
  const now = Timestamp.now();
  const existing = await ref(uid).get();
  await ref(uid).set(
    {
      swid: encryptToken(swid, hexKey),
      s2: encryptToken(s2, hexKey),
      verified,
      verifiedLeagueId,
      createdAt: existing.exists ? (existing.data() as EspnTokenDoc).createdAt : now,
      updatedAt: now,
    } as EspnTokenDoc,
    { merge: false }
  );
}

/** Decrypt and return the live cookie pair, or null if not connected. */
export async function getEspnCookies(
  uid: string,
  hexKey: string
): Promise<EspnCookies | null> {
  const snap = await ref(uid).get();
  if (!snap.exists) return null;
  const d = snap.data() as EspnTokenDoc;
  return {
    swid: decryptToken(d.swid, hexKey),
    s2: decryptToken(d.s2, hexKey),
  };
}

/**
 * Public-safe status — never includes either cookie. Takes the key only so it
 * can surface a harmless last-4 SWID hint ("connected as …1234"); the raw
 * cookies never leave this function.
 */
export async function getEspnConnection(
  uid: string,
  hexKey?: string
): Promise<EspnConnection> {
  const snap = await ref(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data() as EspnTokenDoc;
  const out: EspnConnection = { connected: true, verified: d.verified };
  if (hexKey) {
    try {
      out.swidHint = hintOf(decryptToken(d.swid, hexKey));
    } catch {
      /* a bad key must not turn "connected" into an error */
    }
  }
  return out;
}

export async function setEspnVerified(
  uid: string,
  verified: boolean,
  verifiedLeagueId?: string | null
): Promise<void> {
  const patch: Partial<EspnTokenDoc> = { verified, updatedAt: Timestamp.now() };
  if (verifiedLeagueId !== undefined) patch.verifiedLeagueId = verifiedLeagueId;
  await ref(uid).set(patch, { merge: true });
}

export async function deleteEspnCookies(uid: string): Promise<void> {
  await ref(uid).delete();
}
