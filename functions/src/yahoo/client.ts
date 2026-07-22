// ═══════════════════════════════════════════════════════════════
// Yahoo Fantasy API client (server-to-server).
// ═══════════════════════════════════════════════════════════════
//   GET   {base}/{path}?format=json    -> JSON
//   PUT   {base}/{path}  Content-Type: application/xml   -> 200
//   POST  {base}/{path}  Content-Type: application/xml   -> 201
//
// Two Yahoo quirks are load-bearing and easy to get wrong:
//
//   * POST returns 201, not 200. Treating "!== 200" as failure makes every
//     successful add/drop and trade proposal look like an error.
//   * The access token expires hourly and Yahoo ROTATES the refresh token
//     on every refresh. A refresh that isn't persisted in full bricks the
//     connection on the following call.
//
// Refresh is handled here rather than at call sites: `withYahoo` takes a
// token-provider callback so the executor owns storage while this module
// owns the protocol.

import { YAHOO_API_BASE, YAHOO_REFRESH_SKEW_MS } from "../config";
import { YahooAuthError, YahooApiError } from "./auth";

export { YahooAuthError, YahooApiError };

/** Everything the client needs to make (and repair) an authenticated call. */
export interface YahooSession {
  accessToken: string;
  expiresAt: number;
  /**
   * Mint a new access token and persist BOTH halves of the rotation.
   * Returns the new access token.
   */
  refresh: () => Promise<string>;
}

export interface YahooRequest {
  /** Path under the v2 root, e.g. `league/nfl.l.12345/settings`. */
  path: string;
  method?: "GET" | "PUT" | "POST";
  /** XML body for PUT/POST. Ignored on GET. */
  xml?: string;
}

const isExpired = (expiresAt: number) => Date.now() >= expiresAt - YAHOO_REFRESH_SKEW_MS;

async function rawCall(
  token: string,
  req: YahooRequest
): Promise<{ status: number; text: string }> {
  const method = req.method ?? "GET";
  const url =
    method === "GET"
      ? `${YAHOO_API_BASE}/${req.path}${req.path.includes("?") ? "&" : "?"}format=json`
      : `${YAHOO_API_BASE}/${req.path}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (method !== "GET") headers["Content-Type"] = "application/xml";

  let resp: Response;
  try {
    resp = await fetch(url, { method, headers, body: method === "GET" ? undefined : req.xml });
  } catch (e) {
    throw new YahooApiError(`Network error calling Yahoo: ${(e as Error).message}`);
  }
  return { status: resp.status, text: await resp.text() };
}

/**
 * Fire one Yahoo call, refreshing the access token when it is expired or
 * when Yahoo rejects it. Returns the parsed JSON for GETs, or the raw XML
 * text for writes.
 *
 * Throws YahooAuthError when the connection itself is dead (refresh failed
 * or was rejected twice) — the caller flags the connection for reconnect.
 */
export async function yahooCall(
  session: YahooSession,
  req: YahooRequest
): Promise<Record<string, unknown> | string> {
  let token = session.accessToken;

  // Proactive refresh: cheaper than eating a guaranteed 401 first.
  if (isExpired(session.expiresAt)) token = await session.refresh();

  let { status, text } = await rawCall(token, req);

  // Reactive refresh — covers a token revoked or invalidated early. Exactly
  // one retry: a second 401 after a fresh token means the grant is gone, and
  // retrying past that just burns Yahoo's patience with our client id.
  if (status === 401) {
    token = await session.refresh();
    ({ status, text } = await rawCall(token, req));
    if (status === 401) {
      throw new YahooAuthError("Yahoo rejected the refreshed token — reconnect required.");
    }
  }

  const method = req.method ?? "GET";
  const ok = method === "POST" ? status === 201 : status === 200;
  if (!ok) {
    if (status === 403) {
      throw new YahooAuthError(`Yahoo denied access (HTTP 403): ${text.slice(0, 200)}`);
    }
    // Yahoo returns a human-readable <description> on rejected writes (illegal
    // roster, player already claimed, past the lock). Surface it — the user
    // can act on "Player is on waivers" and cannot act on "HTTP 400".
    const desc = /<description>([^<]*)<\/description>/i.exec(text)?.[1];
    throw new YahooApiError(desc || `Yahoo returned HTTP ${status} for ${method} ${req.path}`);
  }

  if (method !== "GET") return text;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new YahooApiError("Yahoo sent a non-JSON response to a read.");
  }
}
