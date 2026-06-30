#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · LINEUP COMMAND — daily projection feed builder
   ────────────────────────────────────────────────────────────────────────
   Runs once a day (see daily-projections.yml). Pulls projections from the
   sources below, normalizes them onto Sleeper player_ids, computes a real
   Defense-vs-Position (DvP) table, and writes:

       lineup_command/feed/latest.json

   …which the Lineup Command UI fetches and prefers over its modeled spread.
   The app degrades gracefully if this file is absent, so deploying the cron
   is purely additive — nothing breaks if a source is down on a given day.

   SHAPE written:
   {
     "season": "2026", "week": 1, "generated": "2026-09-03T09:00:00Z",
     "players": { "<sleeperId>": { "sources": { "sleeper": 18.4, "espn": 17.9,
                  "cbs": 18.1, "nfl": 17.6, "draftkings": 19.0 },
                  "stats": { "pass_yd": 262, "pass_td": 1.9, ... } } },
     "dvp": { "BUF": { "QB": {"fpa":16.8,"rank":9}, "RB": {...}, ... }, ... },
     "vegas_teams": { "BUF": { "total": 25.6, "preseason": 26.46, "live": 25.1,
                  "source": "blend", "env": 0.12 }, ... },
     "vegas_players": { "<sleeperId>": { "pos": "WR", "rank": 1,
                  "season": { "rec_yd": 1350, "rec_td": 8.5 } }, ... },
     "vegas_meta": { "live_source": "the-odds-api", "blend_weight": 0.33, ... }
   }

   VEGAS (src-vegas.mjs): preseason workbook (vegas-preseason.json) blended with
   live game lines. `vegas_teams[code].env` is the high/low-total environment
   modifier the client applies to weekly projections; `vegas_players[id].season`
   is the market's season-long stat line (anchor for rest-of-season).

   "stats" is the raw projected stat line from Sleeper — the client multiplies
   it by a league's scoring_settings to reproduce the league-exact projection
   Sleeper shows in-app (e.g. 6-pt pass TD → Allen 25.2, not pts_ppr 23.8).

   SOURCE STATUS (be honest about this — see README):
     • sleeper     ✅ turnkey   — free read API, no key
     • espn        ✅ turnkey   — public read endpoint (no auth for projections)
     • dvp         ✅ turnkey   — COMPUTED from Sleeper stats + schedule (real)
     • cbs         ✅ scrape    — CBS weekly projections pages (PPR), markup-dependent
     • nfl         ✅ scrape    — fantasy.nfl.com projections (std → PPR via Sleeper rec)
     • draftkings  ✅ dfs       — salary-implied via per-position fit to the slate
   Scrape adapters are best-effort: if CBS/NFL change their markup the adapter
   returns {} and that column simply drops out until the selector is updated —
   nothing else breaks. Wire a licensed feed (FantasyPros / Sportradar) into
   any adapter to make it contractual instead of markup-dependent.

   Requires Node 18+ (global fetch). No npm install needed for the turnkey set.
   ════════════════════════════════════════════════════════════════════════ */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildVegas } from './src-vegas.mjs';

const SLEEPER = 'https://api.sleeper.com';
// Written to <repo>/data/lineup-feed.json (run from repo root, matching the ADP job).
const OUT = resolve(process.cwd(), 'data/lineup-feed.json');
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const POS_IDX = { QB: 0, RB: 1, WR: 2, TE: 3 };

const jget = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': 'vault-lineup-cron/1.0', ...(opts.headers || {}) }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
};
const tget = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; vault-lineup-cron/1.0)', 'accept': 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
};
/* team-abbr aliases → Sleeper convention */
const TEAM_ALIAS = { JAC: 'JAX', WSH: 'WAS', LVR: 'LV', ARZ: 'ARI', HST: 'HOU', BLT: 'BAL', CLV: 'CLE', SL: 'LAR', LA: 'LAR' };
const fixTeam = t => TEAM_ALIAS[t] || t;
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

/* ── 0. current season / week ─────────────────────────────────────────── */
async function getState() {
  const s = await jget(`${SLEEPER}/state/nfl`);
  return { season: s.season, week: s.display_week || s.week || s.leg || 1 };
}

