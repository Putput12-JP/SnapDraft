// ═══════════════════════════════════════════════════════════════
// Yahoo OAuth2 — authorization code flow with refresh.
// ═══════════════════════════════════════════════════════════════
// Yahoo is the first platform Vault talks to over real OAuth. Sleeper is
// paste-a-token and ESPN would be paste-cookies; both put the credential
// in the user's hands. Here the credential is minted by Yahoo and the
// client_secret must never reach the browser, so the whole exchange
// happens server-side:
//
//   1. yahooAuthUrl()      -> consent URL + signed state
//   2. user consents, Yahoo redirects to YAHOO_REDIRECT_URI?code=…&state=…
//   3. yahooExchangeCode() -> swaps code for tokens, stores them encrypted
//
// The `state` parameter is not decoration. Without it, a third party can
// hand the user a crafted callback URL and graft THEIR Yahoo account onto
// the victim's Vault account (login CSRF). We bind state to the uid with
// an HMAC so a callback can only complete for the account that started it.

import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import {
  YAHOO_AUTH_URL,
  YAHOO_TOKEN_URL,
  YAHOO_REDIRECT_URI,
} from "../config";

export class YahooAuthError extends Error {}
export class YahooApiError extends Error {}

export interface YahooTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  guid: string;
}

/** State lifetime — long enough to read a consent screen, short enough to matter. */
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Mint an opaque state bound to this uid: `<nonce>.<issuedAt>.<hmac>`.
 * Signed with the app's AES key (already a server-only 32-byte secret) so
 * this needs no additional secret to manage.
 */
export function signState(uid: string, hexKey: string): string {
  const nonce = randomBytes(9).toString("base64url");
  const issued = Date.now().toString(36);
  const body = `${nonce}.${issued}`;
  const mac = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(`${uid}:${body}`)
    .digest("base64url");
  return `${body}.${mac}`;
}

/** Verify a callback state really belongs to this uid and hasn't expired. */
export function verifyState(state: string, uid: string, hexKey: string): boolean {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return false;
  const [nonce, issued, mac] = parts;
  const expected = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(`${uid}:${nonce}.${issued}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Length check first — timingSafeEqual throws on mismatched lengths.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const issuedAt = parseInt(issued, 36);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < STATE_TTL_MS;
}

/** Build the consent URL the user is sent to. */
export function buildAuthUrl(clientId: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: YAHOO_REDIRECT_URI,
    response_type: "code",
    state,
  });
  return `${YAHOO_AUTH_URL}?${q.toString()}`;
}

/**
 * POST the token endpoint. Yahoo accepts credentials either as Basic auth or
 * as body params; we send Basic (their documented default) and keep the body
 * to grant data only.
 */
async function tokenRequest(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>
): Promise<YahooTokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let resp: Response;
  try {
    resp = await fetch(YAHOO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ redirect_uri: YAHOO_REDIRECT_URI, ...body }).toString(),
    });
  } catch (e) {
    throw new YahooApiError(`Network error calling Yahoo: ${(e as Error).message}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    // 400 invalid_grant means the code was reused/expired or the refresh token
    // was revoked — both are "reconnect", not "retry".
    if (resp.status === 400 || resp.status === 401) {
      throw new YahooAuthError(`Yahoo rejected the authorization (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    throw new YahooApiError(`Yahoo token endpoint returned HTTP ${resp.status}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new YahooApiError("Yahoo sent a non-JSON token response.");
  }

  const accessToken = String(json.access_token ?? "");
  const refreshToken = String(json.refresh_token ?? "");
  const expiresInSec = Number(json.expires_in ?? 3600);
  const guid = String(json.xoauth_yahoo_guid ?? "");
  if (!accessToken || !refreshToken) {
    throw new YahooAuthError("Yahoo response was missing a token.");
  }
  return { accessToken, refreshToken, expiresInSec, guid };
}

/** Exchange a fresh authorization code for the first token pair. */
export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<YahooTokenResponse> {
  return tokenRequest(clientId, clientSecret, { grant_type: "authorization_code", code });
}

/**
 * Trade a refresh token for a new access token. Yahoo rotates the refresh
 * token on every use, so the caller MUST persist both halves of the result —
 * keeping the old refresh token means the next refresh fails.
 */
export function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<YahooTokenResponse> {
  return tokenRequest(clientId, clientSecret, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
