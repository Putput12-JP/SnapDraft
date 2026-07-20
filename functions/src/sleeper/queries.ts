// ═══════════════════════════════════════════════════════════════
// Sleeper read-query registry.
// ═══════════════════════════════════════════════════════════════
// Authenticated reads Vault needs that the public REST API doesn't expose
// (pending trade offers, draft queues). Same allowlist discipline as the
// write registry: only ops defined here can run, with validated params.
// Reads are safe + idempotent so they skip the per-user write throttle.

import { GraphQLRequest } from "./client";
import { ValidationError } from "./mutations";

export interface LeagueTransactionsQuery {
  type: "league_transactions";
  leagueId: string;
  limit?: number; // default 100
  statuses?: string[]; // e.g. ["proposed"]; omit for all
  types?: string[]; // e.g. ["trade","waiver"]; omit for all
}
export interface DraftQueueQuery {
  type: "draft_queue";
  draftId: string;
}

export type SleeperQuery = LeagueTransactionsQuery | DraftQueueQuery;
export type QueryType = SleeperQuery["type"];

export const SUPPORTED_QUERIES: QueryType[] = ["league_transactions", "draft_queue"];

function requireStr(x: unknown, name: string): string {
  if (typeof x !== "string" || !x) throw new ValidationError(`${name} is required`);
  return x;
}
function optStrArray(x: unknown, name: string): string[] | null {
  if (x == null) return null;
  if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) {
    throw new ValidationError(`${name} must be an array of strings`);
  }
  return x as string[];
}

const TXN_FIELDS =
  "transaction_id type status leg created status_updated creator roster_ids consenter_ids adds drops draft_picks waiver_budget metadata settings";

export function buildQuery(q: SleeperQuery): GraphQLRequest {
  switch (q.type) {
    case "league_transactions": {
      const leagueId = requireStr(q.leagueId, "leagueId");
      const limit = Number.isInteger(q.limit) && (q.limit as number) > 0 ? Math.min(q.limit as number, 500) : 100;
      const statuses = optStrArray(q.statuses, "statuses");
      const types = optStrArray(q.types, "types");
      return {
        op: "league_transactions_filtered",
        query: `query league_transactions_filtered($league_id: Snowflake!, $limit: Int, $status_filters: [String], $type_filters: [String]) {
  league_transactions_filtered(league_id: $league_id, limit: $limit, status_filters: $status_filters, type_filters: $type_filters) { ${TXN_FIELDS} }
}`,
        variables: {
          league_id: leagueId,
          limit,
          status_filters: statuses,
          type_filters: types,
        },
      };
    }
    case "draft_queue": {
      const draftId = requireStr(q.draftId, "draftId");
      return {
        op: "draft_queue",
        query: `query draft_queue($draft_id: Snowflake!) {
  draft_queue(draft_id: $draft_id)
}`,
        variables: { draft_id: draftId },
      };
    }
    default: {
      const _exhaustive: never = q;
      throw new ValidationError(`Unsupported query: ${(_exhaustive as any)?.type}`);
    }
  }
}
