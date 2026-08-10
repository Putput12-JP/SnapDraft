// ═══════════════════════════════════════════════════════════════
// Action callables — the write surface Vault's frontend calls.
// ═══════════════════════════════════════════════════════════════
//   executeSleeperAction  — one action, instant, per-user rate-limited.
//                           Use for a single interactive change (one swap).
//   enqueueSleeperActions — a batch, drained gradually by the scheduler.
//                           Use for multi-change ops (optimize all leagues).

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import {
  ENC_KEY_SECRET,
  THROTTLE_GAP_MS,
  ENFORCE_APP_CHECK,
  MAX_INSTANCES,
  LIMITS,
} from "./config";
import { SleeperAction, SUPPORTED_ACTIONS, ActionType } from "./sleeper/mutations";
import { SleeperQuery, SUPPORTED_QUERIES, QueryType } from "./sleeper/queries";
import { executeAction, executeQuery } from "./executor";
import { enqueueActions } from "./queue";
import { reserveThrottleSlot, getConnection } from "./lib/tokens";
import { enforce } from "./lib/ratelimit";
import { toHttpsError } from "./lib/errors";

const encKey = defineSecret(ENC_KEY_SECRET);
const MAX_BATCH = 50;

/** Baseline hardening applied to every callable in this file. */
const OPTS = { enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: MAX_INSTANCES };

function uidOf(request: { auth?: { uid?: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

function asAction(raw: unknown): SleeperAction {
  const a = raw as SleeperAction;
  if (!a || typeof a !== "object" || !SUPPORTED_ACTIONS.includes((a as any).type as ActionType)) {
    throw new HttpsError("invalid-argument", "Unknown or missing action type.");
  }
  return a;
}

/** executeSleeperAction({ action }) — single, immediate, throttled. */
export const executeSleeperAction = onCall({ ...OPTS, secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const action = asAction((request.data as any)?.action);

  // The 3s cooldown below paces bursts; this caps the daily total, which
  // pacing alone never does.
  await enforce("action", uid, LIMITS.actionPerUser, "Hourly action limit reached.");

  const slot = await reserveThrottleSlot(uid, THROTTLE_GAP_MS);
  if (!slot.allowed) {
    if (slot.waitMs > 0) {
      throw new HttpsError(
        "resource-exhausted",
        `Slow down — retry in ${Math.ceil(slot.waitMs / 1000)}s or use the queue.`,
        { retryAfterMs: slot.waitMs }
      );
    }
    throw new HttpsError("failed-precondition", "No Sleeper account connected.");
  }

  try {
    const data = await executeAction(uid, action, encKey.value());
    return { ok: true, data };
  } catch (e) {
    throw toHttpsError(e);
  }
});

/** enqueueSleeperActions({ actions }) — batch, drained gradually. */
export const enqueueSleeperActions = onCall(OPTS, async (request) => {
  const uid = uidOf(request);
  const raw = (request.data as any)?.actions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError("invalid-argument", "actions must be a non-empty array.");
  }
  if (raw.length > MAX_BATCH) {
    throw new HttpsError("invalid-argument", `Too many actions (max ${MAX_BATCH}).`);
  }
  const actions = raw.map(asAction);

  // MAX_BATCH bounds one call, not the number of calls — without this a
  // loop writes Firestore docs until the bill says stop.
  await enforce("enqueue", uid, LIMITS.enqueuePerUser, "Hourly batch limit reached.");

  const conn = await getConnection(uid);
  if (!conn.connected) {
    throw new HttpsError("failed-precondition", "No Sleeper account connected.");
  }

  try {
    const jobIds = await enqueueActions(uid, actions);
    return { ok: true, jobIds, count: jobIds.length };
  } catch (e) {
    throw toHttpsError(e);
  }
});

/**
 * sleeperRead({ query }) — allowlisted read-only query.
 *
 * Reads skip the write cooldown (they're safe to run back-to-back and the
 * UI does), but they still leave our IP on Sleeper's doorstep, so they get
 * a ceiling generous enough for normal browsing and far below what it
 * takes to get the project rate-limited or blocked.
 */
export const sleeperRead = onCall({ ...OPTS, secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const q = (request.data as any)?.query as SleeperQuery;
  if (!q || typeof q !== "object" || !SUPPORTED_QUERIES.includes((q as any).type as QueryType)) {
    throw new HttpsError("invalid-argument", "Unknown or missing query type.");
  }

  await enforce("read", uid, LIMITS.readPerUser, "Too many requests.");

  try {
    const data = await executeQuery(uid, q, encKey.value());
    return { ok: true, data };
  } catch (e) {
    throw toHttpsError(e);
  }
});
