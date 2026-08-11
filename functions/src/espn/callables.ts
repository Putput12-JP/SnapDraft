// ═══════════════════════════════════════════════════════════════
// ESPN callables — the surface Vault's frontend talks to.
// ═══════════════════════════════════════════════════════════════
//   connectEspn({ swid, s2, leagueId, season }) -> Connection  (verifies + stores)
//   disconnectEspn()                             -> { connected:false }
//   espnStatus()                                 -> Connection  (never returns cookies)
//   espnRead({ query, force })                   -> { ok, data }
//
// Cookie-paste, verified-on-connect — the same trust model as Sleeper's token
// paste, not Yahoo's OAuth. There is no queue and no write path here yet:
// this is Path A (read a private league server-side). Writes are a separate,
// later build gated behind the cURL-replay go/no-go in the multi-platform plan.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import {
  ENC_KEY_SECRET,
  ENFORCE_APP_CHECK,
  MAX_INSTANCES,
  LIMITS,
} from "../config";
import {
  saveEspnCookies,
  deleteEspnCookies,
  getEspnConnection,
  getEspnCookies,
  setEspnVerified,
  EspnCookies,
} from "../lib/espnTokens";
import { fetchEspnLeague, EspnAuthError } from "./client";
import {
  EspnQuery,
  EspnQueryType,
  SUPPORTED_ESPN_QUERIES,
  runEspnQuery,
} from "./queries";
import { enforce } from "../lib/ratelimit";
import { toHttpsError } from "../lib/errors";

const encKey = defineSecret(ENC_KEY_SECRET);
const OPTS = { enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: MAX_INSTANCES };

function uidOf(request: { auth?: { uid?: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to connect ESPN.");
  return uid;
}

/**
 * Normalise a pasted SWID. ESPN stores it WITH braces ({uuid}); users paste it
 * both ways, so add them if missing rather than rejecting a valid credential.
 */
function normSwid(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (!s.startsWith("{")) s = `{${s}`;
  if (!s.endsWith("}")) s = `${s}}`;
  return s;
}

const SWID_RE = /^\{[0-9A-Fa-f-]{30,40}\}$/;

/**
 * connectEspn — verify a cookie pair against a real league read, then store it
 * encrypted. Verification is the point: a paste that 401s never gets saved, so
 * "connected" always means "these cookies actually work".
 */
export const connectEspn = onCall({ ...OPTS, secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const swid = normSwid((request.data as any)?.swid);
  const s2 = String((request.data as any)?.s2 ?? "").trim();
  const leagueId = String((request.data as any)?.leagueId ?? "").replace(/[^0-9]/g, "");
  const season = String((request.data as any)?.season ?? "").replace(/[^0-9]/g, "");

  if (!SWID_RE.test(swid)) {
    throw new HttpsError("invalid-argument", "That SWID doesn't look right — copy the whole value, braces included.");
  }
  if (s2.length < 40) {
    throw new HttpsError("invalid-argument", "That espn_s2 looks too short — copy the entire cookie value.");
  }
  if (!leagueId) {
    throw new HttpsError(
      "invalid-argument",
      "Add the League ID of a private league so we can verify these cookies against it."
    );
  }

  await enforce("espnConnect", uid, LIMITS.espnConnectPerUser, "Too many connection attempts.");

  const cookies: EspnCookies = { swid, s2 };
  const yr = season && /^20\d\d$/.test(season) ? season : String(new Date().getFullYear());
  try {
    // A settings-only read is the cheapest proof the cookies open this league.
    await fetchEspnLeague(cookies, yr, leagueId, ["mSettings"]);
  } catch (e) {
    if (e instanceof EspnAuthError) {
      throw new HttpsError(
        "unauthenticated",
        "ESPN didn't accept those cookies. Re-grab SWID and espn_s2 while logged in and try again."
      );
    }
    // Not an auth failure (e.g. wrong league id / season) — don't store cookies
    // we haven't actually proven, and tell the user which input to check.
    throw toHttpsError(e);
  }

  await saveEspnCookies(uid, swid, s2, encKey.value(), true, leagueId);
  return await getEspnConnection(uid, encKey.value());
});

/** disconnectEspn — drop the stored cookies. */
export const disconnectEspn = onCall(OPTS, async (request) => {
  const uid = uidOf(request);
  await deleteEspnCookies(uid);
  return { connected: false };
});

/** espnStatus — connection status, never the cookies. */
export const espnStatus = onCall({ ...OPTS, secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  return await getEspnConnection(uid, encKey.value());
});

/**
 * espnRead({ query }) — allowlisted private-league read with the user's cookies.
 * Only PRIVATE leagues route here; public leagues still read direct from the
 * browser. A 401 here means the cookies rotated → mark unverified so the UI can
 * prompt a reconnect, and surface it as an auth error.
 */
export const espnRead = onCall({ ...OPTS, secrets: [encKey] }, async (request) => {
  const uid = uidOf(request);
  const q = (request.data as any)?.query as EspnQuery;
  if (!q || typeof q !== "object" || !SUPPORTED_ESPN_QUERIES.includes(q.type as EspnQueryType)) {
    throw new HttpsError("invalid-argument", "Unknown or missing ESPN query type.");
  }

  await enforce("espnRead", uid, LIMITS.espnReadPerUser, "Too many requests.");

  const cookies = await getEspnCookies(uid, encKey.value());
  if (!cookies) throw new HttpsError("failed-precondition", "No ESPN account connected.");

  try {
    const { data } = await runEspnQuery(cookies, q);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof EspnAuthError) {
      await setEspnVerified(uid, false).catch(() => undefined);
    }
    throw toHttpsError(e);
  }
});
