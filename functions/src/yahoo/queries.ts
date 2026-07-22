// ═══════════════════════════════════════════════════════════════
// Yahoo read-query registry.
// ═══════════════════════════════════════════════════════════════
// Same allowlist discipline as sleeper/queries.ts: the client names a query
// type and validated params, never a URL. This is what stops `yahooRead`
// from becoming an open proxy that anyone with a Vault login can point at
// arbitrary Yahoo endpoints using someone else's OAuth grant.
//
// Each entry also declares its cache TTL. On Sleeper these reads were free
// browser fetches; on Yahoo every one is a billed invocation, so caching is
// part of the contract rather than an optimisation bolted on later.

import { ValidationError } from "./mutations";
import {
  YAHOO_NFL_GAME_KEY,
  YAHOO_PLAYER_PAGE_SIZE,
  YAHOO_MAX_PLAYER_PAGES,
} from "../config";

export interface MyLeaguesQuery {
  type: "my_leagues";
  /** Season year; omit for the current Yahoo NFL game. */
  season?: number;
}
export interface LeagueSettingsQuery {
  type: "league_settings";
  leagueKey: string;
}
export interface LeagueTeamsQuery {
  type: "league_teams";
  leagueKey: string;
}
export interface LeagueStandingsQuery {
  type: "league_standings";
  leagueKey: string;
}
export interface TeamRosterQuery {
  type: "team_roster";
  teamKey: string;
  week?: number;
}
export interface ScoreboardQuery {
  type: "scoreboard";
  leagueKey: string;
  week?: number;
}
export interface FreeAgentsQuery {
  type: "free_agents";
  leagueKey: string;
  /** 'A' all available, 'FA' free agents, 'W' waivers, 'T' taken, 'K' keepers. */
  status?: string;
  /** Page offset in players; Yahoo pages at 25. */
  start?: number;
  position?: string;
}
export interface TransactionsQuery {
  type: "transactions";
  leagueKey: string;
  /** e.g. ["add","drop","trade"]; omit for all. */
  types?: string[];
  count?: number;
}
export interface PendingTradesQuery {
  type: "pending_trades";
  leagueKey: string;
  teamKey: string;
}
export interface DraftResultsQuery {
  type: "draft_results";
  leagueKey: string;
}

export type YahooQuery =
  | MyLeaguesQuery
  | LeagueSettingsQuery
  | LeagueTeamsQuery
  | LeagueStandingsQuery
  | TeamRosterQuery
  | ScoreboardQuery
  | FreeAgentsQuery
  | TransactionsQuery
  | PendingTradesQuery
  | DraftResultsQuery;

export type YahooQueryType = YahooQuery["type"];

export const SUPPORTED_YAHOO_QUERIES: YahooQueryType[] = [
  "my_leagues",
  "league_settings",
  "league_teams",
  "league_standings",
  "team_roster",
  "scoreboard",
  "free_agents",
  "transactions",
  "pending_trades",
  "draft_results",
];

/**
 * Cache TTLs in ms, per query type. Tuned to how fast each resource actually
 * moves: settings are effectively static for a season, rosters change the
 * moment the user acts (and are invalidated explicitly on write), live
 * scoreboards move every few minutes.
 */
export const YAHOO_CACHE_TTL: Record<YahooQueryType, number> = {
  my_leagues: 60 * 60 * 1000, // 1h
  league_settings: 24 * 60 * 60 * 1000, // 24h
  league_teams: 60 * 60 * 1000, // 1h
  league_standings: 30 * 60 * 1000, // 30m
  team_roster: 5 * 60 * 1000, // 5m — busted on every write
  scoreboard: 5 * 60 * 1000, // 5m
  free_agents: 15 * 60 * 1000, // 15m
  transactions: 10 * 60 * 1000, // 10m
  pending_trades: 2 * 60 * 1000, // 2m — the user is waiting on these
  draft_results: 30 * 1000, // 30s — the live-draft poll cadence
};

// ── Validation ────────────────────────────────────────────────
// Yahoo keys are structured and predictable, so validate the SHAPE rather
// than just "is a string". A key is what gets interpolated into the request
// path, and anything permitting `/` or `?` there would let a caller escape
// the resource they named into one they didn't.

const LEAGUE_KEY = /^[a-z0-9]+\.l\.\d+$/i; // nfl.l.123456
const TEAM_KEY = /^[a-z0-9]+\.l\.\d+\.t\.\d+$/i; // nfl.l.123456.t.7

function requireLeagueKey(x: unknown): string {
  const s = String(x ?? "");
  if (!LEAGUE_KEY.test(s)) throw new ValidationError(`Invalid league key: ${s || "(empty)"}`);
  return s;
}
function requireTeamKey(x: unknown): string {
  const s = String(x ?? "");
  if (!TEAM_KEY.test(s)) throw new ValidationError(`Invalid team key: ${s || "(empty)"}`);
  return s;
}
function optWeek(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 1 || n > 25) throw new ValidationError("week must be 1-25");
  return n;
}
function optToken(x: unknown, name: string, allowed: RegExp): string | null {
  if (x == null) return null;
  const s = String(x);
  if (!allowed.test(s)) throw new ValidationError(`Invalid ${name}: ${s}`);
  return s;
}

