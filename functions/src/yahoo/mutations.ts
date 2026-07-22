// ═══════════════════════════════════════════════════════════════
// Yahoo write-action registry.
// ═══════════════════════════════════════════════════════════════
// Mirrors sleeper/mutations.ts: every supported write is defined here as
// how to validate its params, how to build the exact request, and which
// team the caller must own.
//
// Unlike Sleeper's GraphQL, Yahoo takes XML bodies — and unlike Sleeper,
// these shapes are OFFICIALLY DOCUMENTED rather than reverse-engineered, so
// they can be relied on rather than re-verified each season.
//
// Endpoint map:
//   lineup            PUT  team/{teamKey}/roster
//   add/drop/waiver   POST league/{leagueKey}/transactions
//   propose trade     POST league/{leagueKey}/transactions
//   accept/reject     PUT  transaction/{transactionKey}

import { YahooRequest } from "./client";

export class ValidationError extends Error {}

// ── Action param types (discriminated union on `type`) ────────────

export interface YahooLineupSlot {
  playerKey: string;
  /** Yahoo slot label: QB, RB, WR, TE, W/R/T, Q/W/R/T, K, DEF, BN, IR. */
  position: string;
}
export interface SetLineupAction {
  type: "set_lineup";
  leagueKey: string;
  teamKey: string;
  /** Target week. Yahoo also supports date coverage; NFL is week-based. */
  week: number;
  /** FULL slotting for the week — every rostered player with its slot. */
  slots: YahooLineupSlot[];
}
export interface AddPlayerAction {
  type: "add_player";
  leagueKey: string;
  teamKey: string;
  playerKey: string;
  /** FAAB bid. Present => waiver claim; absent => straight free-agent add. */
  faabBid?: number;
}
export interface DropPlayerAction {
  type: "drop_player";
  leagueKey: string;
  teamKey: string;
  playerKey: string;
}
export interface AddDropAction {
  type: "add_drop";
  leagueKey: string;
  teamKey: string;
  addPlayerKey: string;
  dropPlayerKey: string;
  faabBid?: number;
}
export interface ProposeTradeAction {
  type: "propose_trade";
  leagueKey: string;
  /** Proposing team — must be the caller's. */
  teamKey: string;
  tradeeTeamKey: string;
  /** Player keys leaving the caller's roster. */
  sendPlayerKeys: string[];
  /** Player keys the caller receives. */
  receivePlayerKeys: string[];
  note?: string;
}
export interface RespondTradeAction {
  type: "respond_trade";
  leagueKey: string;
  teamKey: string;
  transactionKey: string;
  action: "accept" | "reject";
  note?: string;
}

export type YahooAction =
  | SetLineupAction
  | AddPlayerAction
  | DropPlayerAction
  | AddDropAction
  | ProposeTradeAction
  | RespondTradeAction;

export type YahooActionType = YahooAction["type"];

export const SUPPORTED_YAHOO_ACTIONS: YahooActionType[] = [
  "set_lineup",
  "add_player",
  "drop_player",
  "add_drop",
  "propose_trade",
  "respond_trade",
];

// ── Validation ────────────────────────────────────────────────

const LEAGUE_KEY = /^[a-z0-9]+\.l\.\d+$/i;
const TEAM_KEY = /^[a-z0-9]+\.l\.\d+\.t\.\d+$/i;
const PLAYER_KEY = /^[a-z0-9]+\.p\.\d+$/i;
const TRANSACTION_KEY = /^[a-z0-9]+\.l\.\d+\.pt\.\d+$/i;
// Yahoo slot labels, including the multi-position flexes. Q/W/R/T is the
// superflex slot — the one that decides whether a league is priced on the
// SF board, so it has to survive validation intact.
const POSITION = /^(QB|RB|WR|TE|K|DEF|DL|LB|DB|D|IR|IL|BN|W\/R|W\/T|W\/R\/T|Q\/W\/R\/T|R\/W\/T)$/i;

