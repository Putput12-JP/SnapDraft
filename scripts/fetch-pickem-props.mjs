#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · PICK'EM PROPS  →  vegas_player_props
   ────────────────────────────────────────────────────────────────────────
   Free, keyless player-prop feed for the Betting tab. Pulls three DFS pick'em
   boards DIRECTLY:
     • PrizePicks     (partner-api.prizepicks.com — the public api host is
                       Cloudflare-blocked)
     • Underdog       (api.underdogfantasy.com over/under lines)
     • Sleeper        (api.sleeper.com native pick'em — priced, native ids)
   Resolves each player to its Sleeper id (Sleeper's board already carries it),
   maps each book's stat types to Vault's market keys, and merges the result
   into data/lineup-feed.json under `vegas_player_props` — the exact shape
   betting-data.js already consumes. No API key, no credits. (Sleeper posts no
   game spreads/totals/moneylines — its board is player props only — so the
   game-markets tab stays on ParlayAPI / the Odds API / ESPN.)

   All three books are hit DIRECTLY here, so this job is authoritative and
   fresher than ParlayAPI's mirror of them: on a market ParlayAPI already
   carries, we upsert the direct quote and correct a stale headline line
   rather than only gap-filling (see mergeFeed).

   Cell shape written (matches betting-data.js):
     lines[marketKey] = {
       line, over, under, book,
       quotes:[{book,line,over,under}],
       best:{ over:{book,price}|null, under:{book,price}|null },
       pickem:true                      // flag: single-number line, no 2-sided price
     }

   Pick'em lines have no two-sided American price, so over/under are null. The
   grid renders the line; prices show as "—". (A later UI tweak can label
   pick'em columns "PICK" instead.)

   Run:
     node scripts/fetch-pickem-props.mjs                 # fetch live, merge feed
     node scripts/fetch-pickem-props.mjs --dry           # fetch, print summary, write nothing
     node scripts/fetch-pickem-props.mjs --force         # write even if 0 props (clears stale)
   Offline test (no network):
     node scripts/fetch-pickem-props.mjs --dry \
       --pp-fixture=scripts/_pp.sample.json \
       --sleeper-fixture=scripts/_sleeper.sample.json

   Env / flags:
     --feed=PATH         feed json to merge into        (default data/lineup-feed.json)
     --league=ID         PrizePicks league id           (default 9 = NFL)
     --pp-fixture=PATH   read PrizePicks json from file instead of network
     --sleeper-fixture=PATH  read Sleeper players json from file instead of network
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/* ── args ─────────────────────────────────────────────────────────────── */
const ARG = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DRY      = !!ARG.dry;
const FORCE    = !!ARG.force;
const FEED     = ARG.feed     || 'data/lineup-feed.json';
const LEAGUE   = String(ARG.league || 9);            // 9 = NFL on PrizePicks
const PP_FIX   = ARG['pp-fixture'] || null;
const SL_FIX   = ARG['sleeper-fixture'] || null;
const UD_FIX   = ARG['ud-fixture'] || null;
const SLN_FIX  = ARG['sleeper-lines-fixture'] || null;
const NO_UD    = !!ARG['no-underdog'];
const NO_PP    = !!ARG['no-prizepicks'];
const NO_SL    = !!ARG['no-sleeper'];

// api.prizepicks.com/projections is Cloudflare-blocked (403) for keyless
// server-side callers. partner-api.prizepicks.com serves the same JSON:API
// board and is still reachable, so we hit that host instead.
const PP_HOST = ARG['pp-host'] || 'partner-api.prizepicks.com';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const log = (...a) => console.log('[pickem]', ...a);

/* ── identity helpers (mirror betting-data.js normName) ───────────────── */
const normName = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');

/* ── PrizePicks stat_type → Vault market key ──────────────────────────── */
/* matched by normalized contains, longest-key first so "pass+rush" wins over "rush" */
const STAT_MAP = [
  ['passrushyards',  'pass_rush_yd'],
  ['passrushyds',    'pass_rush_yd'],
  ['rushrecyards',   'rush_rec_yd'],
  ['rushrecyds',     'rush_rec_yd'],
  ['passingyards',   'pass_yd'],
  ['passyards',      'pass_yd'],
  ['passingtds',     'pass_td'],
  ['passtds',        'pass_td'],
  ['passtouchdowns', 'pass_td'],
  ['passcompletions','pass_cmp'],
  ['completions',    'pass_cmp'],
  ['passattempts',   'pass_att'],
  ['interceptions',  'pass_int'],
  ['longestcompletion','long_pass'],
  ['rushingyards',   'rush_yd'],
  ['rushyards',      'rush_yd'],
  ['rushingtds',     'rush_td'],
  ['rushtds',        'rush_td'],
  ['rushattempts',   'rush_att'],
  ['carries',        'rush_att'],
  ['longestrush',    'long_rush'],
  ['receivingyards', 'rec_yd'],
  ['recyards',       'rec_yd'],
  ['receivingtds',   'rec_td'],
  ['rectds',         'rec_td'],
  ['receptions',     'rec'],
  ['longestreception','long_rec'],
  ['kickingpoints',  'kick_pts'],
  ['fgmade',         'fg_made'],
  ['fieldgoalsmade', 'fg_made'],
  ['tacklesassists', 'tackles'],
  ['tackles',        'tackles'],
  ['sacks',          'sacks'],
];
function marketKeyFor(statType) {
  const n = (statType || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [needle, key] of STAT_MAP) if (n.includes(needle)) return key;
  return null;
}

/* ── fetch helpers ────────────────────────────────────────────────────── */
async function getJSON(url, label) {
  const r = await fetch(url, { headers: {
    'User-Agent': UA, 'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9', 'Origin': 'https://app.prizepicks.com',
    'Referer': 'https://app.prizepicks.com/',
  }});
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  return r.json();
}
function readFixture(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/* ── Sleeper name → {id,team,pos} map ─────────────────────────────────── */
async function loadSleeperMap() {
  const all = SL_FIX ? readFixture(SL_FIX)
    : await getJSON('https://api.sleeper.app/v1/players/nfl', 'sleeper');
  const map = {};        // normName -> {id,team,pos}
  const byNameTeam = {}; // normName+team -> {id,team,pos}  (disambiguates dup names)
  const byId = {};       // sleeperId -> {id,name,team,pos}  (Sleeper lines carry native ids)
  const depth = {};      // sleeperId -> [depth_chart_order, active] — the "will they play" signal
  const INACTIVE = /inactive|physically unable|injured reserve|\bpup\b|\bir\b|suspend|^out$|\bna\b|not active/i;
  for (const id in all) {
    const p = all[id];
    if (!p || !['QB', 'RB', 'WR', 'TE', 'K', 'LB', 'DB', 'DL'].includes(p.position)) continue;
    const nm = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`;
    const key = normName(nm); if (!key) continue;
    const team = (p.team || '').toUpperCase() || null;
    const rec = { id, team, pos: p.position };
    if (!map[key]) map[key] = rec;
    if (team) byNameTeam[key + ':' + team] = rec;
    byId[id] = { id, name: nm.trim(), team, pos: p.position };
    // depth-chart order (1 = starter) + active flag, for the Best Bets starter
    // gate. Only skill positions the props tab covers; keeps the map small.
    if (['QB', 'RB', 'WR', 'TE'].includes(p.position) && team) {
      const dco = Number.isFinite(p.depth_chart_order) ? p.depth_chart_order : null;
      const active = p.active !== false && !INACTIVE.test(p.status || p.injury_status || '');
      depth[id] = [dco, active ? 1 : 0];
    }
  }
  return { map, byNameTeam, byId, depth };
}
function resolveSleeper(sl, name, team) {
  const key = normName(name); if (!key) return null;
  if (team && sl.byNameTeam[key + ':' + team.toUpperCase()]) return sl.byNameTeam[key + ':' + team.toUpperCase()];
  return sl.map[key] || null;
}

/* ── PrizePicks loader (paginated JSON:API) ───────────────────────────── */
async function loadPrizePicks() {
  let raw, firstPageError = null;
  if (PP_FIX) {
    raw = [readFixture(PP_FIX)];
  } else {
    raw = [];
    for (let page = 1; page <= 12; page++) {
      const url = `https://${PP_HOST}/projections?league_id=${LEAGUE}&per_page=250&single_stat=true&page=${page}`;
      let j;
      try { j = await getJSON(url, `prizepicks p${page}`); }
      catch (e) { log('fetch failed:', e.message); if (page === 1) firstPageError = e; break; }
      raw.push(j);
      const data = j.data || [];
      const totalPages = j.meta && j.meta.total_pages;
      if (!data.length) break;
      // partner-api returns the whole board on page 1 with no pagination meta —
      // paging further just refetches the same rows (and risks a 429). Stop
      // after the first page unless the host actually advertises more pages.
      if (!totalPages) break;
      if (page >= totalPages) break;
      await new Promise(r => setTimeout(r, 1200)); // be polite (partner-api throttles fast)
    }
  }
  // Surface a hard failure (Cloudflare block, network) by re-throwing — the
  // cron's outer catch logs it and exits 0, but the visible "ERROR:" log + the
  // 0-props line in the workflow tells you the pipeline broke vs. PP being empty.
  if (firstPageError) throw new Error(`PrizePicks unreachable (page 1): ${firstPageError.message}`);
  // flatten across pages
  const players = {}; // ppId -> {name,team,pos}
  const projections = [];
  for (const j of raw) {
    for (const inc of (j.included || [])) {
      if (inc.type === 'new_player' || inc.type === 'player') {
        const a = inc.attributes || {};
        players[inc.id] = {
          name: a.display_name || a.name || '',
          team: (a.team || a.team_name || '').toUpperCase() || null,
          pos: (a.position || '').toUpperCase() || null,
        };
      }
    }
    for (const d of (j.data || [])) {
      if (d.type !== 'projection') continue;
      const a = d.attributes || {};
      const rel = d.relationships || {};
      const ppId = rel.new_player?.data?.id || rel.player?.data?.id || null;
      projections.push({
        ppId,
        stat: a.stat_type || a.stat_display_name || '',
        line: a.line_score != null ? Number(a.line_score) : null,
        oddsType: a.odds_type || 'standard',   // standard | demon | goblin
        start: a.start_time || a.board_time || null,
        desc: a.description || '',
        status: a.status || null,
      });
    }
  }
  return { players, projections };
}

/* ── transform → vegas_player_props ───────────────────────────────────── */
function buildProps(pp, sl) {
  const out = {};           // sleeperId -> {lines, opp, commence}
  const seen = new Set();   // sleeperId|market — keep first standard line
  let events = new Set(), matched = 0, unmatched = 0, lines = 0;

  // standard lines first (so demon/goblin alt lines don't overwrite the rep line)
  const ordered = pp.projections.slice().sort((a, b) =>
    (a.oddsType === 'standard' ? 0 : 1) - (b.oddsType === 'standard' ? 0 : 1));

  for (const proj of ordered) {
    if (proj.line == null || !proj.ppId) continue;
    if (proj.status && /^(suspended|inactive)$/i.test(proj.status)) continue;
    const market = marketKeyFor(proj.stat); if (!market) continue;
    const ppPlayer = pp.players[proj.ppId]; if (!ppPlayer) continue;

    const hit = resolveSleeper(sl, ppPlayer.name, ppPlayer.team);
    if (!hit) { unmatched++; continue; }
    const id = hit.id;
    const dedupe = id + '|' + market;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    if (!out[id]) {
      // Embed identity (name/team/pos) on the prop so the betting UI can
      // surface props for players the preseason workbook doesn't cover
      // (PrizePicks routinely posts lines for backups and lesser-known WRs
      // the workbook skips). Identity comes from the Sleeper resolver hit.
      out[id] = {
        name: ppPlayer.name || null,
        team: hit.team || ppPlayer.team || null,
        pos: hit.pos || ppPlayer.pos || null,
        lines: {}, opp: null, commence: null,
      };
    }
    const cell = {
      line: proj.line, over: null, under: null, book: 'PrizePicks',
      quotes: [{ book: 'PrizePicks', line: proj.line, over: null, under: null }],
      best: { over: null, under: null },
      pickem: true,
    };
    out[id].lines[market] = cell;
    if (proj.start && !out[id].commence) out[id].commence = proj.start;
    if (proj.desc && !out[id].opp) {
      const m = proj.desc.match(/\b([A-Z]{2,3})\b/);
      if (m) out[id].opp = m[1];
    }
    if (proj.start) events.add(proj.start.slice(0, 10));
    lines++;
  }
  matched = Object.keys(out).length;
  return { props: out, stats: { players: matched, unmatched, lines, events: events.size } };
}

/* ── Underdog Fantasy ───────────────────────────────────────────────────
   Keyless board feed: ONE call to /beta/v5/over_under_lines returns every
   sport flattened into parallel arrays (players, appearances, games,
   over_under_lines). We keep NFL game-level lines (drop the season-long and
   in-period splits), map Underdog stat keys to Vault market keys, resolve each
   player to a Sleeper id, and emit the same cell shape as PrizePicks.

   ParlayAPI only mirrors Underdog for TD markets, so without this Underdog's
   yardage lines never reach the tab — leaving every QB yardage prop single-
   source (PrizePicks only) with nothing to cross-check a bad line against. */
const UD_STAT_MAP = {
  passing_yds: 'pass_yd', passing_tds: 'pass_td', passing_comps: 'pass_cmp',
  passing_att: 'pass_att', passing_ints: 'pass_int', passing_long: 'long_pass',
  passing_and_rushing_yds: 'pass_rush_yd',
  rushing_yds: 'rush_yd', rushing_tds: 'rush_td', rushing_att: 'rush_att',
  rushing_long: 'long_rush',
  receiving_yds: 'rec_yd', receiving_tds: 'rec_td', receptions: 'rec',
  receiving_long: 'long_rec',
  rushing_and_receiving_yds: 'rush_rec_yd', rush_rec_yds: 'rush_rec_yd',
  field_goals_made: 'fg_made', kicking_points: 'kick_pts',
  tackles: 'tackles', sacks: 'sacks',
};
const udAmerican = s => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };

async function loadUnderdog() {
  let j;
  if (UD_FIX) { j = readFixture(UD_FIX); }
  else {
    const r = await fetch('https://api.underdogfantasy.com/beta/v5/over_under_lines', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!r.ok) throw new Error(`underdog HTTP ${r.status}`);
    j = await r.json();
  }
  const players = Object.fromEntries((j.players || []).map(p => [p.id, p]));
  const apps    = Object.fromEntries((j.appearances || []).map(a => [a.id, a]));
  // team_id → abbr from each game's "AWAY @ HOME" title (Underdog only exposes
  // team UUIDs on the player; the abbr is what the Sleeper resolver needs).
  const teamAbbr = {};
  for (const g of [...(j.games || []), ...(j.solo_games || [])]) {
    const m = String(g.abbreviated_title || '').match(/([A-Z]{2,3})\s*@\s*([A-Z]{2,3})/);
    if (m) { if (g.away_team_id) teamAbbr[g.away_team_id] = m[1]; if (g.home_team_id) teamAbbr[g.home_team_id] = m[2]; }
  }
  const lines = [];
  for (const l of j.over_under_lines || []) {
    if (l.line_type && l.line_type !== 'balanced') continue;   // skip boosted/special
    const as = l.over_under && l.over_under.appearance_stat; if (!as) continue;
    const stat = as.stat || '';
    if (/^(season_|period_)/.test(stat)) continue;             // game lines only
    const market = UD_STAT_MAP[stat]; if (!market) continue;
    const app = apps[as.appearance_id]; if (!app) continue;
    const player = players[app.player_id]; if (!player || player.sport_id !== 'NFL') continue;
    const opts = l.options || [];
    const over  = opts.find(o => o.choice === 'higher' || o.choice === 'over');
    const under = opts.find(o => o.choice === 'lower'  || o.choice === 'under');
    lines.push({
      name: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
      team: teamAbbr[player.team_id] || null,
      pos: player.position_name || null,
      market,
      line: l.stat_value != null ? Number(l.stat_value) : null,
      over:  over  ? udAmerican(over.american_price)  : null,
      under: under ? udAmerican(under.american_price) : null,
    });
  }
  return { lines };
}

function buildUnderdog(ud, sl) {
  const out = {}; const seen = new Set();
  let matched = 0, unmatched = 0, count = 0;
  for (const row of ud.lines) {
    if (row.line == null) continue;
    const hit = resolveSleeper(sl, row.name, row.team);
    if (!hit) { unmatched++; continue; }
    const id = hit.id;
    const dedupe = id + '|' + row.market;
    if (seen.has(dedupe)) continue;          // one representative line per market
    seen.add(dedupe);
    if (!out[id]) out[id] = { name: row.name || null, team: hit.team || row.team || null, pos: hit.pos || row.pos || null, lines: {}, opp: null, commence: null };
    out[id].lines[row.market] = {
      line: row.line, over: row.over, under: row.under, book: 'Underdog Fantasy',
      quotes: [{ book: 'Underdog Fantasy', line: row.line, over: row.over, under: row.under }],
      best: { over: null, under: null },
      pickem: true,
    };
    count++;
  }
  matched = Object.keys(out).length;
  return { props: out, stats: { players: matched, unmatched, lines: count } };
}

/* ── Sleeper (native pick'em) ───────────────────────────────────────────
   /lines/available returns EVERY sport's over/under pick'em lines flat. The
   NFL slice (sport:"nfl") is player props only — Sleeper posts no game
   spreads/totals/moneylines, so this adds a third BOOK to the props tab, not
   the game-markets tab. Two things make it the cleanest source:
     • subject_id IS the Sleeper player id — no name resolution, no dup-name
       mismatch (the one failure mode PrizePicks/Underdog can hit).
     • each side carries a payout_multiplier (decimal odds), so unlike flat
       pick'em these quotes are PRICED — real over/under American odds.
   Sleeper prices every line (no flat "standard" line), and a player+market can
   carry alt lines; we keep the one whose over/under payouts are most balanced,
   which is the primary line (alts are lopsided by design).                  */
const SLEEPER_STAT_MAP = {
  passing_yards: 'pass_yd', rushing_yards: 'rush_yd', receiving_yards: 'rec_yd',
  receptions: 'rec', passing_touchdowns: 'pass_td', interceptions: 'pass_int',
  // anytime_touchdowns is intentionally excluded — the Anytime TD board uses a
  // separate prob-based cell shape, not a line-based quote.
};
// decimal payout multiplier → American odds (dec is the total-return multiple).
function decToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

async function loadSleeperLines() {
  let arr;
  if (SLN_FIX) { arr = readFixture(SLN_FIX); }
  else {
    const r = await fetch('https://api.sleeper.com/lines/available?dynamic=true&include_preseason=true', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!r.ok) throw new Error(`sleeper-lines HTTP ${r.status}`);
    arr = await r.json();
  }
  if (!Array.isArray(arr)) return { lines: [] };
  const lines = [];
  for (const l of arr) {
    const over = (l.options || []).find(o => o.outcome === 'over');
    const under = (l.options || []).find(o => o.outcome === 'under');
    const o = over || under || (l.options || [])[0]; if (!o) continue;
    if (o.sport !== 'nfl') continue;                     // nfl = game props (nfl_szn = season-long)
    if (o.subject_type !== 'player') continue;
    const market = SLEEPER_STAT_MAP[o.wager_type]; if (!market) continue;
    const pid = o.subject_id; if (!pid) continue;
    const line = o.outcome_value != null ? Number(o.outcome_value) : null; if (line == null) continue;
    const om = over ? Number(over.payout_multiplier) : null;
    const um = under ? Number(under.payout_multiplier) : null;
    lines.push({
      pid: String(pid), market, line,
      over: decToAmerican(om), under: decToAmerican(um),
      team: (o.subject_team || '').toUpperCase() || null,
      pos: (o.subject_position || '').toUpperCase() || null,
      balance: (om != null && um != null) ? Math.abs(om - um) : Infinity,  // primary line = most balanced
    });
  }
  return { lines };
}

function buildSleeper(sln, sl) {
  const out = {};
  const best = new Map();       // id|market → chosen row (most balanced payouts)
  let matched = 0, unknown = 0, count = 0;
  for (const row of sln.lines) {
    const ident = sl.byId[row.pid];
    if (!ident) { unknown++; continue; }                 // id not in the Sleeper player map (rare)
    const key = row.pid + '|' + row.market;
    const cur = best.get(key);
    if (!cur || row.balance < cur.balance) best.set(key, { row, ident });
  }
  for (const { row, ident } of best.values()) {
    const id = ident.id;
    if (!out[id]) out[id] = { name: ident.name || null, team: ident.team || row.team || null, pos: ident.pos || row.pos || null, lines: {}, opp: null, commence: null };
    out[id].lines[row.market] = {
      line: row.line, over: row.over, under: row.under, book: 'Sleeper',
      quotes: [{ book: 'Sleeper', line: row.line, over: row.over, under: row.under }],
      best: { over: null, under: null },
      pickem: true,
    };
    count++;
  }
  matched = Object.keys(out).length;
  return { props: out, stats: { players: matched, unmatched: unknown, lines: count } };
}

/* line-first best price for a side (mirrors src-vegas.mjs bestSide): a lower
   line is strictly better for an OVER, a higher line for an UNDER; price only
   breaks a tie. Recomputed after upserting a keyless quote. */
function bestSide(quotes, side) {
  const better = side === 'over' ? (a, b) => a < b : (a, b) => a > b;
  return quotes.reduce((best, q) => {
    if (q[side] == null) return best;
    const cand = { book: q.book, price: q[side], line: q.line ?? null };
    if (!best) return cand;
    if (cand.line != null && best.line != null && cand.line !== best.line)
      return better(cand.line, best.line) ? cand : best;
    return cand.price > best.price ? cand : best;
  }, null);
}

/* ── merge into feed ──────────────────────────────────────────────────────
   MERGE, don't replace. ParlayAPI (run by build-lineup-feed.mjs every 6h) is
   the richer source for two-sided BOOK prices, but it MIRRORS PrizePicks /
   Underdog lines and can serve them stale (that mirror is how Drake Maye's
   pass-yds line got stuck at 169.5 when the real PrizePicks/Underdog line was
   229.5). This hourly keyless job hits PrizePicks and Underdog DIRECTLY, so
   for those two books it is the authoritative, fresher source. Policy:

     • market missing            → add the keyless cell (gap-fill, as before)
     • market present            → UPSERT this book's quote into the cell:
         - replace/insert the same-book quote with the fresh line + prices
         - if the cell's headline book IS this book, refresh cell.line too
           (this is what corrects a stale mirrored line)
         - recompute best over/under across the cell's quotes
       Other books' quotes are never dropped, so nothing flip-flops between
       rich ParlayAPI odds and bare keyless lines — we only correct the number
       and add the missing cross-check quote.                                */
function upsertQuote(cell, fresh, book) {
  cell.quotes = cell.quotes || [];
  const q = { book, line: fresh.line ?? null, over: fresh.over ?? null, under: fresh.under ?? null };
  const i = cell.quotes.findIndex(x => x.book === book);
  if (i >= 0) cell.quotes[i] = q; else cell.quotes.push(q);
  // headline book is this book → its direct line is authoritative
  if (cell.book === book && fresh.line != null) {
    cell.line = fresh.line;
    if (fresh.over != null) cell.over = fresh.over;
    if (fresh.under != null) cell.under = fresh.under;
  }
  cell.best = cell.best || {};
  cell.best.over  = bestSide(cell.quotes, 'over');
  cell.best.under = bestSide(cell.quotes, 'under');
}

function mergeFeed(sources, stats, sl) {
  const depth = sl && sl.depth;
  if (!existsSync(FEED)) { log('feed not found, nothing to merge:', FEED); return false; }
  const feed = JSON.parse(readFileSync(FEED, 'utf8'));
  const existing = feed.vegas_player_props || {};
  const had = Object.keys(existing).length;

  if (!stats.players && !FORCE) {
    log(`0 props parsed — leaving existing feed untouched (had ${had}). Use --force to clear.`);
    return false;
  }

  let addedPlayers = 0, addedMarkets = 0, refreshed = 0;
  for (const { props, book } of sources) {
    for (const id in (props || {})) {
      const src = props[id];
      if (!existing[id]) { existing[id] = src; addedPlayers++; continue; }
      const cur = existing[id];
      // backfill identity / matchup if the richer feed left any of it blank
      cur.name = cur.name || src.name; cur.team = cur.team || src.team; cur.pos = cur.pos || src.pos;
      cur.opp = cur.opp || src.opp; cur.commence = cur.commence || src.commence;
      cur.lines = cur.lines || {};
      for (const mk in (src.lines || {})) {
        if (!cur.lines[mk]) { cur.lines[mk] = src.lines[mk]; addedMarkets++; continue; }
        // market already present — upsert this book's fresh, direct quote so a
        // stale mirrored line self-corrects and the cross-check quote appears
        upsertQuote(cur.lines[mk], src.lines[mk], book);
        refreshed++;
      }
    }
  }

  // Sleeper-team override: Sleeper is the authoritative CURRENT-team source, and
  // every entry keyed by a Sleeper id already carries that id — so force its team
  // to Sleeper's, overriding whatever a prop source (parlay-api) claimed. Prop
  // feeds lag on team changes and deep-bench players (measured: a WR still listed
  // on his old team while Sleeper had moved him), and that stale team wrongly
  // groups a player with the wrong roster (e.g. the role-anchor depth check).
  // Entries keyed by a non-Sleeper id (name-fallback), or where Sleeper has no
  // team (free agent), keep their source team as the best available.
  const byId = (sl && sl.byId) || {};
  let teamFixed = 0;
  for (const coll of [existing, feed.vegas_players]) {
    if (!coll) continue;
    for (const id in coll) {
      const st = byId[id] && byId[id].team;
      if (st && coll[id] && coll[id].team !== st) { coll[id].team = st; teamFixed++; }
    }
  }
  if (teamFixed) log(`sleeper-team override: corrected ${teamFixed} stale team(s)`);

  feed.vegas_player_props = existing;
  if (depth && Object.keys(depth).length) feed.vegas_depth = depth;   // [dco, active] per skill-player id
  feed.vegas_meta = feed.vegas_meta || {};
  // Only claim 'prizepicks' as the headline source when nothing richer set one.
  if (!feed.vegas_meta.props_source || feed.vegas_meta.props_source === 'none') feed.vegas_meta.props_source = 'prizepicks';
  feed.vegas_meta.props_players = Object.keys(existing).length;
  feed.vegas_meta.props_pp_filled = addedPlayers + addedMarkets;   // new cells this run
  feed.vegas_meta.props_pp_refreshed = refreshed;                  // same-book lines corrected
  feed.vegas_meta.props_pp_generated = new Date().toISOString();
  const summary = `+${addedPlayers} players, +${addedMarkets} markets, ~${refreshed} refreshed — ${had} → ${Object.keys(existing).length}`;
  if (DRY) { log('DRY — would merge:', summary); return true; }
  writeFileSync(FEED, JSON.stringify(feed));
  log(`merged into ${FEED}: ${summary}`);
  return true;
}

/* ── main ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const sl = await loadSleeperMap();
    log('sleeper map:', Object.keys(sl.map).length, 'names');

    const sources = [];
    let totalPlayers = 0;

    // PrizePicks (partner-api) — soft-fail so an Underdog-only run still works
    if (!NO_PP) {
      try {
        const pp = await loadPrizePicks();
        log('prizepicks:', Object.keys(pp.players).length, 'players,', pp.projections.length, 'projections');
        const { props, stats } = buildProps(pp, sl);
        log(`  → mapped ${stats.players} players, ${stats.lines} lines, ${stats.unmatched} unmatched`);
        sources.push({ props, book: 'PrizePicks' });
        totalPlayers += stats.players;
      } catch (e) { log('prizepicks skipped:', e.message); }
    }

    // Underdog Fantasy — soft-fail so a PrizePicks-only run still works
    if (!NO_UD) {
      try {
        const ud = await loadUnderdog();
        log('underdog:', ud.lines.length, 'nfl game lines');
        const { props, stats } = buildUnderdog(ud, sl);
        log(`  → mapped ${stats.players} players, ${stats.lines} lines, ${stats.unmatched} unmatched`);
        sources.push({ props, book: 'Underdog Fantasy' });
        totalPlayers += stats.players;
      } catch (e) { log('underdog skipped:', e.message); }
    }

    // Sleeper (native pick'em) — priced quotes, resolved by native player id.
    // Replaces ParlayAPI's thin/stale "Sleeper" mirror with the direct board.
    if (!NO_SL) {
      try {
        const sln = await loadSleeperLines();
        log('sleeper:', sln.lines.length, 'nfl player lines');
        const { props, stats } = buildSleeper(sln, sl);
        log(`  → mapped ${stats.players} players, ${stats.lines} lines, ${stats.unmatched} unknown-id`);
        sources.push({ props, book: 'Sleeper' });
        totalPlayers += stats.players;
      } catch (e) { log('sleeper skipped:', e.message); }
    }

    mergeFeed(sources, { players: totalPlayers }, sl);
  } catch (e) {
    log('ERROR:', e.message);
    process.exit(0); // never fail the workflow / never wipe the feed on error
  }
})();