/* ── player id resolver (name+team → sleeperId), built from Sleeper ───────
   Two layers: exact "name|team", then unique name-only fallback — team-abbr
   drift (JAC/JAX, WSH/WAS, traded players) is the #1 scrape matcher killer. */
async function buildResolver(rows) {
  const map = {}; // "name|team" -> sleeperId
  const byName = {}; // name -> sleeperId, or false when ambiguous
  for (const row of rows) {
    const pl = row.player || {};
    const id = String(row.player_id);
    const name = norm(`${pl.first_name || ''}${pl.last_name || ''}`);
    const team = (pl.team || row.team || '').toUpperCase();
    if (!name) continue;
    if (team) map[`${name}|${team}`] = id;
    byName[name] = (name in byName && byName[name] !== id) ? false : id;
  }
  map._byName = byName;
  return map;
}
/* resolve with fallback: exact name|team, else unique name-only */
const rid = (resolver, name, team) => {
  const n = norm(name);
  return resolver[`${n}|${fixTeam((team || '').toUpperCase())}`] || resolver._byName[n] || null;
};

/* ── 1. SLEEPER (consensus) ✅ ────────────────────────────────────────── */
async function srcSleeper(season, week) {
  const url = `${SLEEPER}/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=pts_ppr`;
  const rows = await jget(url);
  const out = {}, statlines = {};
  for (const row of rows) {
    const pl = row.player || {};
    if (!SKILL.has(pl.position)) continue;
    const ppr = row.stats?.pts_ppr;
    if (ppr == null) continue;
    const id = String(row.player_id);
    out[id] = round(ppr);
    // raw projected stat line — lets any client re-score with a league's
    // scoring_settings (projection stat keys match scoring keys by design)
    const keep = {};
    for (const k of Object.keys(row.stats || {})) {
      if (/^(pass_|rush_|rec|fum|bonus_|pts_|st_|kr_|pr_)/.test(k)) keep[k] = round(row.stats[k] * 100) / 100;
    }
    statlines[id] = keep;
  }
  return { values: out, rows, statlines };
}

/* ── 2. ESPN (free read endpoint) ✅ ──────────────────────────────────────
   ESPN exposes fantasy projections without auth via the read host. We pull
   the kona_player_info view and read the "projected" stat split (id 10).   */
async function srcESPN(season, week, resolver) {
  try {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const filter = {
      players: {
        limit: 1500,
        filterStatsForExternalIds: { value: [Number(season)] },
        filterStatsForSourceIds: { value: [1] },
        filterStatsForSplitTypeIds: { value: [1] },
        sortPercOwned: { sortPriority: 1, sortAsc: false },
      },
    };
    const data = await jget(url, { headers: { 'x-fantasy-filter': JSON.stringify(filter) } });
    const out = {};
    for (const p of data.players || []) {
      const info = p.player || {};
      const name = norm(info.fullName || '');
      const team = ESPN_TEAM[info.proTeamId] || '';
      const id = rid(resolver, name, team);
      if (!id) continue;
      // find the weekly projection stat entry (statSourceId 1 = projections)
      const wk = (info.stats || []).find(s => s.statSourceId === 1 && s.scoringPeriodId === week);
      const pts = wk?.appliedTotal;
      if (pts != null) out[id] = round(pts);
    }
    return out;
  } catch (e) { warn('espn', e); return {}; }
}

/* ── 3. DvP — COMPUTED from real Sleeper stats + schedule ✅ ───────────────
   Fantasy points (PPR) each defense has allowed to each position, per game,
   over completed weeks of the current season (falls back to prior season in
   the early weeks). Ranked 1 (toughest) … 32 (softest).                    */
