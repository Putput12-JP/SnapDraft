// ═══════════════════════════════════════════════════════════════
// Core action executor — shared by the instant + queued paths.
// ═══════════════════════════════════════════════════════════════
// Given a Vault uid and a validated action:
//   1. Confirm the caller actually owns the target roster (defense in
//      depth — the token is theirs, but we never write to a roster the
//      connected Sleeper user doesn't own/co-own).
//   2. Decrypt the token in-memory.
//   3. Build + fire the exact Sleeper GraphQL mutation.
//   4. On auth failure, flag the connection unverified so the UI can
//      prompt a reconnect.

import {
  SleeperAction,
  buildAction,
  buildMatchupLegRequest,
  MATCHUP_LEG_NOT_FOUND,
  ownershipTarget,
} from "./sleeper/mutations";
import { SleeperQuery, buildQuery } from "./sleeper/queries";
import {
  sleeperGraphQL,
  fetchLeagueRosters,
  SleeperAuthError,
  SleeperApiError,
} from "./sleeper/client";
import { getToken, setVerified } from "./lib/tokens";

export class OwnershipError extends Error {}
export class NotConnectedError extends Error {}

async function assertOwnership(
  leagueId: string,
  rosterId: number,
  sleeperUserId: string
): Promise<void> {
  const rosters = await fetchLeagueRosters(leagueId);
  const target = rosters.find((r) => r.roster_id === rosterId);
  if (!target) {
    throw new OwnershipError(`Roster ${rosterId} not found in league ${leagueId}`);
  }
  const owners = new Set<string>([
    ...(target.owner_id ? [String(target.owner_id)] : []),
    ...((target.co_owners ?? []).map(String)),
  ]);
  if (!owners.has(String(sleeperUserId))) {
    throw new OwnershipError(
      `Connected Sleeper user ${sleeperUserId} does not own roster ${rosterId} in league ${leagueId}`
    );
  }
}

/**
 * Execute one action for a user. Returns Sleeper's `data` payload.
 * Throws NotConnectedError / OwnershipError / ValidationError /
 * SleeperAuthError / SleeperApiError.
 */
export async function executeAction(
  uid: string,
  action: SleeperAction,
  hexKey: string
): Promise<Record<string, unknown>> {
  const conn = await getToken(uid, hexKey);
  if (!conn) throw new NotConnectedError("No Sleeper account connected");

  const target = ownershipTarget(action);
  if (target) {
    await assertOwnership(target.leagueId, target.rosterId, conn.sleeperUserId);
  }

  const req = buildAction(action); // validates params, throws ValidationError

  try {
    // Lineup writes targeting a week go to the matchup leg first — that's the
    // record the Sleeper app displays. roster_update_starters alone only sets
    // the roster-level default and is invisible in-app once legs exist.
    if (action.type === "update_starters" && action.leg != null) {
      try {
        const legData = await sleeperGraphQL(conn.token, buildMatchupLegRequest(action));
        if (legData.update_matchup_leg) return legData;
        // Null payload: leg write didn't take — fall through to roster write.
      } catch (e) {
        if (!(e instanceof SleeperApiError) || !MATCHUP_LEG_NOT_FOUND.test(e.message)) throw e;
        // Leg doesn't exist (pre-season / legs not generated) — roster write
        // below is the correct target.
      }
    }
    return await sleeperGraphQL(conn.token, req);
  } catch (e) {
    if (e instanceof SleeperAuthError) {
      // Token no longer valid — flag for reconnect.
      await setVerified(uid, false).catch(() => undefined);
    }
    throw e;
  }
}

/**
 * Execute one read-only query for a user. Reads are scoped by Sleeper to the
 * token's own visibility, so there is no ownership check and no throttle.
 */
export async function executeQuery(
  uid: string,
  query: SleeperQuery,
  hexKey: string
): Promise<Record<string, unknown>> {
  const conn = await getToken(uid, hexKey);
  if (!conn) throw new NotConnectedError("No Sleeper account connected");

  const req = buildQuery(query); // validates params, throws ValidationError

  try {
    return await sleeperGraphQL(conn.token, req);
  } catch (e) {
    if (e instanceof SleeperAuthError) {
      await setVerified(uid, false).catch(() => undefined);
    }
    throw e;
  }
}
