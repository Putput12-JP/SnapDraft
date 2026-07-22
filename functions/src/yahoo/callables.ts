// ═══════════════════════════════════════════════════════════════
// Yahoo callables — the surface Vault's frontend talks to.
// ═══════════════════════════════════════════════════════════════
//   yahooAuthUrl()               -> { url }         start OAuth consent
//   yahooExchangeCode({code,state}) -> Connection   finish OAuth
//   yahooDisconnect()            -> { connected:false }
//   yahooStatus()                -> Connection      (never returns tokens)
//   yahooRead({ query, force })  -> { data, cached }
//   executeYahooAction({ action })  -> { ok, response }
//
// Deliberately NOT here yet: a batch enqueue path. Sleeper needed one
// because its writes are unsanctioned and must be paced; Yahoo's are
// official and rate-limited by Yahoo itself. Add one when a real multi-league
// Yahoo push exists to pace, not before.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import {
  ENC_KEY_SECRET,
  YAHOO_CLIENT_ID_SECRET,
  YAHOO_CLIENT_SECRET_SECRET,
  ENFORCE_APP_CHECK,
  MAX_INSTANCES,
  THROTTLE_GAP_MS,
  LIMITS,
} from "../config";
import { buildAuthUrl, signState, verifyState, exchangeCode } from "./auth";
import {
  YahooAction,
  SUPPORTED_YAHOO_ACTIONS,
  YahooActionType,
} from "./mutations";
import {
  YahooQuery,
  SUPPORTED_YAHOO_QUERIES,
  YahooQueryType,
} from "./queries";
import { executeYahooAction as runAction, executeYahooQuery as runQuery } from "./executor";
import { clearCache } from "./cache";
import {
  saveYahooTokens,
  deleteYahooTokens,
  getYahooConnection,
  reserveYahooThrottleSlot,
} from "../lib/yahooTokens";
import { enforce } from "../lib/ratelimit";
import { toHttpsError } from "../lib/errors";

const encKey = defineSecret(ENC_KEY_SECRET);
const yahooClientId = defineSecret(YAHOO_CLIENT_ID_SECRET);
const yahooClientSecret = defineSecret(YAHOO_CLIENT_SECRET_SECRET);

const OPTS = { enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: MAX_INSTANCES };

function uidOf(request: { auth?: { uid?: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to connect Yahoo.");
  return uid;
}

function creds(hexKey: string) {
  return {
    clientId: yahooClientId.value(),
    clientSecret: yahooClientSecret.value(),
    hexKey,
  };
}

/**
 * yahooAuthUrl() — the consent URL to send the user to.
 *
 * The returned `state` is HMAC-bound to this uid. Without that binding an
 * attacker can hand a victim a callback URL carrying the ATTACKER's
 * authorization code, and the victim's Vault account silently ends up
 * connected to the attacker's Yahoo teams (login CSRF).
 */
export const yahooAuthUrl = onCall({ ...OPTS, secrets: [encKey, yahooClientId] }, async (request) => {
  const uid = uidOf(request);
  const state = signState(uid, encKey.value());
  return { url: buildAuthUrl(yahooClientId.value(), state), state };
});

/** yahooExchangeCode({ code, state }) — finish OAuth and store the grant. */
export const yahooExchangeCode = onCall(
  { ...OPTS, secrets: [encKey, yahooClientId, yahooClientSecret] },
  async (request) => {
    const uid = uidOf(request);
    const code = String((request.data as any)?.code ?? "").trim();
    const state = String((request.data as any)?.state ?? "").trim();
    if (!code) throw new HttpsError("invalid-argument", "Missing authorization code.");

    await enforce("yahooConnect", uid, LIMITS.yahooConnectPerUser, "Too many connection attempts.");

    if (!verifyState(state, uid, encKey.value())) {
      throw new HttpsError(
        "permission-denied",
        "This Yahoo sign-in link didn't originate from your session. Start the connection again."
      );
    }

    try {
      const t = await exchangeCode(yahooClientId.value(), yahooClientSecret.value(), code);
      await saveYahooTokens(
        uid,
        t.accessToken,
        t.refreshToken,
        t.expiresInSec,
        t.guid,
        encKey.value(),
        // The exchange succeeding IS proof the grant works, unlike Sleeper's
        // paste-a-token flow where nothing is verified until the first call.
        true
      );
      return await getYahooConnection(uid);
    } catch (e) {
      throw toHttpsError(e);
    }
  }
);

/** yahooDisconnect() — drop the grant and everything cached under it. */
export const yahooDisconnect = onCall(OPTS, async (request) => {
  const uid = uidOf(request);
  await deleteYahooTokens(uid);
  // Cached league/roster data outliving the grant would keep rendering a
  // "connected" Yahoo surface after the user disconnected.
  await clearCache(uid).catch(() => undefined);
  return { connected: false };
});

/** yahooStatus() — connection status, never the tokens. */
export const yahooStatus = onCall(OPTS, async (request) => {
  const uid = uidOf(request);
  return await getYahooConnection(uid);
});

/**
 * yahooRead({ query, force }) — allowlisted read, cache-first.
 *
 * Every Yahoo read in the app comes through here, because Yahoo sends no
 * CORS headers and the browser cannot call it directly. `force` skips the
 * cache for an explicit user refresh; it does NOT skip the rate limit.
 */
export const yahooRead = onCall(
  { ...OPTS, secrets: [encKey, yahooClientId, yahooClientSecret] },
  async (request) => {
    const uid = uidOf(request);
    const q = (request.data as any)?.query as YahooQuery;
    if (!q || typeof q !== "object" || !SUPPORTED_YAHOO_QUERIES.includes(q.type as YahooQueryType)) {
      throw new HttpsError("invalid-argument", "Unknown or missing query type.");
    }
    const force = (request.data as any)?.force === true;

    await enforce("yahooRead", uid, LIMITS.yahooReadPerUser, "Too many requests.");

    try {
      return { ok: true, ...(await runQuery(uid, q, creds(encKey.value()), force)) };
    } catch (e) {
      throw toHttpsError(e);
    }
  }
);

/** executeYahooAction({ action }) — single write, throttled per user. */
export const executeYahooAction = onCall(
  { ...OPTS, secrets: [encKey, yahooClientId, yahooClientSecret] },
  async (request) => {
    const uid = uidOf(request);
    const action = (request.data as any)?.action as YahooAction;
    if (
      !action ||
      typeof action !== "object" ||
      !SUPPORTED_YAHOO_ACTIONS.includes(action.type as YahooActionType)
    ) {
      throw new HttpsError("invalid-argument", "Unknown or missing action type.");
    }

    await enforce("yahooAction", uid, LIMITS.actionPerUser, "Hourly action limit reached.");

    // Yahoo sanctions these writes, so the cooldown isn't about staying under
    // the radar the way Sleeper's is — it's a guard against a UI loop firing
    // roster changes faster than a human could mean them.
    const slot = await reserveYahooThrottleSlot(uid, THROTTLE_GAP_MS);
    if (!slot.allowed) {
      if (slot.waitMs > 0) {
        throw new HttpsError(
          "resource-exhausted",
          `Slow down — retry in ${Math.ceil(slot.waitMs / 1000)}s.`,
          { retryAfterMs: slot.waitMs }
        );
      }
      throw new HttpsError("failed-precondition", "No Yahoo account connected.");
    }

    try {
      const { response } = await runAction(uid, action, creds(encKey.value()));
      return { ok: true, response };
    } catch (e) {
      throw toHttpsError(e);
    }
  }
);
