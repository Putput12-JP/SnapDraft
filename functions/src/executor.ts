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

import { SleeperAction, buildAction, ownershipTarget } from "./sleeper/mutations";
import { sleeperGraphQL, fetchLeagueRosters, SleeperAuthError } from "./sleeper/client";
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
    return await sleeperGraphQL(conn.token, req);
  } catch (e) {
    if (e instanceof SleeperAuthError) {
      // Token no longer valid — flag for reconnect.
      await setVerified(uid, false).catch(() => undefined);
    }
    throw e;
  }
}
