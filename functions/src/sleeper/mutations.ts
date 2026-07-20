// ═══════════════════════════════════════════════════════════════
// Sleeper write-action registry.
// ═══════════════════════════════════════════════════════════════
// Every supported write is defined here as: how to validate its params,
// how to build the exact GraphQL request, and which roster (if any) the
// caller must own. GraphQL shapes were reverse-engineered 1:1 from the
// Sleeper web client. Shapes marked "VERIFIED" have been executed live.

import { GraphQLRequest } from "./client";

// ── Action param types (discriminated union on `type`) ────────────
export interface UpdateStartersAction {
  type: "update_starters";
  leagueId: string;
  rosterId: number;
  starters: string[]; // full ordered starting lineup (player ids, slot order)
  // Target week. The Sleeper app displays the per-week matchup-leg lineup,
  // which is a separate record from roster.starters — when leg is set we
  // write the leg first (update_matchup_leg) and only fall back to the
  // roster-level default if the leg doesn't exist yet.
  leg?: number;
  round?: number; // defaults to leg
}
export interface UpdateTaxiAction {
  type: "update_taxi";
  leagueId: string;
  rosterId: number;
  taxi: string[]; // player ids on the taxi squad
}
export interface UpdateDraftQueueAction {
  type: "update_draft_queue";
  draftId: string;
  playerIds: string[];
}
export interface AcceptTradeAction {
  type: "accept_trade";
  leagueId: string;
  transactionId: string;
  leg: number;
}
export interface RejectTradeAction {
  type: "reject_trade";
  leagueId: string;
  transactionId: string;
  leg: number;
}
export interface SubmitWaiverAction {
  type: "submit_waiver_claim";
  leagueId: string;
  rosterId: number;
  // Sleeper encodes these as parallel key/value arrays. Adds/drops are
  // player_id -> roster_id; settings carry e.g. {"waiver_bid": <faab>}.
  adds?: Record<string, number>;
  drops?: Record<string, number>;
  settings?: Record<string, number>;
}
export interface ProposeTradeAction {
  type: "propose_trade";
  leagueId: string;
  rosterId: number; // proposer roster (used for ownership check)
  rosterIds: number[]; // all rosters party to the trade
  adds?: Record<string, number>; // player_id -> destination roster_id
  drops?: Record<string, number>; // player_id -> source roster_id
  draftPicks?: unknown[]; // sleeper draft-pick objects
  waiverBudget?: unknown[]; // faab transfers
}
export interface CancelTransactionAction {
  type: "cancel_transaction"; // force_cancel_transaction: withdraw own trade offer
  leagueId: string;
  transactionId: string;
  leg: number;
}
export interface CancelWaiverClaimAction {
  type: "cancel_waiver_claim";
  leagueId: string;
  transactionId: string;
  leg: number;
}
export interface UpdateWaiverClaimAction {
  type: "update_waiver_claim"; // edit an open claim's bid/settings
  leagueId: string;
  transactionId: string;
  leg: number;
  settings?: Record<string, number>; // e.g. {waiver_bid: 12}
  metadata?: Record<string, string>;
}
export interface DraftPickPlayerAction {
  type: "draft_pick_player"; // make a real draft pick (Sleeper enforces turn)
  draftId: string;
  playerId: string;
  pickNo: number;
}
export interface UpdateReserveAction {
  type: "update_reserve"; // set the IR slots (fix invalid IR from Vault)
  leagueId: string;
  rosterId: number;
  reserve: string[];
}
export interface TradeBlockAction {
  type: "add_trade_block" | "remove_trade_block";
  leagueId: string;
  playerId: string;
}

export type SleeperAction =
  | UpdateStartersAction
  | UpdateTaxiAction
  | UpdateDraftQueueAction
  | AcceptTradeAction
  | RejectTradeAction
  | SubmitWaiverAction
  | ProposeTradeAction
  | CancelTransactionAction
  | CancelWaiverClaimAction
  | UpdateWaiverClaimAction
  | DraftPickPlayerAction
  | UpdateReserveAction
  | TradeBlockAction;

export type ActionType = SleeperAction["type"];

export const SUPPORTED_ACTIONS: ActionType[] = [
  "update_starters",
  "update_taxi",
  "update_draft_queue",
  "accept_trade",
  "reject_trade",
  "submit_waiver_claim",
  "propose_trade",
  "cancel_transaction",
  "cancel_waiver_claim",
  "update_waiver_claim",
  "draft_pick_player",
  "update_reserve",
  "add_trade_block",
  "remove_trade_block",
];

// ── helpers ───────────────────────────────────────────────────
function kv(map?: Record<string, number>): { k: string[]; v: number[] } {
  const k: string[] = [];
  const v: number[] = [];
  for (const [key, val] of Object.entries(map ?? {})) {
    k.push(key);
    v.push(val);
  }
  return { k, v };
}

