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
import { requestVerificationCode, loginWithCode } from "./sleeper/auth";
import { saveToken, deleteToken, getConnection } from "./lib/tokens";
import { toHttpsError } from "./lib/errors";

const encKey = defineSecret(ENC_KEY_SECRET);

const looksLikeEmailOrPhone = (s: string) => /@/.test(s) || /^[+()\d][\d\s()+-]{6,}$/.test(s);

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

// ── Passwordless verification-code flow (primary onboarding) ──────
// Step 1: user enters username/email/phone + solves hCaptcha -> we ask
// Sleeper to send them a code. Step 2: user enters the code -> we mint
// and store the token. The token never touches the browser.

/** sleeperRequestCode({ identifier, captcha }) — Sleeper sends a 6-digit code. */
export const sleeperRequestCode = onCall(async (request) => {
  uidOf(request);
  const identifier = String((request.data as any)?.identifier ?? "").trim();
  const captcha = String((request.data as any)?.captcha ?? "").trim();
  if (!identifier) throw new HttpsError("invalid-argument", "Enter your Sleeper username, email, or phone.");
  if (!captcha) throw new HttpsError("invalid-argument", "Complete the human-check first.");
  try {
    await requestVerificationCode(identifier, captcha);
    return { ok: true };
  } catch (e) {
    throw toHttpsError(e);
  }
});

/**
 * sleeperVerifyCode({ identifier, code, captcha?, username? }) — exchange the
 * code for a token, resolve identity, and store it. `username` is used to
 * resolve the Sleeper user id for ownership checks (falls back to identifier
 * when identifier is a username rather than an email/phone).
 */
export const sleeperVerifyCode = onCall({ secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const identifier = String((request.data as any)?.identifier ?? "").trim();
  const code = String((request.data as any)?.code ?? "").trim();
  const captcha = String((request.data as any)?.captcha ?? "").trim() || undefined;
  let username = String((request.data as any)?.username ?? "").trim();

  if (!identifier) throw new HttpsError("invalid-argument", "Missing Sleeper identifier.");
  if (!code) throw new HttpsError("invalid-argument", "Enter the code Sleeper sent you.");
  if (!username && !looksLikeEmailOrPhone(identifier)) username = identifier;
  if (!username) {
    throw new HttpsError(
      "invalid-argument",
      "Connect your Sleeper username first (needed to link your account), then verify."
    );
  }

  const user = await fetchUserByUsername(username);
  if (!user) throw new HttpsError("invalid-argument", `Sleeper username "${username}" was not found.`);

  try {
    const token = await loginWithCode(identifier, code, captcha);
    await saveToken(uid, token, user.user_id, user.username, encKey.value(), true);
    return await getConnection(uid);
  } catch (e) {
    throw toHttpsError(e);
  }
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
