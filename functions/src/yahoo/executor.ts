// ═══════════════════════════════════════════════════════════════
// Yahoo executor — the one place a stored grant becomes a live call.
// ═══════════════════════════════════════════════════════════════
// Mirrors the Sleeper executor:
//   1. Decrypt the grant in-memory.
//   2. For writes, confirm the connected Yahoo account owns the target team.
//   3. Build + fire the exact request.
//   4. On auth failure, flag the connection so the UI prompts a reconnect.
//
// Yahoo-specific: the access token expires hourly and refreshing ROTATES the
// refresh token, so the session handed to the client carries a `refresh`
// callback that persists both halves. Everything funnels through
// `openSession` so no call site can refresh without storing the result.

import {
  YahooAction,
  buildYahooAction,
  yahooOwnershipTarget,
  yahooCacheInvalidations,
} from "./mutations";
import { YahooQuery, buildYahooQuery } from "./queries";
import { yahooCall, YahooSession, YahooAuthError } from "./client";
import { refreshAccessToken } from "./auth";
import {
  getYahooTokens,
  updateYahooAccess,
  setYahooVerified,
} from "../lib/yahooTokens";
import { readCache, writeCache, invalidateCache } from "./cache";

export class YahooOwnershipError extends Error {}
export class YahooNotConnectedError extends Error {}

export interface YahooCreds {
  clientId: string;
  clientSecret: string;
  hexKey: string;
}

/**
 * Load the user's grant and wrap it in a session whose refresh persists.
 * Returns null when the user has no Yahoo connection.
 */
async function openSession(
  uid: string,
  creds: YahooCreds
): Promise<{ session: YahooSession; guid: string } | null> {
  const stored = await getYahooTokens(uid, creds.hexKey);
  if (!stored) return null;

  let current = stored.accessToken;
  const session: YahooSession = {
    get accessToken() {
      return current;
    },
    expiresAt: stored.expiresAt,
    refresh: async () => {
      const next = await refreshAccessToken(
        creds.clientId,
        creds.clientSecret,
        stored.refreshToken
      );
      // Persist BOTH halves — Yahoo invalidates the old refresh token the
      // moment it issues a new one, so storing only the access token means
      // the next refresh fails and the user has to reconnect for nothing.
      await updateYahooAccess(
        uid,
        next.accessToken,
        next.refreshToken,
        next.expiresInSec,
        creds.hexKey
      );
      current = next.accessToken;
      return current;
    },
  };
  return { session, guid: stored.guid };
}

/**
 * Confirm the connected Yahoo account actually manages `teamKey`.
 *
 * Yahoo scopes every call to the grant, so a foreign team key would be
 * rejected anyway — but relying on that means the rejection happens after
 * we've spent the call, and it gives a confused-deputy bug room to become a
 * real one if a future path ever runs with broader scope. `use_login=1`
 * resolves the caller's own teams, so it can't be spoofed by the caller.
 */
async function assertTeamOwnership(
  session: YahooSession,
  leagueKey: string,
  teamKey: string
): Promise<void> {
  const json = (await yahooCall(session, {
    path: `users;use_login=1/games/teams`,
  })) as Record<string, unknown>;

  // Yahoo's JSON is a positional-object tree rather than clean arrays, so
  // walk it for team_key strings instead of trying to model the shape.
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "team_key" && typeof v === "string") found.add(v);
      else walk(v);
    }
  };
  walk(json);

  if (!found.has(teamKey)) {
    throw new YahooOwnershipError(
      `Connected Yahoo account does not manage team ${teamKey} in league ${leagueKey}`
    );
  }
}

/** Execute one write. Returns Yahoo's raw XML response text. */
export async function executeYahooAction(
  uid: string,
  action: YahooAction,
  creds: YahooCreds
): Promise<{ response: string }> {
  const opened = await openSession(uid, creds);
  if (!opened) throw new YahooNotConnectedError("No Yahoo account connected");

  // Validate BEFORE the ownership round trip — a malformed action shouldn't
  // cost a Yahoo call to find out.
  const req = buildYahooAction(action);
  const target = yahooOwnershipTarget(action);
  await assertTeamOwnership(opened.session, target.leagueKey, target.teamKey);

  try {
    const response = (await yahooCall(opened.session, req)) as string;
    await setYahooVerified(uid, true).catch(() => undefined);
    // The write landed; anything cached that describes the old state is now
    // a lie. Invalidate before returning so the caller's immediate re-read
    // sees the change rather than the pre-write snapshot.
    await invalidateCache(uid, yahooCacheInvalidations(action));
    return { response };
  } catch (e) {
    if (e instanceof YahooAuthError) {
      await setYahooVerified(uid, false).catch(() => undefined);
    }
    throw e;
  }
}

/** Execute one allowlisted read, served from cache when fresh. */
export async function executeYahooQuery(
  uid: string,
  query: YahooQuery,
  creds: YahooCreds,
  force = false
): Promise<{ data: Record<string, unknown>; cached: boolean }> {
  const built = buildYahooQuery(query); // validates params, throws ValidationError

  if (!force) {
    const hit = await readCache(uid, built.cacheKey);
    if (hit) return { data: hit, cached: true };
  }

  const opened = await openSession(uid, creds);
  if (!opened) throw new YahooNotConnectedError("No Yahoo account connected");

  try {
    const data = (await yahooCall(opened.session, { path: built.path })) as Record<
      string,
      unknown
    >;
    await writeCache(uid, built.cacheKey, data, built.ttlMs);
    await setYahooVerified(uid, true).catch(() => undefined);
    return { data, cached: false };
  } catch (e) {
    if (e instanceof YahooAuthError) {
      await setYahooVerified(uid, false).catch(() => undefined);
    }
    throw e;
  }
}