async function buildDvP(season, week) {
  try {
    const completed = [];
    for (let w = 1; w < week; w++) completed.push(w);
    let useSeason = season, weeks = completed;
    if (weeks.length < 2) { useSeason = String(Number(season) - 1); weeks = range(1, 17); } // preseason → last year
    const schedule = await getSchedule(useSeason);
    const allow = {}; // team -> [QBpts, RBpts, WRpts, TEpts], and games count
    const games = {};
    for (const w of weeks) {
      let rows;
      try { rows = await jget(`${SLEEPER}/stats/nfl/${useSeason}/${w}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`); }
      catch { continue; }
      const sched = schedule[w] || {};
      for (const row of rows) {
        const pl = row.player || {};
        const pos = pl.position; if (!SKILL.has(pos)) continue;
        const pts = row.stats?.pts_ppr; if (pts == null) continue;
        const team = (pl.team || row.team || '').toUpperCase();
        const opp = (sched[team] || row.opponent || '').toUpperCase();
        if (!opp) continue;
        (allow[opp] = allow[opp] || [0, 0, 0, 0])[POS_IDX[pos]] += pts;
      }
      for (const tm of Object.keys(sched)) games[tm] = (games[tm] || 0) + 1;
    }
    // per-game averages
    const perGame = {};
    for (const tm of Object.keys(allow)) {
      const g = Math.max(1, (games[tm] || weeks.length));
      perGame[tm] = allow[tm].map(v => round(v / g));
    }
    // ranks per position (1 = fewest allowed = toughest)
    const dvp = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const i = POS_IDX[pos];
      const order = Object.keys(perGame).sort((a, b) => perGame[a][i] - perGame[b][i]);
      order.forEach((tm, idx) => { (dvp[tm] = dvp[tm] || {})[pos] = { fpa: perGame[tm][i], rank: idx + 1 }; });
    }
    return dvp;
  } catch (e) { warn('dvp', e); return null; }
}
async function getSchedule(season) {
  // { week: { TEAM: OPP } }
  const out = {};
  try {
    const data = await jget(`${SLEEPER}/schedule/nfl/regular/${season}`);
    for (const g of data || []) {
      const w = g.week; if (!w) continue;
      const home = (g.home || '').toUpperCase(), away = (g.away || '').toUpperCase();
      if (!home || !away) continue;
      out[w] = out[w] || {}; out[w][home] = away; out[w][away] = home;
    }
  } catch (e) { warn('schedule', e); }
  return out;
}

/* ── 4a. CBS ✅ scrape — server-rendered weekly projection tables (PPR) ────
   One page per position. FPTS is the last numeric column of each row.
   Markup-dependent: if CBS redesigns, this returns {} and the column drops. */
