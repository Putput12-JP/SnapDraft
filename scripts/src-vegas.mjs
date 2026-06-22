/* ════════════════════════════════════════════════════════════════════════
   VAULT · LINEUP COMMAND — Vegas source adapter
   ────────────────────────────────────────────────────────────────────────
   Two jobs:

   (a) INGEST the preseason workbook (uploads/Vegas.xlsx → vegas-preseason.json):
       • team point totals (projected PPG per team)
       • player season-long stat lines (pass/rush/rec yds + TDs, Sleeper keys)
       Resolves player names → Sleeper player_ids using the cron's existing
       resolver. Emits `vegas_players`.

   (b) LIVE team totals during the season, derived from each week's game lines:

           implied_team_total = game_total/2  −  team_spread/2
           (favorite gets +|spread|/2, underdog −|spread|/2)

       Primary source : The Odds API  (set ODDS_API_KEY — markets=spreads,totals)
       Free fallback  : ESPN scoreboard (no key, public read endpoint)

       Preseason → live BLEND ramp: weeks 1–3 the market is thin, so we lean on
       the workbook baseline and hand off to live lines as they stabilize:

           w = clamp((week − 1) / 3, 0, 1)         // 0 in wk1 → 1 by wk4
           team_total = w · live_implied + (1 − w) · preseason_proj

   Everything degrades gracefully: no key → ESPN; ESPN down → pure preseason.
   Emits `vegas_teams` (current per-team implied total + provenance) and
   `vegas_players` for the feed. Nothing else breaks if this whole module
   throws — the orchestrator wraps it.
   ════════════════════════════════════════════════════════════════════════ */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, 'vegas-preseason.json');

const round = n => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const warn = (src, e) => console.warn(`  [skip ${src}] ${e.message || e}`);

/* full team name (as books print it) → Sleeper code */
const NAME_CODE = {
  'arizona cardinals': 'ARI', 'atlanta falcons': 'ATL', 'baltimore ravens': 'BAL',
  'buffalo bills': 'BUF', 'carolina panthers': 'CAR', 'chicago bears': 'CHI',
  'cincinnati bengals': 'CIN', 'cleveland browns': 'CLE', 'dallas cowboys': 'DAL',
  'denver broncos': 'DEN', 'detroit lions': 'DET', 'green bay packers': 'GB',
  'houston texans': 'HOU', 'indianapolis colts': 'IND', 'jacksonville jaguars': 'JAX',
  'kansas city chiefs': 'KC', 'las vegas raiders': 'LV', 'los angeles chargers': 'LAC',
  'los angeles rams': 'LAR', 'miami dolphins': 'MIA', 'minnesota vikings': 'MIN',
  'new england patriots': 'NE', 'new orleans saints': 'NO', 'new york giants': 'NYG',
  'new york jets': 'NYJ', 'philadelphia eagles': 'PHI', 'pittsburgh steelers': 'PIT',
  'san francisco 49ers': 'SF', 'seattle seahawks': 'SEA', 'tampa bay buccaneers': 'TB',
  'tennessee titans': 'TEN', 'washington commanders': 'WAS',
};
const codeFromName = s => NAME_CODE[(s || '').toLowerCase().trim()] || null;
/* ESPN abbr drift → Sleeper convention */
const ABBR_FIX = { WSH: 'WAS', JAC: 'JAX', LV: 'LV', LAR: 'LAR' };
const fixAbbr = a => ABBR_FIX[(a || '').toUpperCase()] || (a || '').toUpperCase();

/* ── load preseason seed ─────────────────────────────────────────────── */
export async function loadVegasSeed() {
  try { return JSON.parse(await readFile(SEED_PATH, 'utf8')); }
  catch (e) { warn('vegas-seed', e); return null; }
}

/* ── live team totals: The Odds API (primary) ────────────────────────────
   One call returns every upcoming NFL game with spreads + totals across
   books; we take the consensus (median) line per game, then split into
   per-team implied totals. 1 request → well within any free/paid tier. */