function requireStr(x: unknown, name: string): string {
  if (typeof x !== "string" || !x) throw new ValidationError(`${name} is required`);
  return x;
}
function requireInt(x: unknown, name: string): number {
  if (typeof x !== "number" || !Number.isInteger(x)) throw new ValidationError(`${name} must be an integer`);
  return x;
}
function requireStrArray(x: unknown, name: string): string[] {
  if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) {
    throw new ValidationError(`${name} must be an array of strings`);
  }
  return x as string[];
}

export class ValidationError extends Error {}

// Sleeper's error when the requested matchup leg doesn't exist (e.g. the
// week's legs haven't been generated yet) — the signal to fall back to the
// roster-level default write.
export const MATCHUP_LEG_NOT_FOUND = /could not find this matchup leg/i;

/**
 * The per-week lineup write, matching the Sleeper app 1:1. The app renders
 * this leg record (not roster.starters), so in-season lineup pushes must go
 * through it or they're invisible in the app.
 */
export function buildMatchupLegRequest(a: UpdateStartersAction): GraphQLRequest {
  const leagueId = requireStr(a.leagueId, "leagueId");
  const rosterId = requireInt(a.rosterId, "rosterId");
  const starters = requireStrArray(a.starters, "starters");
  const leg = requireInt(a.leg, "leg");
  const round = a.round != null ? requireInt(a.round, "round") : leg;
  return {
    op: "update_matchup_leg",
    query: `mutation update_matchup_leg($starters_games: Map) {
  update_matchup_leg(league_id: "${leagueId}", roster_id: ${rosterId}, leg: ${leg}, round: ${round}, starters: ${JSON.stringify(
      starters
    )}, starters_games: $starters_games) { league_id leg round roster_id starters }
}`,
  };
}

/**
 * The roster a caller must own for this action to be allowed, or null if
 * ownership isn't roster-scoped (e.g. draft queue).
 */
export function ownershipTarget(a: SleeperAction): { leagueId: string; rosterId: number } | null {
  switch (a.type) {
    case "update_starters":
    case "update_taxi":
    case "update_reserve":
    case "submit_waiver_claim":
    case "propose_trade":
      return { leagueId: a.leagueId, rosterId: a.rosterId };
    // accept/reject/cancel trade, waiver-claim edits, trade block, and draft
    // picks are authorized by Sleeper against the token's own rosters/turn;
    // draft queue is user-scoped. No local check.
    default:
      return null;
  }
}

