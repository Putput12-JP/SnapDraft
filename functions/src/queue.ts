// ═══════════════════════════════════════════════════════════════
// Throttled action queue.
// ═══════════════════════════════════════════════════════════════
// Batch operations (e.g. "optimize all my leagues") enqueue many jobs;
// the scheduled drainer executes them spaced apart so Sleeper never sees
// a burst — matching Statchasers' "actions are submitted gradually to
// protect your account and avoid rate limits."

import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db } from "./lib/firebase";
import {
  ENC_KEY_SECRET,
  JOBS_SUBCOLLECTION,
  THROTTLE_GAP_MS,
  THROTTLE_JITTER_MS,
  MAX_CALLS_PER_DRAIN,
  MAX_JOB_ATTEMPTS,
} from "./config";
import { SleeperAction, buildAction } from "./sleeper/mutations";
import { executeAction } from "./executor";
import { reserveThrottleSlot } from "./lib/tokens";

const encKey = defineSecret(ENC_KEY_SECRET);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitteredGap = () => THROTTLE_GAP_MS + Math.floor(Math.random() * THROTTLE_JITTER_MS);

export type JobStatus = "queued" | "running" | "done" | "error";

/**
 * Validate + enqueue a batch of actions for a user. Jobs are written with
 * increasing `runAfter` timestamps so even a same-run drain paces them.
 * Returns the created job ids. Throws ValidationError on a bad action.
 */
export async function enqueueActions(uid: string, actions: SleeperAction[]): Promise<string[]> {
  // Validate everything up front (buildAction throws ValidationError).
  actions.forEach((a) => buildAction(a));

  const col = db.collection("users").doc(uid).collection(JOBS_SUBCOLLECTION);
  const now = Date.now();
  const batch = db.batch();
  const ids: string[] = [];

  actions.forEach((action, i) => {
    const docRef = col.doc();
    ids.push(docRef.id);
    batch.set(docRef, {
      type: action.type,
      action,
      status: "queued" as JobStatus,
      seq: i,
      attempts: 0,
      result: null,
      error: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      runAfter: Timestamp.fromMillis(now + i * jitteredGap()),
    });
  });

  await batch.commit();
  return ids;
}

/**
 * Scheduled drainer. Picks due, queued jobs across all users and executes
 * them, honoring the per-user throttle. Runs every minute; a single
 * invocation can fully drain a small queue thanks to in-run pacing.
 */
export const drainSleeperQueue = onSchedule(
  { schedule: "every 1 minutes", secrets: [encKey], timeoutSeconds: 540, memory: "256MiB" },
  async () => {
    const now = Timestamp.now();
    const due = await db
      .collectionGroup(JOBS_SUBCOLLECTION)
      .where("status", "==", "queued")
      .where("runAfter", "<=", now)
      .orderBy("runAfter", "asc")
      .limit(MAX_CALLS_PER_DRAIN)
      .get();

    if (due.empty) return;
    const key = encKey.value();
    let calls = 0;

    for (const jobSnap of due.docs) {
      if (calls >= MAX_CALLS_PER_DRAIN) break;
      const uid = jobSnap.ref.parent.parent?.id;
      if (!uid) continue;

      // Respect the per-user throttle. If still cooling down, leave the job
      // for the next run rather than blocking the whole drain.
      const slot = await reserveThrottleSlot(uid, jitteredGap());
      if (!slot.allowed) continue;

      const job = jobSnap.data();
      const action = job.action as SleeperAction;

      await jobSnap.ref.set(
        { status: "running", attempts: FieldValue.increment(1), updatedAt: Timestamp.now() },
        { merge: true }
      );

      try {
        const result = await executeAction(uid, action, key);
        await jobSnap.ref.set(
          { status: "done", result: result ?? null, error: null, updatedAt: Timestamp.now() },
          { merge: true }
        );
      } catch (e) {
        const attempts = (job.attempts ?? 0) + 1;
        const permanent = attempts >= MAX_JOB_ATTEMPTS;
        await jobSnap.ref.set(
          {
            status: permanent ? "error" : "queued",
            error: (e as Error).message ?? String(e),
            // back off before retrying
            runAfter: permanent
              ? job.runAfter
              : Timestamp.fromMillis(Date.now() + jitteredGap() * attempts),
            updatedAt: Timestamp.now(),
          },
          { merge: true }
        );
      }

      calls++;
      await sleep(jitteredGap());
    }
  }
);