function requireMatch(x: unknown, re: RegExp, name: string): string {
  const s = String(x ?? "");
  if (!re.test(s)) throw new ValidationError(`Invalid ${name}: ${s || "(empty)"}`);
  return s;
}
function requireKeyArray(x: unknown, name: string): string[] {
  if (!Array.isArray(x)) throw new ValidationError(`${name} must be an array`);
  return x.map((k) => requireMatch(k, PLAYER_KEY, `${name} entry`));
}
function optFaab(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new ValidationError("faabBid must be an integer 0-10000");
  }
  return n;
}
/** Yahoo takes XML, so anything interpolated must be escaped, not trusted. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Which team must the caller own for this action? Checked against the
 * connected Yahoo account before anything is sent, same as Sleeper's
 * roster-ownership check — the token being theirs isn't the same as the
 * target being theirs.
 */
export function yahooOwnershipTarget(a: YahooAction): { leagueKey: string; teamKey: string } {
  return {
    leagueKey: requireMatch((a as any).leagueKey, LEAGUE_KEY, "leagueKey"),
    teamKey: requireMatch((a as any).teamKey, TEAM_KEY, "teamKey"),
  };
}

/**
 * Which cached reads does this action invalidate? Returned as cache-key
 * PREFIXES. Skipping this is how you ship a "push succeeded" toast over a
 * roster that still renders the pre-write lineup for five minutes.
 */
export function yahooCacheInvalidations(a: YahooAction): string[] {
  const league = (a as any).leagueKey as string;
  const team = (a as any).teamKey as string;
  switch (a.type) {
    case "set_lineup":
      return [`team_roster:${team}`];
    case "add_player":
    case "drop_player":
    case "add_drop":
      return [`team_roster:${team}`, `free_agents:${league}`, `transactions:${league}`];
    case "propose_trade":
    case "respond_trade":
      return [`pending_trades:${league}`, `transactions:${league}`, `team_roster:${team}`];
    default:
      return [];
  }
}

// ── Request builders ──────────────────────────────────────────

