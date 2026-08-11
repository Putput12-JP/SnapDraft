// ═══════════════════════════════════════════════════════════════
// ESPN HTTP client — cookie-authed fetch, server-side.
// ═══════════════════════════════════════════════════════════════
// The one thing the browser cannot do: attach a private league's SWID +
// espn_s2 cookies to a cross-site request. Here we can, so this is where a
// private league actually becomes readable. Same request the ESPN web app
// makes; the cookies are the only auth.

import {
  ESPN_READS_HOST,
  ESPN_FANTASY_HOST,
  ESPN_FAN_HOST,
  ESPN_GAME,
  ESPN_LEAGUE_VIEWS,
} from "../config";
import { EspnCookies } from "../lib/espnTokens";

/** Cookies are wrong or expired (401/403) — the user must reconnect ESPN. */
export class EspnAuthError extends Error {}
/** ESPN reachable but unhappy (404, 5xx, malformed body) — surfaced to the user. */
export class EspnApiError extends Error {}

function cookieHeader(c: EspnCookies): string {
  // SWID keeps its braces; espn_s2 is passed raw (already %-encoded by ESPN).
  return `SWID=${c.swid}; espn_s2=${c.s2}`;
}

async function espnFetch(url: string, cookies: EspnCookies): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        cookie: cookieHeader(cookies),
        accept: "application/json",
        "user-agent": "vault-fantasy-sync",
      },
    });
  } catch (e) {
    throw new EspnApiError(`Couldn't reach ESPN: ${(e as Error)?.message ?? "network error"}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new EspnAuthError("ESPN rejected the saved cookies (401/403).");
  }
  if (res.status === 404) {
    throw new EspnApiError("ESPN league not found for that season.");
  }
  if (!res.ok) {
    throw new EspnApiError(`ESPN returned ${res.status} ${res.statusText}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new EspnApiError("ESPN sent an unexpected (non-JSON) response.");
  }
}

function leagueUrl(host: string, season: string, leagueId: string, views: readonly string[]): string {
  const u = new URL(
    `${host}/apis/v3/games/${ESPN_GAME}/seasons/${season}/segments/0/leagues/${leagueId}`
  );
  for (const v of views) u.searchParams.append("view", v);
  return u.toString();
}

/**
 * Read one league with the given views. Tries the reads host first, then the
 * legacy fantasy host — but an auth failure is definitive, so it is NOT
 * retried against the other host (that would just 401 twice and hide the real
 * "reconnect" signal behind a generic error).
 */
export async function fetchEspnLeague(
  cookies: EspnCookies,
  season: string,
  leagueId: string,
  views: readonly string[] = ESPN_LEAGUE_VIEWS
): Promise<unknown> {
  try {
    return await espnFetch(leagueUrl(ESPN_READS_HOST, season, leagueId, views), cookies);
  } catch (e) {
    if (e instanceof EspnAuthError) throw e;
    return await espnFetch(leagueUrl(ESPN_FANTASY_HOST, season, leagueId, views), cookies);
  }
}

/**
 * Best-effort: enumerate every league the SWID belongs to via the fan API.
 * Undocumented and shape-unstable, so callers must treat a throw or an empty
 * list as "couldn't enumerate", never as "user has no leagues".
 */
export async function fetchEspnFanLeagues(cookies: EspnCookies): Promise<unknown> {
  const swid = cookies.swid.trim();
  const u = new URL(`${ESPN_FAN_HOST}/apis/v2/fans/${encodeURIComponent(swid)}`);
  u.searchParams.set("configuration", "SITE_DEFAULT");
  u.searchParams.set("displayEvents", "true");
  u.searchParams.set("displayNow", "true");
  u.searchParams.set("recentEventsCount", "1");
  return await espnFetch(u.toString(), cookies);
}
