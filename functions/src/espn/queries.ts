// ═══════════════════════════════════════════════════════════════
// ESPN read queries — the allowlist espnRead() dispatches on.
// ═══════════════════════════════════════════════════════════════
// Deliberately thin. The server's job is only to attach cookies a browser
// can't; it returns ESPN's RAW v3 payload untouched so the frontend maps it
// with the SAME vpMapEspnLeague / buildEspnContext it already uses for public
// leagues. One id space, one mapper, no server-side normalisation to drift.

import { EspnCookies } from "../lib/espnTokens";
import {
  fetchEspnLeague,
  fetchEspnFanLeagues,
  EspnApiError,
} from "./client";
import { ESPN_LEAGUE_VIEWS } from "../config";

export type EspnQueryType = "league" | "fan_leagues";

export const SUPPORTED_ESPN_QUERIES: EspnQueryType[] = ["league", "fan_leagues"];

export interface EspnQuery {
  type: EspnQueryType;
  leagueId?: string;
  season?: string;
  /** Subset of ESPN_LEAGUE_VIEWS; anything outside the allowlist is dropped. */
  views?: string[];
  /** Bust ESPN's CDN so a live draft poll never lands a stale board. */
  fresh?: boolean;
}

const VIEW_ALLOWLIST = new Set<string>(ESPN_LEAGUE_VIEWS);

function cleanId(v: unknown): string {
  return String(v ?? "").replace(/[^0-9]/g, "");
}
function cleanSeason(v: unknown): string {
  const s = String(v ?? "").replace(/[^0-9]/g, "");
  return /^20\d\d$/.test(s) ? s : "";
}

/** Run one allowlisted query with the user's cookies. Returns raw ESPN JSON. */
export async function runEspnQuery(
  cookies: EspnCookies,
  q: EspnQuery
): Promise<{ data: unknown }> {
  switch (q.type) {
    case "league": {
      const leagueId = cleanId(q.leagueId);
      if (!leagueId) throw new EspnApiError("A leagueId is required.");
      const season = cleanSeason(q.season) || String(currentSeason());
      const views =
        Array.isArray(q.views) && q.views.length
          ? q.views.filter((v) => VIEW_ALLOWLIST.has(v))
          : ESPN_LEAGUE_VIEWS;
      const data = await fetchEspnLeague(cookies, season, leagueId, views, q.fresh === true);
      // Only the server knows the connected SWID, so only the server can say
      // which team is the user's. Tag it into the payload (double-underscore so
      // the frontend's ESPN mappers ignore it) → the client auto-selects it and
      // the league lands in the Command pages with no manual "pick your team".
      if (data && typeof data === "object") {
        const teamId = resolveMyTeamId(data, cookies.swid);
        if (teamId != null) (data as Record<string, unknown>).__vaultMyTeamId = teamId;
      }
      return { data };
    }
    case "fan_leagues": {
      const data = await fetchEspnFanLeagues(cookies);
      return { data };
    }
    default:
      throw new EspnApiError("Unknown ESPN query type.");
  }
}

/** NFL fantasy season rolls over ~August; before then the active season is last year. */
export function currentSeason(): number {
  const now = new Date();
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/**
 * Find which team the connected SWID owns. ESPN lists each team's owner SWIDs
 * on `owners[]` (and `primaryOwner`), so we match the stored cookie's SWID
 * against them. Case-insensitive because ESPN's owner ids and the pasted SWID
 * don't always agree on hex casing. Returns the numeric teamId or null (user
 * is a league viewer / co-manager not listed as an owner → fall back to a
 * manual pick).
 */
export function resolveMyTeamId(raw: unknown, swid: string): number | null {
  if (!raw || typeof raw !== "object") return null;
  const want = String(swid || "").toLowerCase();
  if (!want) return null;
  const teams = (raw as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return null;
  for (const t of teams) {
    const team = t as { id?: number; owners?: unknown; primaryOwner?: unknown };
    const owners = Array.isArray(team.owners) ? team.owners : [];
    if (owners.some((o) => String(o).toLowerCase() === want)) return team.id ?? null;
    if (team.primaryOwner && String(team.primaryOwner).toLowerCase() === want) {
      return team.id ?? null;
    }
  }
  return null;
}
