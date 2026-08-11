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
      const data = await fetchEspnLeague(cookies, season, leagueId, views);
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
