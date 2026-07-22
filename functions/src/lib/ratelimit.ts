// ═══════════════════════════════════════════════════════════════
// Per-subject rate limiting (Firestore fixed window).
// ═══════════════════════════════════════════════════════════════
// Firebase Auth lets anyone create an account, so "the caller is signed
// in" is not a meaningful cost to an attacker. Every callable that can
// reach an outside system (Sleeper) or write documents therefore needs a
// budget, keyed by something the attacker can't cheaply rotate.
//
// Two kinds of subject:
//   uid        — throttles one account.
//   identifier — throttles one TARGET (an email/phone a code would be
//                sent to), which is what actually stops a bombing run:
//                rotating Vault accounts doesn't buy more attempts
//                against the same victim.
//
// Subjects are SHA-256'd before use as a document id, so a third party's
// email or phone number is never stored — not in a field, not in a key.
//
// Fixed windows (not sliding) — cheap, one transaction per call. The
// known trade-off is up to 2x `max` across a window boundary; every limit
// here is set with that slack already accounted for.

import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { RATE_LIMITS_COLLECTION } from "../config";

export interface RateLimit {
  /** Max calls permitted inside one window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

interface CounterDoc {
  count: number;
  windowStart: Timestamp;
  /** Set a Firestore TTL policy on this field to auto-purge stale counters. */
  expiresAt: Timestamp;
}

function docId(bucket: string, subject: string): string {
  const hash = createHash("sha256").update(subject).digest("hex").slice(0, 32);
  return `${bucket}__${hash}`;
}

/**
 * Count one call against `bucket` for `subject`. Returns whether it was
 * allowed and, when not, how long until the window rolls over.
 */
export async function consume(
  bucket: string,
  subject: string,
  limit: RateLimit
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const ref = db.collection(RATE_LIMITS_COLLECTION).doc(docId(bucket, subject));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.exists ? (snap.data() as CounterDoc) : null;
    const startedAt = d ? d.windowStart.toMillis() : 0;
    const inWindow = !!d && now - startedAt < limit.windowMs;

    if (inWindow && d!.count >= limit.max) {
      return { allowed: false, retryAfterMs: startedAt + limit.windowMs - now };
    }

    const windowStart = inWindow ? d!.windowStart : Timestamp.fromMillis(now);
    tx.set(ref, {
      count: inWindow ? d!.count + 1 : 1,
      windowStart,
      expiresAt: Timestamp.fromMillis(windowStart.toMillis() + limit.windowMs),
    } as CounterDoc);

    return { allowed: true, retryAfterMs: 0 };
  });
}

function humanWait(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 90) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  return mins < 90 ? `${mins} min` : `${Math.ceil(mins / 60)}h`;
}

/**
 * consume() + throw on denial. `message` is what the user sees; keep it
 * free of any hint about which subject tripped the limit, so a caller
 * can't use the error to probe whether a given email/phone is in use.
 */
export async function enforce(
  bucket: string,
  subject: string,
  limit: RateLimit,
  message: string
): Promise<void> {
  const { allowed, retryAfterMs } = await consume(bucket, subject, limit);
  if (!allowed) {
    throw new HttpsError(
      "resource-exhausted",
      `${message} Try again in ${humanWait(retryAfterMs)}.`,
      { retryAfterMs }
    );
  }
}

/**
 * Enforce several limits in order, stopping at the first denial.
 *
 * Note: limits checked before the failing one have already been counted.
 * That is intentional — a caller probing for which budget is exhausted
 * burns their own budget doing it.
 */
export async function enforceAll(
  checks: Array<{ bucket: string; subject: string; limit: RateLimit; message: string }>
): Promise<void> {
  for (const c of checks) {
    await enforce(c.bucket, c.subject, c.limit, c.message);
  }
}