/** Validate params and build the exact Sleeper GraphQL request. */
export function buildAction(a: SleeperAction): GraphQLRequest {
  switch (a.type) {
    // ── VERIFIED live ──────────────────────────────────────────
    case "update_starters": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const rosterId = requireInt(a.rosterId, "rosterId");
      const starters = requireStrArray(a.starters, "starters");
      if (a.leg != null) requireInt(a.leg, "leg");
      if (a.round != null) requireInt(a.round, "round");
      return {
        op: "roster_update_starters",
        query: `mutation roster_update_starters {
  roster_update_starters(league_id: "${leagueId}", roster_id: ${rosterId}, starters: ${JSON.stringify(
          starters
        )}) { league_id roster_id starters }
}`,
      };
    }
    case "update_taxi": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const rosterId = requireInt(a.rosterId, "rosterId");
      const taxi = requireStrArray(a.taxi, "taxi");
      return {
        op: "roster_update_taxi",
        query: `mutation roster_update_taxi {
  roster_update_taxi(league_id: "${leagueId}", roster_id: ${rosterId}, taxi: ${JSON.stringify(
          taxi
        )}) { league_id roster_id taxi }
}`,
      };
    }
    case "update_draft_queue": {
      const draftId = requireStr(a.draftId, "draftId");
      const playerIds = requireStrArray(a.playerIds, "playerIds");
      return {
        op: "update_draft_queue",
        query: `mutation update_draft_queue($draft_id: ID!, $player_ids: [String!]!) {
  update_draft_queue(player_ids: $player_ids, draft_id: $draft_id)
}`,
        variables: { draft_id: draftId, player_ids: playerIds },
      };
    }
    case "accept_trade": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const transactionId = requireStr(a.transactionId, "transactionId");
      const leg = requireInt(a.leg, "leg");
      return {
        op: "accept_trade",
        query: `mutation accept_trade {
  accept_trade(league_id: "${leagueId}", transaction_id: "${transactionId}", leg: ${leg}) { transaction_id status leg }
}`,
      };
    }
    case "reject_trade": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const transactionId = requireStr(a.transactionId, "transactionId");
      const leg = requireInt(a.leg, "leg");
      return {
        op: "reject_trade",
        query: `mutation reject_trade {
  reject_trade(league_id: "${leagueId}", transaction_id: "${transactionId}", leg: ${leg}) { transaction_id status leg }
}`,
      };
    }
    // ── Shapes confirmed from bundle; k/v semantics need a live dry-run
    //    before wiring to a real "submit" button. ────────────────
    case "submit_waiver_claim": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const adds = kv(a.adds);
      const drops = kv(a.drops);
      const settings = kv(a.settings);
      return {
        op: "submit_waiver_claim",
        query: `mutation submit_waiver_claim($k_adds:[String],$v_adds:[Int],$k_drops:[String],$v_drops:[Int],$k_settings:[String],$v_settings:[Int]) {
  submit_waiver_claim(league_id: "${leagueId}", k_adds:$k_adds, v_adds:$v_adds, k_drops:$k_drops, v_drops:$v_drops, k_settings:$k_settings, v_settings:$v_settings) { transaction_id status }
}`,
        variables: {
          k_adds: adds.k, v_adds: adds.v,
          k_drops: drops.k, v_drops: drops.v,
          k_settings: settings.k, v_settings: settings.v,
        },
      };
    }
    case "propose_trade": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const rosterIds = a.rosterIds;
      if (!Array.isArray(rosterIds) || rosterIds.some((n) => !Number.isInteger(n))) {
        throw new ValidationError("rosterIds must be an array of integers");
      }
      const adds = kv(a.adds);
      const drops = kv(a.drops);
      const draftPicks = a.draftPicks ?? [];
      const waiverBudget = a.waiverBudget ?? [];
      return {
        op: "propose_trade",
        query: `mutation propose_trade($k_adds:[String],$v_adds:[Int],$k_drops:[String],$v_drops:[Int]) {
  propose_trade(league_id: "${leagueId}", roster_ids: ${JSON.stringify(
          rosterIds
        )}, draft_picks: ${JSON.stringify(draftPicks)}, k_adds:$k_adds, v_adds:$v_adds, k_drops:$k_drops, v_drops:$v_drops, waiver_budget: ${JSON.stringify(
          waiverBudget
        )}) { transaction_id status }
}`,
        variables: { k_adds: adds.k, v_adds: adds.v, k_drops: drops.k, v_drops: drops.v },
      };
    }
    case "cancel_transaction": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const transactionId = requireStr(a.transactionId, "transactionId");
      const leg = requireInt(a.leg, "leg");
      return {
        op: "force_cancel_transaction",
        query: `mutation force_cancel_transaction {
  force_cancel_transaction(league_id: "${leagueId}", transaction_id: "${transactionId}", leg: ${leg}) { transaction_id status }
}`,
      };
    }
    case "cancel_waiver_claim": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const transactionId = requireStr(a.transactionId, "transactionId");
      const leg = requireInt(a.leg, "leg");
      return {
        op: "cancel_waiver_claim",
        query: `mutation cancel_waiver_claim {
  cancel_waiver_claim(league_id: "${leagueId}", transaction_id: "${transactionId}", leg: ${leg}) { transaction_id status }
}`,
      };
    }
    case "update_waiver_claim": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const transactionId = requireStr(a.transactionId, "transactionId");
      const leg = requireInt(a.leg, "leg");
      const settings = kv(a.settings);
      const mk: string[] = [];
      const mv: string[] = [];
      for (const [k, v] of Object.entries(a.metadata ?? {})) { mk.push(k); mv.push(String(v)); }
      return {
        op: "update_waiver_claim",
        query: `mutation update_waiver_claim($k_settings:[String],$v_settings:[Int],$k_metadata:[String],$v_metadata:[String]) {
  update_waiver_claim(league_id: "${leagueId}", transaction_id: "${transactionId}", leg: ${leg}, k_settings:$k_settings, v_settings:$v_settings, k_metadata:$k_metadata, v_metadata:$v_metadata) { transaction_id status }
}`,
        variables: { k_settings: settings.k, v_settings: settings.v, k_metadata: mk, v_metadata: mv },
      };
    }
    case "draft_pick_player": {
      const draftId = requireStr(a.draftId, "draftId");
      const playerId = requireStr(a.playerId, "playerId");
      const pickNo = requireInt(a.pickNo, "pickNo");
      return {
        op: "draft_pick_player",
        query: `mutation draft_pick_player {
  draft_pick_player(sport: "nfl", draft_id: "${draftId}", player_id: "${playerId}", pick_no: ${pickNo})
}`,
      };
    }
    case "update_reserve": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const rosterId = requireInt(a.rosterId, "rosterId");
      const reserve = requireStrArray(a.reserve, "reserve");
      return {
        op: "roster_update_reserve",
        query: `mutation roster_update_reserve {
  roster_update_reserve(league_id: "${leagueId}", roster_id: ${rosterId}, reserve: ${JSON.stringify(
          reserve
        )}) { league_id roster_id reserve }
}`,
      };
    }
    case "add_trade_block":
    case "remove_trade_block": {
      const leagueId = requireStr(a.leagueId, "leagueId");
      const playerId = requireStr(a.playerId, "playerId");
      const op = a.type === "add_trade_block" ? "add_league_player_trade_block" : "remove_league_player_trade_block";
      return {
        op,
        query: `mutation ${op} {
  ${op}(league_id: "${leagueId}", player_id: "${playerId}")
}`,
      };
    }
    default: {
      const _exhaustive: never = a;
      throw new ValidationError(`Unsupported action: ${(_exhaustive as any)?.type}`);
    }
  }
}
