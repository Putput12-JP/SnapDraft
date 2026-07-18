// ═══════════════════════════════════════════════════════════════
// Action callables — the write surface Vault's frontend calls.
// ═══════════════════════════════════════════════════════════════
//   executeSleeperAction  — one action, instant, per-user rate-limited.
//                           Use for a single interactive change (one swap).
//   enqueueSleeperActions — a batch, drained gradually by the scheduler.
//                           Use for multi-change ops (optimize all leagues).

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { ENC_KEY_SECRET, THROTTLE_GAP_MS } from "./config";
import { SleeperAction, SUPPORTED_ACTIONS, ActionType } from "./sleeper/mutations";
import { executeAction } from "./executor";
import { enqueueActions } from "./queue";
import { reserveThrottleSlot, getConnection } from "./lib/tokens";
import { toHttpsError } from "./lib/errors";

const encKey = defineSecret(ENC_KEY_SECRET);
const MAX_BATCH = 50;

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
export const executeSleeperAction = onCall({ secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const action = asAction((request.data as any)?.action);

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
export const enqueueSleeperActions = onCall(async (request) => {
  const uid = uidOf(request);
  const raw = (request.data as any)?.actions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError("invalid-argument", "actions must be a non-empty array.");
  }
  if (raw.length > MAX_BATCH) {
    throw new HttpsError("invalid-argument", `Too many actions (max ${MAX_BATCH}).`);
  }
  const actions = raw.map(asAction);

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