async function srcCBS(season, week, resolver) {
  try {
    const out = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      let html;
      try { html = await tget(`https://www.cbssports.com/fantasy/football/stats/${pos}/${season}/${week}/projections/ppr/`); }
      catch (e) { warn('cbs:' + pos, e); continue; }
      const rows = html.split(/<tr[\s>]/).slice(1);
      for (const row of rows) {
        const nameM = row.match(/players\/\d+\/[^"']*["'][^>]*>([^<]+)<\/a>/);
        if (!nameM) continue;
        const teamM = row.match(/teamAbbr[^>]*>\s*([A-Z]{2,3})/) || row.match(/>\s*([A-Z]{2,3})\s+(?:QB|RB|WR|TE)\s*</);
        if (!teamM) continue;
        const nums = [...row.matchAll(/<td[^>]*>\s*(-?\d+(?:\.\d+)?)\s*<\/td>/g)].map(m => parseFloat(m[1]));
        if (!nums.length) continue;
        const fpts = nums[nums.length - 1]; // FPTS = last numeric column
        if (!(fpts > 0) || fpts > 60) continue;
        const id = rid(resolver, nameM[1], teamM[1]);
        if (id) out[id] = round(fpts);
      }
    }
    return out;
  } catch (e) { warn('cbs', e); return {}; }
}

/* ── 4b. NFL.com ✅ scrape — server-rendered projection tables, paginated ───
   NFL.com points are standard scoring (0 PPR); we convert to PPR-equivalent
   by adding Sleeper's projected receptions for the same player, so the
   column is comparable with the others. */
async function srcNFL(season, week, resolver, statlines) {
  try {
    const out = {};
    for (let offset = 1; offset <= 201; offset += 25) {
      let html;
      try { html = await tget(`https://fantasy.nfl.com/research/projections?offset=${offset}&position=O&sort=projectedPts&statCategory=projectedStats&statSeason=${season}&statType=weekProjectedStats&statWeek=${week}`); }
      catch (e) { warn('nfl:offset' + offset, e); break; }
      const rows = html.split(/<tr[\s>]/).slice(1);
      let hits = 0;
      for (const row of rows) {
        const nameM = row.match(/playerName[^"']*["'][^>]*>([^<]+)<\/a>/);
        const posM = row.match(/<em>\s*(QB|RB|WR|TE)\s*[-–]\s*([A-Z]{2,3})/);
        let pts = null;
        const ptsM = row.match(/projected[^>]*>\s*(-?\d+(?:\.\d+)?)\s*</);
        if (ptsM) pts = parseFloat(ptsM[1]);
        if (pts == null) { // NFL.com FPTS is reliably the LAST numeric cell of the row
          const cells = [...row.matchAll(/<td[^>]*>\s*(-?\d+(?:\.\d+)?)\s*<\/td>/g)];
          if (cells.length) pts = parseFloat(cells[cells.length - 1][1]);
        }
        if (!nameM || !posM || pts == null || !(pts > 0) || pts > 60) continue;
        const id = rid(resolver, nameM[1], posM[2]);
        if (!id) continue;
        const rec = (statlines[id] && statlines[id].rec) || 0; // std → PPR
        out[id] = round(pts + rec);
        hits++;
      }
      if (!hits) break; // past the end of the table
    }
    return out;
  } catch (e) { warn('nfl', e); return {}; }
}

/* ── 4c. DraftKings ✅ salary-implied — labeled DFS in the UI ─────────────
   Public lobby + draftables JSON. Salaries aren't projections, so we fit
   salary → Sleeper points per position (least squares over matched players)
   and emit the fitted value: "what this salary implies". Honest directional
   signal — the UI already tags this source DFS. */
async function srcDraftKings(season, week, resolver, sleeperPts) {
  try {
    const lobby = await jget('https://www.draftkings.com/lobby/getcontests?sport=NFL');
    const groups = lobby.DraftGroups || [];
    const grp = groups.find(g => g.ContestTypeId === 21 && /featured/i.test(g.DraftGroupTag || '')) || groups.find(g => g.ContestTypeId === 21);
    if (!grp) return {};
    const dg = await jget(`https://api.draftkings.com/draftgroups/v1/draftgroups/${grp.DraftGroupId}/draftables?format=json`);
    const seen = new Set(), byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const d of dg.draftables || []) {
      if (seen.has(d.playerId) || !SKILL.has(d.position)) continue;
      seen.add(d.playerId);
      const id = rid(resolver, d.displayName, d.teamAbbreviation || '');
      if (!id || !d.salary) continue;
      byPos[d.position].push({ id, salary: d.salary, pts: sleeperPts[id] });
    }
    const out = {};
    for (const pos of Object.keys(byPos)) {
      const matched = byPos[pos].filter(p => p.pts != null);
      if (matched.length < 8) continue; // not enough signal to fit
      const n = matched.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of matched) { sx += p.salary; sy += p.pts; sxx += p.salary * p.salary; sxy += p.salary * p.pts; }
      const den = n * sxx - sx * sx; if (!den) continue;
      const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
      for (const p of byPos[pos]) { const v = a + b * p.salary; if (v > 0.5) out[p.id] = round(v); }
    }
    return out;
  } catch (e) { warn('draftkings', e); return {}; }
}

/* ── orchestrate ──────────────────────────────────────────────────────── */
async function main() {
  const { season, week } = await getState();
  log(`Building feed for ${season} week ${week}…`);
  // Log which optional auth the run sees, so you can confirm in the workflow
  // logs that the right secrets are wired up (without leaking the values).
  const propsKey = process.env.PROPS_API_KEY || process.env.PARLAY_API_KEY;
  const oddsKey = process.env.ODDS_API_KEY;
  log(`  auth: ParlayAPI/Props ${propsKey ? '✓ (' + propsKey.length + ' chars)' : '— not set'} · OddsAPI ${oddsKey ? '✓ (' + oddsKey.length + ' chars)' : '— not set'}`);

  const { values: sleeper, rows, statlines } = await srcSleeper(season, week);
  const resolver = await buildResolver(rows);
  log(`  sleeper: ${Object.keys(sleeper).length} players`);

  // identity map: sleeperId → { name, team, pos } — lets the feed describe its
  // own Vegas players/props (no 5MB client-side Sleeper fetch needed).
  const identity = {};
  for (const row of rows) {
    const pl = row.player || {};
    const id = String(row.player_id);
    const name = `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
    if (name) identity[id] = { name, team: (pl.team || '').toUpperCase() || null, pos: pl.position || null };
  }

  const [espn, cbs, nfl, dk, dvp, vegas] = await Promise.all([
    srcESPN(season, week, resolver),
    srcCBS(season, week, resolver),
    srcNFL(season, week, resolver, statlines),
    srcDraftKings(season, week, resolver, sleeper),
    buildDvP(season, week),
    buildVegas(season, week, rid, resolver, identity),
  ]);
  log(`  espn: ${Object.keys(espn).length} · cbs: ${Object.keys(cbs).length} · nfl: ${Object.keys(nfl).length} · dk: ${Object.keys(dk).length} · dvp teams: ${dvp ? Object.keys(dvp).length : 0}`);
  log(`  vegas: ${Object.keys(vegas.vegas_teams).length} teams (${vegas.meta.live_source}, blend ${vegas.meta.blend_weight}) · ${vegas.meta.players_matched}/${vegas.meta.players_total} players · props: ${vegas.meta.props_players} (${vegas.meta.props_source})`);

  /* sanity gate: a scrape that matched a trickle of players is a broken
     selector producing garbage — drop the column rather than publish it */
  const gate = (map, name, min = 25) => {
    const n = Object.keys(map).length;
    if (n > 0 && n < min) { log(`  [drop ${name}] only ${n} players matched — selector likely broken`); return {}; }
    return map;
  };
  const espnOk = gate(espn, 'espn'), cbsOk = gate(cbs, 'cbs'), nflOk = gate(nfl, 'nfl'), dkOk = gate(dk, 'draftkings');

  // merge per player
  const players = {};
  const put = (map, key) => { for (const id of Object.keys(map)) { (players[id] = players[id] || { sources: {} }).sources[key] = map[id]; } };
  put(sleeper, 'sleeper'); put(espnOk, 'espn'); put(cbsOk, 'cbs'); put(nflOk, 'nfl'); put(dkOk, 'draftkings');
  for (const id of Object.keys(statlines)) if (players[id]) players[id].stats = statlines[id];

  /* PRESERVE EXISTING PROPS when this run produced none.
     PrizePicks props are written by a SEPARATE workflow (update-props.yml).
     Without this guard, every 6h this lineup builder would overwrite their
     work with `{}` — exactly the race that left vegas_player_props empty
     for months. We only swap in fresh props when liveProps actually returned
     a non-empty bundle (ParlayAPI subscribed); otherwise we keep what
     update-props.yml put there. Same logic for vegas_meta.props_* fields. */
  let preservedProps = vegas.vegas_player_props || {};
  let preservedMeta = { ...vegas.meta };
  if (!Object.keys(preservedProps).length) {
    try {
      const prev = JSON.parse(await readFile(OUT, 'utf8'));
      const prevProps = prev && prev.vegas_player_props;
      if (prevProps && Object.keys(prevProps).length) {
        preservedProps = prevProps;
        preservedMeta.props_source = prev.vegas_meta?.props_source ?? preservedMeta.props_source;
        preservedMeta.props_players = prev.vegas_meta?.props_players ?? preservedMeta.props_players;
        preservedMeta.props_events = prev.vegas_meta?.props_events ?? preservedMeta.props_events;
        if (prev.vegas_meta?.props_generated) preservedMeta.props_generated = prev.vegas_meta.props_generated;
        log(`  preserved ${Object.keys(prevProps).length} player props from previous feed (${preservedMeta.props_source})`);
      }
    } catch (e) { /* no previous feed, fine */ }
  }

  const feed = {
    season, week, generated: new Date().toISOString(), players,
    ...(dvp ? { dvp } : {}),
    vegas_teams: vegas.vegas_teams,
    vegas_games: vegas.vegas_games,
    vegas_players: vegas.vegas_players,
    vegas_player_props: preservedProps,
    vegas_meta: preservedMeta,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(feed));
  log(`Wrote ${OUT} — ${Object.keys(players).length} players, ${Math.round(JSON.stringify(feed).length / 1024)}KB`);
}

/* ── helpers ──────────────────────────────────────────────────────────── */
const round = n => Math.round(n * 10) / 10;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const log = (...a) => console.log(...a);
const warn = (src, e) => console.warn(`  [skip ${src}] ${e.message || e}`);
const ESPN_TEAM = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };

main().catch(e => { console.error('FEED BUILD FAILED:', e); process.exit(1); });