async function liveOddsAPI(week) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return null;
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds`
    + `?regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${key}`;
  const r = await fetch(url, { headers: { 'user-agent': 'vault-lineup-cron/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} the-odds-api`);
  const games = await r.json();
  const out = {}; // code -> implied total
  for (const g of games || []) {
    const home = codeFromName(g.home_team), away = codeFromName(g.away_team);
    if (!home || !away) continue;
    // median total + median spread-per-team across books
    const totals = [], spreads = {}; // spreads[team] = [points...]
    for (const bk of g.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (mk.key === 'totals') {
          const o = (mk.outcomes || []).find(o => /over/i.test(o.name));
          if (o && o.point != null) totals.push(o.point);
        } else if (mk.key === 'spreads') {
          for (const o of mk.outcomes || []) {
            const c = codeFromName(o.name); if (!c || o.point == null) continue;
            (spreads[c] = spreads[c] || []).push(o.point);
          }
        }
      }
    }
    const total = median(totals);
    if (total == null) continue;
    for (const c of [home, away]) {
      const sp = median(spreads[c] || []);
      if (sp == null) continue;
      out[c] = round(total / 2 - sp / 2);
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ── live team totals: ESPN scoreboard (free fallback) ───────────────────
   Public read endpoint, no key. Parses each game's "details" (e.g. "KC -3.5")
   for the favorite + line, and "overUnder" for the total.                 */
async function liveESPN(season, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
    + `?seasontype=2&week=${week}&dates=${season}`;
  const r = await fetch(url, { headers: { 'user-agent': 'vault-lineup-cron/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} espn-scoreboard`);
  const data = await r.json();
  const out = {};
  for (const ev of data.events || []) {
    const comp = (ev.competitions || [])[0]; if (!comp) continue;
    const odds = (comp.odds || [])[0]; if (!odds) continue;
    const ou = odds.overUnder; if (ou == null) continue;
    const teams = {};
    for (const c of comp.competitors || []) teams[c.homeAway] = fixAbbr(c.team?.abbreviation);
    // favorite + magnitude from "details" ("ABBR -3.5") or signed spread on home
    let favAbbr = null, mag = null;
    const m = (odds.details || '').match(/([A-Z]{2,3})\s*(-?\d+(?:\.\d+)?)/);
    if (m) { favAbbr = fixAbbr(m[1]); mag = Math.abs(parseFloat(m[2])); }
    else if (odds.spread != null) { // ESPN `spread` is signed for the home team
      mag = Math.abs(odds.spread); favAbbr = odds.spread < 0 ? teams.home : teams.away;
    }
    if (favAbbr == null || mag == null) continue;
    const home = teams.home, away = teams.away; if (!home || !away) continue;
    const dog = favAbbr === home ? away : home;
    out[favAbbr] = round(ou / 2 + mag / 2);
    out[dog] = round(ou / 2 - mag / 2);
  }
  return Object.keys(out).length ? out : null;
}

/* ── blend preseason ⇄ live ──────────────────────────────────────────── */
function blend(seed, live, week) {
  const w = clamp((week - 1) / 3, 0, 1); // 0 wk1 → 1 by wk4
  const teams = {};
  const codes = new Set([...Object.keys(seed?.teams || {}), ...Object.keys(live || {})]);
  for (const code of codes) {
    const pre = seed?.teams?.[code]?.proj ?? null;
    const lv = live?.[code] ?? null;
    let total, src;
    if (pre != null && lv != null) { total = round(w * lv + (1 - w) * pre); src = w === 0 ? 'preseason' : (w >= 1 ? 'live' : 'blend'); }
    else if (lv != null) { total = lv; src = 'live'; }
    else if (pre != null) { total = pre; src = 'preseason'; }
    else continue;
    const avg = seed?.league_avg_team_total ?? 22.5;
    teams[code] = {
      total,                                   // implied points this week
      preseason: pre,                          // workbook baseline
      live: lv,                                // market-derived (null off-season)
      source: src,
      // environment modifier vs league average — the multiplier the model uses
      // to nudge a player's weekly projection up in high-total games / down low
      env: round((total - avg) / avg),
    };
  }
  return teams;
}

/* ── resolve player season lines → Sleeper ids ───────────────────────────
   `rid` is the cron's resolver (name+team → sleeperId). The workbook has no
   team column, so we lean on its unique-name fallback; ambiguous names that
   don't resolve are simply skipped (logged in the count). */
function buildVegasPlayers(seed, rid, resolver) {
  const players = {};
  let matched = 0;
  for (const p of seed?.players || []) {
    const id = rid(resolver, p.name, '');
    if (!id) continue;
    matched++;
    players[id] = { pos: p.pos, rank: p.rank, season: p.stats }; // season-total stat line
  }
  return { players, matched, total: (seed?.players || []).length };
}

/* ── orchestrate: returns { vegas_teams, vegas_players, meta } ──────────── */
export async function buildVegas(season, week, rid, resolver) {
  const seed = await loadVegasSeed();
  if (!seed) return { vegas_teams: {}, vegas_players: {}, meta: { mode: 'none' } };

  // live team totals: Odds API → ESPN → none
  let live = null, liveSrc = 'none';
  try { live = await liveOddsAPI(week); if (live) liveSrc = 'the-odds-api'; }
  catch (e) { warn('vegas:odds-api', e); }
  if (!live) {
    try { live = await liveESPN(season, week); if (live) liveSrc = 'espn'; }
    catch (e) { warn('vegas:espn', e); }
  }

  const vegas_teams = blend(seed, live, week);
  const { players: vegas_players, matched, total } = buildVegasPlayers(seed, rid, resolver);
  const w = clamp((week - 1) / 3, 0, 1);

  return {
    vegas_teams,
    vegas_players,
    meta: {
      live_source: liveSrc,
      live_teams: live ? Object.keys(live).length : 0,
      blend_weight: round(w),            // 0 = pure preseason, 1 = pure live
      players_matched: matched,
      players_total: total,
      league_avg: seed.league_avg_team_total,
    },
  };
}

/* ── helpers ─────────────────────────────────────────────────────────── */
function median(arr) {
  const a = (arr || []).filter(n => n != null).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
