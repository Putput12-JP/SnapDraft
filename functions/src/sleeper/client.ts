// ═══════════════════════════════════════════════════════════════
// Low-level Sleeper GraphQL client (server-to-server).
// ═══════════════════════════════════════════════════════════════
// Mirrors how the Sleeper app itself calls its private GraphQL API:
//   POST https://sleeper.com/graphql
//   headers: Content-Type, authorization: <token>, x-sleeper-graphql-op: <op>
//   body: { query, variables }
//
// This module is intentionally framework-agnostic (no Firebase imports)
// so it can be reused or ported.

import { SLEEPER_GRAPHQL_URL, SLEEPER_PUBLIC_API } from "../config";

export class SleeperAuthError extends Error {}
export class SleeperApiError extends Error {}

export interface GraphQLRequest {
  op: string; // operation name -> also sent as x-sleeper-graphql-op
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * Fire a single GraphQL operation against Sleeper with the user's token.
 * Throws SleeperAuthError on 401/auth failures (token expired / revoked),
 * SleeperApiError on any other GraphQL or HTTP error.
 * Returns the `data` payload.
 */
export async function sleeperGraphQL(
  token: string,
  req: GraphQLRequest
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(SLEEPER_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: token,
        "x-sleeper-graphql-op": req.op,
      },
      body: JSON.stringify({ query: req.query, variables: req.variables ?? {} }),
    });
  } catch (e) {
    throw new SleeperApiError(`Network error calling Sleeper: ${(e as Error).message}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new SleeperAuthError(`Sleeper rejected the token (HTTP ${resp.status})`);
  }

  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SleeperApiError(`Sleeper returned non-JSON (HTTP ${resp.status})`);
  }

  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
    // Sleeper surfaces auth problems as GraphQL errors too.
    if (/unauth|token|forbidden|permission/i.test(msg)) {
      throw new SleeperAuthError(msg || "Sleeper authorization error");
    }
    throw new SleeperApiError(msg || "Sleeper GraphQL error");
  }

  if (!resp.ok) {
    throw new SleeperApiError(`Sleeper HTTP ${resp.status}`);
  }

  return (json?.data ?? {}) as Record<string, unknown>;
}

// ── Public read API helpers (no auth) — used for ownership checks ──

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  co_owners: string[] | null;
  starters: string[] | null;
  players: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
}

export async function fetchLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
  const resp = await fetch(`${SLEEPER_PUBLIC_API}/league/${encodeURIComponent(leagueId)}/rosters`);
  if (!resp.ok) throw new SleeperApiError(`Failed to load rosters for league ${leagueId}`);
  return (await resp.json()) as SleeperRoster[];
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
}

/** Resolve a Sleeper username -> user object via the public API. */
export async function fetchUserByUsername(username: string): Promise<SleeperUser | null> {
  const resp = await fetch(`${SLEEPER_PUBLIC_API}/user/${encodeURIComponent(username)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new SleeperApiError(`Failed to resolve Sleeper username ${username}`);
  const u = (await resp.json()) as any;
  return u && u.user_id ? { user_id: u.user_id, username: u.username, display_name: u.display_name } : null;
}