const WRAP = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<fantasy_content>${inner}</fantasy_content>`;

/** One `<player>` block inside a transaction. */
function txPlayer(playerKey: string, action: "add" | "drop", teamKey: string): string {
  // add -> the player lands on your team; drop -> the player leaves it.
  const teamEl = action === "add" ? "destination_team_key" : "source_team_key";
  return (
    `<player>` +
    `<player_key>${esc(playerKey)}</player_key>` +
    `<transaction_data>` +
    `<type>${action}</type>` +
    `<${teamEl}>${esc(teamKey)}</${teamEl}>` +
    `</transaction_data>` +
    `</player>`
  );
}

export function buildYahooAction(a: YahooAction): YahooRequest {
  switch (a.type) {
    case "set_lineup": {
      const teamKey = requireMatch(a.teamKey, TEAM_KEY, "teamKey");
      const week = Number(a.week);
      if (!Number.isInteger(week) || week < 1 || week > 25) {
        throw new ValidationError("week must be 1-25");
      }
      if (!Array.isArray(a.slots) || a.slots.length === 0) {
        throw new ValidationError("slots must be a non-empty array");
      }
      const players = a.slots
        .map((s) => {
          const pk = requireMatch(s?.playerKey, PLAYER_KEY, "slot playerKey");
          const pos = requireMatch(s?.position, POSITION, "slot position");
          return `<player><player_key>${esc(pk)}</player_key><position>${esc(pos)}</position></player>`;
        })
        .join("");
      return {
        path: `team/${teamKey}/roster`,
        method: "PUT",
        xml: WRAP(
          `<roster><coverage_type>week</coverage_type><week>${week}</week>` +
            `<players>${players}</players></roster>`
        ),
      };
    }

    case "add_player": {
      const leagueKey = requireMatch(a.leagueKey, LEAGUE_KEY, "leagueKey");
      const teamKey = requireMatch(a.teamKey, TEAM_KEY, "teamKey");
      const playerKey = requireMatch(a.playerKey, PLAYER_KEY, "playerKey");
      const faab = optFaab(a.faabBid);
      return {
        path: `league/${leagueKey}/transactions`,
        method: "POST",
        xml: WRAP(
          `<transaction><type>add</type>` +
            (faab != null ? `<faab_bid>${faab}</faab_bid>` : "") +
            txPlayer(playerKey, "add", teamKey) +
            `</transaction>`
        ),
      };
    }

    case "drop_player": {
      const leagueKey = requireMatch(a.leagueKey, LEAGUE_KEY, "leagueKey");
      const teamKey = requireMatch(a.teamKey, TEAM_KEY, "teamKey");
      const playerKey = requireMatch(a.playerKey, PLAYER_KEY, "playerKey");
      return {
        path: `league/${leagueKey}/transactions`,
        method: "POST",
        xml: WRAP(
          `<transaction><type>drop</type>` +
            txPlayer(playerKey, "drop", teamKey) +
            `</transaction>`
        ),
      };
    }

    case "add_drop": {
      const leagueKey = requireMatch(a.leagueKey, LEAGUE_KEY, "leagueKey");
      const teamKey = requireMatch(a.teamKey, TEAM_KEY, "teamKey");
      const addKey = requireMatch(a.addPlayerKey, PLAYER_KEY, "addPlayerKey");
      const dropKey = requireMatch(a.dropPlayerKey, PLAYER_KEY, "dropPlayerKey");
      if (addKey === dropKey) throw new ValidationError("Cannot add and drop the same player");
      const faab = optFaab(a.faabBid);
      // Paired moves nest both players under <players>; single moves put the
      // one <player> directly under <transaction>. Yahoo rejects the mix-up.
      return {
        path: `league/${leagueKey}/transactions`,
        method: "POST",
        xml: WRAP(
          `<transaction><type>add/drop</type>` +
            (faab != null ? `<faab_bid>${faab}</faab_bid>` : "") +
            `<players>` +
            txPlayer(addKey, "add", teamKey) +
            txPlayer(dropKey, "drop", teamKey) +
            `</players></transaction>`
        ),
      };
    }

    case "propose_trade": {
      const leagueKey = requireMatch(a.leagueKey, LEAGUE_KEY, "leagueKey");
      const teamKey = requireMatch(a.teamKey, TEAM_KEY, "teamKey");
      const tradee = requireMatch(a.tradeeTeamKey, TEAM_KEY, "tradeeTeamKey");
      if (tradee === teamKey) throw new ValidationError("Cannot trade with yourself");
      const send = requireKeyArray(a.sendPlayerKeys, "sendPlayerKeys");
      const receive = requireKeyArray(a.receivePlayerKeys, "receivePlayerKeys");
      if (send.length === 0 && receive.length === 0) {
        throw new ValidationError("A trade needs at least one player");
      }
      const note = String(a.note ?? "").slice(0, 500);
      const players =
        send
          .map(
            (pk) =>
              `<player><player_key>${esc(pk)}</player_key><transaction_data>` +
              `<type>pending_trade</type>` +
              `<source_team_key>${esc(teamKey)}</source_team_key>` +
              `<destination_team_key>${esc(tradee)}</destination_team_key>` +
              `</transaction_data></player>`
          )
          .join("") +
        receive
          .map(
            (pk) =>
              `<player><player_key>${esc(pk)}</player_key><transaction_data>` +
              `<type>pending_trade</type>` +
              `<source_team_key>${esc(tradee)}</source_team_key>` +
              `<destination_team_key>${esc(teamKey)}</destination_team_key>` +
              `</transaction_data></player>`
          )
          .join("");
      return {
        path: `league/${leagueKey}/transactions`,
        method: "POST",
        xml: WRAP(
          `<transaction><type>pending_trade</type>` +
            `<trader_team_key>${esc(teamKey)}</trader_team_key>` +
            `<tradee_team_key>${esc(tradee)}</tradee_team_key>` +
            `<trade_note>${esc(note)}</trade_note>` +
            `<players>${players}</players></transaction>`
        ),
      };
    }

    case "respond_trade": {
      const txKey = requireMatch(a.transactionKey, TRANSACTION_KEY, "transactionKey");
      if (a.action !== "accept" && a.action !== "reject") {
        throw new ValidationError("action must be accept or reject");
      }
      const note = String(a.note ?? "").slice(0, 500);
      return {
        path: `transaction/${txKey}`,
        method: "PUT",
        xml: WRAP(
          `<transaction>` +
            `<transaction_key>${esc(txKey)}</transaction_key>` +
            `<type>pending_trade</type>` +
            `<action>${a.action}</action>` +
            `<trade_note>${esc(note)}</trade_note>` +
            `</transaction>`
        ),
      };
    }

    default: {
      const _exhaustive: never = a;
      throw new ValidationError(`Unsupported action: ${(_exhaustive as any)?.type}`);
    }
  }
}