export interface BuiltQuery {
  path: string;
  /** Stable cache key — same inputs must produce the same string. */
  cacheKey: string;
  ttlMs: number;
}

export function buildYahooQuery(q: YahooQuery): BuiltQuery {
  const ttlMs = YAHOO_CACHE_TTL[q.type];
  const done = (path: string, cacheKey: string): BuiltQuery => ({ path, cacheKey, ttlMs });

  switch (q.type) {
    case "my_leagues": {
      // `use_login=1` scopes this to the consenting user — the only read that
      // resolves identity rather than taking a key from the caller.
      const gameKey =
        q.season && Number.isInteger(q.season) ? String(q.season) : YAHOO_NFL_GAME_KEY;
      const safe = optToken(gameKey, "season", /^[a-z0-9]{3,6}$/i) ?? YAHOO_NFL_GAME_KEY;
      return done(
        `users;use_login=1/games;game_keys=${safe}/leagues`,
        `my_leagues:${safe}`
      );
    }
    case "league_settings": {
      const k = requireLeagueKey(q.leagueKey);
      return done(`league/${k}/settings`, `league_settings:${k}`);
    }
    case "league_teams": {
      const k = requireLeagueKey(q.leagueKey);
      return done(`league/${k}/teams`, `league_teams:${k}`);
    }
    case "league_standings": {
      const k = requireLeagueKey(q.leagueKey);
      return done(`league/${k}/standings`, `league_standings:${k}`);
    }
    case "team_roster": {
      const k = requireTeamKey(q.teamKey);
      const w = optWeek(q.week);
      return done(
        `team/${k}/roster${w ? `;week=${w}` : ""}`,
        `team_roster:${k}:${w ?? "cur"}`
      );
    }
    case "scoreboard": {
      const k = requireLeagueKey(q.leagueKey);
      const w = optWeek(q.week);
      return done(
        `league/${k}/scoreboard${w ? `;week=${w}` : ""}`,
        `scoreboard:${k}:${w ?? "cur"}`
      );
    }
    case "free_agents": {
      const k = requireLeagueKey(q.leagueKey);
      const status = optToken(q.status, "status", /^(A|FA|W|T|K)$/) ?? "A";
      const position = optToken(q.position, "position", /^[A-Z/]{1,8}$/);
      // Yahoo hard-caps a player page at 25 and ignores larger counts, so the
      // caller pages with `start`. Bound it — an unbounded start is a way to
      // make us walk Yahoo's whole player universe one invocation at a time.
      const rawStart = Number(q.start ?? 0);
      const maxStart = YAHOO_PLAYER_PAGE_SIZE * (YAHOO_MAX_PLAYER_PAGES - 1);
      if (!Number.isInteger(rawStart) || rawStart < 0 || rawStart > maxStart) {
        throw new ValidationError(`start must be 0-${maxStart}`);
      }
      const start = Math.floor(rawStart / YAHOO_PLAYER_PAGE_SIZE) * YAHOO_PLAYER_PAGE_SIZE;
      const posPart = position ? `;position=${position}` : "";
      return done(
        `league/${k}/players;start=${start};count=${YAHOO_PLAYER_PAGE_SIZE};status=${status}${posPart}/percent_owned`,
        `free_agents:${k}:${status}:${position ?? "all"}:${start}`
      );
    }
    case "transactions": {
      const k = requireLeagueKey(q.leagueKey);
      const types = Array.isArray(q.types)
        ? q.types.filter((t) => /^(add|drop|commish|trade)$/.test(String(t)))
        : [];
      const count = Number.isInteger(q.count) ? Math.min(Math.max(q.count as number, 1), 200) : 50;
      const typePart = types.length ? `;types=${types.join(",")}` : "";
      return done(
        `league/${k}/transactions${typePart};count=${count}`,
        `transactions:${k}:${types.join(",") || "all"}:${count}`
      );
    }
    case "pending_trades": {
      const k = requireLeagueKey(q.leagueKey);
      const t = requireTeamKey(q.teamKey);
      return done(
        `league/${k}/transactions;team_key=${t};type=pending_trade`,
        `pending_trades:${k}:${t}`
      );
    }
    case "draft_results": {
      const k = requireLeagueKey(q.leagueKey);
      return done(`league/${k}/draftresults`, `draft_results:${k}`);
    }
    default: {
      const _exhaustive: never = q;
      throw new ValidationError(`Unsupported query: ${(_exhaustive as any)?.type}`);
    }
  }
}
