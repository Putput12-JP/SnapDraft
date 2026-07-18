// ═══════════════════════════════════════════════════════════════
// Sleeper connection management (paste-token flow).
// ═══════════════════════════════════════════════════════════════
// The user obtains their own Sleeper token (from the Sleeper app/web
// session) and pastes it into Vault along with their username. We never
// handle their Sleeper password and never trigger Sleeper's captcha —
// exactly the low-liability path Statchasers exposes via `SleeperToken`.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { ENC_KEY_SECRET } from "./config";
import { fetchUserByUsername } from "./sleeper/client";
import { saveToken, deleteToken, getConnection } from "./lib/tokens";

const encKey = defineSecret(ENC_KEY_SECRET);

function uidOf(request: { auth?: { uid?: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to connect Sleeper.");
  return uid;
}

/** connectSleeper({ token, username }) — store the user's Sleeper token. */
export const connectSleeper = onCall({ secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const token = String((request.data as any)?.token ?? "").trim();
  const username = String((request.data as any)?.username ?? "").trim();

  if (!token) throw new HttpsError("invalid-argument", "A Sleeper token is required.");
  if (!username) throw new HttpsError("invalid-argument", "A Sleeper username is required.");

  const user = await fetchUserByUsername(username);
  if (!user) {
    throw new HttpsError("invalid-argument", `Sleeper username "${username}" was not found.`);
  }

  // Stored verified:false — the connection is proven on the first successful
  // write (auth failures flip it back to false and prompt a reconnect).
  await saveToken(uid, token, user.user_id, user.username, encKey.value(), false);
  return await getConnection(uid);
});

/** disconnectSleeper() — remove the stored token entirely. */
export const disconnectSleeper = onCall(async (request) => {
  const uid = uidOf(request);
  await deleteToken(uid);
  return { connected: false };
});

/** sleeperStatus() — connection status without ever returning the token. */
export const sleeperStatus = onCall(async (request) => {
  const uid = uidOf(request);
  return await getConnection(uid);
});
