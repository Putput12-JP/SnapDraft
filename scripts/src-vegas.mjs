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
const UA = { 'user-agent': 'vault-lineup-cron/1.0' };
function propsProvider() {
  // Accept either PROPS_API_KEY or PARLAY_API_KEY — both names appear in the
  // probe script and the workflow YAML, so users who configured one or the
  // other don't have to remember which.
  const key = process.env.PROPS_API_KEY || process.env.PARLAY_API_KEY || '';
  const host = process.env.PROPS_API_HOST || (key ? 'parlay-api.com' : '');
  const isParlay = /parlay/i.test(host);
  return { key, host, isParlay, base: isParlay ? `https://${host}/v1` : `https://${host}/v4` };
}
async function provGet(prov, path) {
  const sep = path.includes('?') ? '&' : '?';
  if (prov.isParlay) return fetch(`${prov.base}${path}`, { headers: { ...UA, 'X-API-Key': prov.key } });
  return fetch(`${prov.base}${path}${sep}apiKey=${prov.key}`, { headers: UA });
}
const abbrTok = s => { const m = String(s || '').trim().match(/^([A-Z]{2,3})\b/); return m ? fixAbbr(m[1]) : codeFromName(s); };

async function liveOddsAPI(week) {
  const prov = propsProvider();
  let r, gameHost;
  if (prov.key && prov.isParlay) {
    r = await provGet(prov, `/sports/americanfootball_nfl/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american`);
    gameHost = prov.host;
  } else if (process.env.ODDS_API_KEY) {
    r = await fetch(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?regions=us&markets=spreads,totals,h2h&oddsFormat=american&apiKey=${process.env.ODDS_API_KEY}`, { headers: UA });
    gameHost = 'the-odds-api.com';
  } else { return null; }
  if (!r.ok) throw new Error(`HTTP ${r.status} game-odds`);
  const games = await r.json();
  const out = {};      // code -> implied total
  const gameArr = [];  // per-game market detail (spread/total/ML + price + book)
  for (const g of games || []) {
    const home = codeFromName(g.home_team), away = codeFromName(g.away_team);
    if (!home || !away) continue;
    // median total + median spread-per-team across books, PLUS a representative
    // book that actually offers the consensus line (for price + attribution).
    const totals = [], spreads = {}; // spreads[team] = [points...]
    const byBook = {};               // bookTitle -> { total:{line,over,under}, spread:{team,line,price}, ml:{home,away} }
    for (const bk of g.bookmakers || []) {
      const book = bk.title || bk.key;
      const slot = byBook[book] = byBook[book] || {};
      for (const mk of bk.markets || []) {
        if (mk.key === 'totals') {
          const ov = (mk.outcomes || []).find(o => /over/i.test(o.name));
          const un = (mk.outcomes || []).find(o => /under/i.test(o.name));
          if (ov && ov.point != null) { totals.push(ov.point); slot.total = { line: ov.point, over: ov.price ?? null, under: un?.price ?? null }; }
        } else if (mk.key === 'spreads') {
          for (const o of mk.outcomes || []) {
            const c = codeFromName(o.name); if (!c || o.point == null) continue;
            (spreads[c] = spreads[c] || []).push(o.point);
            (slot.spread = slot.spread || {})[c] = { line: o.point, price: o.price ?? null };
          }
        } else if (mk.key === 'h2h') {
          for (const o of mk.outcomes || []) {
            const c = codeFromName(o.name); if (!c) continue;
            (slot.ml = slot.ml || {})[c] = o.price ?? null;
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
    // pick the book whose total line == consensus (else first book) for attribution
    let repBook = null, repSlot = null;
    for (const b in byBook) { if (byBook[b].total && byBook[b].total.line === total) { repBook = b; repSlot = byBook[b]; break; } }
    if (!repBook) { repBook = Object.keys(byBook)[0] || null; repSlot = repBook ? byBook[repBook] : {}; }
    const favTeam = (median(spreads[home] || []) ?? 0) < 0 ? home : away;
    const favLine = median(spreads[favTeam] || []);
    const bookNames = Object.keys(byBook);
    // per-book quote arrays for the comparison grid (mirrors props)
    const totalQuotes = bookNames.filter(b => byBook[b].total).map(b => ({ book: b, line: byBook[b].total.line ?? null, over: byBook[b].total.over ?? null, under: byBook[b].total.under ?? null }));
    const spreadQuotes = bookNames.filter(b => byBook[b].spread).map(b => ({ book: b, away: byBook[b].spread[away] || null, home: byBook[b].spread[home] || null }));
    const mlQuotes = bookNames.filter(b => byBook[b].ml).map(b => ({ book: b, away: byBook[b].ml[away] ?? null, home: byBook[b].ml[home] ?? null }));
    const bestPrice = (arr, pick) => arr.reduce((best, q) => { const p = pick(q); return (p != null && (!best || p > best.price)) ? { book: q.book, price: p } : best; }, null);
    gameArr.push({
      away, home,
      implied: { away: out[away] ?? null, home: out[home] ?? null },
      total: {
        cons: total, quotes: totalQuotes,
        best: { over: bestPrice(totalQuotes, q => q.over), under: bestPrice(totalQuotes, q => q.under) },
      },
      spread: {
        fav: favTeam,
        cons: { away: median(spreads[away] || []), home: median(spreads[home] || []) },
        quotes: spreadQuotes,
        best: { away: bestPrice(spreadQuotes, q => q.away?.price), home: bestPrice(spreadQuotes, q => q.home?.price) },
      },
      ml: {
        quotes: mlQuotes,
        best: { away: bestPrice(mlQuotes, q => q.away), home: bestPrice(mlQuotes, q => q.home) },
      },
      book: repBook, commence: g.commence_time,
    });
  }
  return Object.keys(out).length ? { implied: out, games: gameArr, host: gameHost } : null;
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

/* ── WEEKLY PLAYER PROPS (stub — flip on with a key) ─────────────────────
   Works against The Odds API's /v4 event-odds shape. ParlayAPI aliases that
   exact URL pattern, so this same code targets EITHER provider — you only
   change two env vars:

       PROPS_API_HOST   default 'api.the-odds-api.com'
                        ParlayAPI → 'api.parlay-api.com' (or per their docs)
       PROPS_API_KEY    your key for whichever host above

   No key → returns null and the Weekly props tab stays in its empty state.
   Nothing here can break the rest of the feed (orchestrator try/wraps it).

   Shape per market outcome (both providers): { description: <player name>,
   name: 'Over'/'Under', point: <line> }. We keep the OVER line as the prop.

   Markets pulled (Sleeper stat key ← Odds API market key):
       pass_yd ← player_pass_yds      pass_td ← player_pass_tds
       rush_yd ← player_rush_yds      rec_yd  ← player_reception_yds
       rec     ← player_receptions    anytime_td ← player_anytime_td        */
/* market-key maps → Sleeper stat. ParlayAPI (live) and The Odds API (fallback)
   name their markets differently, so we keep a map per provider. */
const PARLAY_MARKETS = {
  player_pass_yards: 'pass_yd', player_pass_tds: 'pass_td',
  player_rush_yards: 'rush_yd', player_rush_tds: 'rush_td',
  player_receiving_yards: 'rec_yd', player_rec_yds: 'rec_yd',
  player_receptions: 'rec', player_anytime_touchdown_scorer: 'anytime_td',
};
const TOA_MARKETS = {
  player_pass_yds: 'pass_yd', player_pass_tds: 'pass_td',
  player_rush_yds: 'rush_yd', player_rush_tds: 'rush_td',
  player_reception_yds: 'rec_yd', player_receptions: 'rec',
  player_anytime_td: 'anytime_td',
};
const americanToProb = p => p == null ? null : (p < 0 ? (-p) / (-p + 100) : 100 / (p + 100));

/* Consensus line = the mode, not the median. median(34.5, 35.5) is 35 — a
   number no book offers, and a whole number implies a push that pick'em apps
   never allow. Ties resolve to the line nearest the middle of the market, then
   to the lower line, so repeated builds are stable. */
function modalLine(vals) {
  const a = (vals || []).filter(v => v != null).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const n = a.length, mid = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  const freq = new Map();
  a.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
  let pick = null, pickN = -1;
  for (const [v, n] of freq) {
    if (n > pickN) { pick = v; pickN = n; continue; }
    if (n < pickN) continue;
    const dv = Math.abs(v - mid), dp = Math.abs(pick - mid);
    if (dv < dp || (dv === dp && v < pick)) pick = v;
  }
  return pick;
}

/* Best price for a side, ranked on the LINE first. A lower line is strictly
   better for an OVER and a higher one for an UNDER; comparing price alone let
   flat-priced pick'em apps (PrizePicks +100/-100, Underdog -112/-112) win every
   contested cell over a sportsbook's -110 regardless of the number they were
   posting. Price only breaks a tie. anytime_td quotes all carry line 0, so they
   fall straight through to the price comparison. */
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

/* build a consensus cell (modal line + best over/under + every book quote)
   from books = { bookTitle: { line, over, under, prob } } */
function consensusCell(stat, books) {
  const quotes = Object.entries(books).map(([book, v]) => ({ book, line: v.line ?? null, over: v.over ?? null, under: v.under ?? null, prob: v.prob ?? null }));
  const cons = stat === 'anytime_td' ? null : modalLine(quotes.map(q => q.line).filter(v => v != null));
  const bestOver = bestSide(quotes, 'over');
  const bestUnder = bestSide(quotes, 'under');
  return stat === 'anytime_td'
    ? { prob: round(median(quotes.map(q => q.prob).filter(v => v != null))), over: bestOver?.price ?? null, book: bestOver?.book ?? null, quotes, best: { over: bestOver } }
    : { line: cons, over: bestOver?.price ?? null, under: bestUnder?.price ?? null, book: bestOver?.book ?? null, quotes, best: { over: bestOver, under: bestUnder } };
}

/* dispatcher: ParlayAPI flat /props (preferred) or TOA per-event (fallback) */
async function liveProps(rid, resolver, identity) {
  const prov = propsProvider();
  if (!prov.key) return null;
  return prov.isParlay ? livePropsParlay(prov, rid, resolver, identity)
                       : livePropsTOA(prov, rid, resolver, identity);
}

/* ParlayAPI: ONE call returns a FLAT array — one row per
   event×book×player×market. Group by player+market → consensus cells.
   Row shape: { player, market_key, bookmaker_title, line, over_price,
   under_price, implied_probability, home_team:"SEA Seahawks", away_team,
   commence_time, event_id }. */
async function livePropsParlay(prov, rid, resolver, identity) {
  const r = await provGet(prov, `/sports/americanfootball_nfl/props?regions=us&oddsFormat=american`);
  if (!r.ok) throw new Error(`HTTP ${r.status} parlay:props`);
  const rows = await r.json();
  if (!Array.isArray(rows)) return { props: {}, events_fetched: 0, host: prov.host };
  const acc = {}, meta = {}, events = new Set();
  for (const row of rows) {
    const stat = PARLAY_MARKETS[row.market_key]; if (!stat) continue;
    const nm = row.player; if (!nm || /^\d+$/.test(String(nm))) continue;   // skip team/margin rows (player:"0")
    const id = rid(resolver, nm, ''); if (!id) continue;
    const book = row.bookmaker_title || row.bookmaker; if (!book) continue;
    events.add(row.event_id);
    const slot = (((acc[id] = acc[id] || {})[stat] = acc[id][stat] || {})[book] = acc[id][stat][book] || {});
    slot.line = row.line ?? null;
    slot.over = row.over_price ?? null;
    slot.under = row.under_price ?? null;
    if (stat === 'anytime_td') slot.prob = row.implied_probability != null ? row.implied_probability / 100 : americanToProb(row.over_price);
    if (!meta[id]) meta[id] = { name: nm, home: abbrTok(row.home_team), away: abbrTok(row.away_team), commence: row.commence_time };
  }
  const out = {};
  for (const id in acc) {
    const lines = {};
    for (const stat in acc[id]) lines[stat] = consensusCell(stat, acc[id][stat]);
    const ident = identity?.[id] || {};
    const team = ident.team || null;
    const m = meta[id] || {};
    const ha = team === m.home ? 'home' : team === m.away ? 'away' : null;
    const opp = team === m.home ? m.away : team === m.away ? m.home : null;
    out[id] = { name: ident.name || m.name, team, pos: ident.pos || null, opp, ha, lines, event: `${m.away || ''} @ ${m.home || ''}`, commence: m.commence || null };
  }
  return { props: out, events_fetched: events.size, host: prov.host };
}

/* The Odds API: per-event /events/{id}/odds (kept as a fallback provider) */
async function livePropsTOA(prov, rid, resolver, identity) {
  const markets = Object.keys(TOA_MARKETS).join(',');
  const base = `${prov.base}/sports/americanfootball_nfl`;
  const evRes = await fetch(`${base}/events?apiKey=${prov.key}`, { headers: UA });
  if (!evRes.ok) throw new Error(`HTTP ${evRes.status} props:events`);
  const events = await evRes.json();
  const out = {}; let fetched = 0;
  for (const ev of (events || []).slice(0, 16)) {
    const homeCode = codeFromName(ev.home_team), awayCode = codeFromName(ev.away_team);
    let data;
    try {
      const r = await fetch(`${base}/events/${ev.id}/odds?regions=us&markets=${markets}&oddsFormat=american&apiKey=${prov.key}`, { headers: UA });
      if (!r.ok) { warn(`props:event ${ev.id}`, new Error('HTTP ' + r.status)); continue; }
      data = await r.json(); fetched++;
    } catch (e) { warn(`props:event ${ev.id}`, e); continue; }
    const acc = {};
    for (const bk of data.bookmakers || []) {
      const book = bk.title || bk.key;
      for (const mk of bk.markets || []) {
        const stat = TOA_MARKETS[mk.key]; if (!stat) continue;
        for (const o of mk.outcomes || []) {
          const nm = o.description || o.name; if (!nm) continue;
          const slot = (((acc[nm] = acc[nm] || {})[stat] = acc[nm][stat] || {})[book] = acc[nm][stat][book] || {});
          if (stat === 'anytime_td') {
            if (/yes|over/i.test(o.name) || o.description) { slot.line = null; slot.over = o.price ?? null; slot.prob = americanToProb(o.price); }
          } else if (o.point != null) {
            slot.line = o.point;
            if (/over/i.test(o.name)) slot.over = o.price ?? null;
            else if (/under/i.test(o.name)) slot.under = o.price ?? null;
          }
        }
      }
    }
    for (const nm in acc) {
      const id = rid(resolver, nm, ''); if (!id) continue;
      const lines = {};
      for (const stat in acc[nm]) lines[stat] = consensusCell(stat, acc[nm][stat]);
      const ident = identity?.[id] || {};
      const team = ident.team || null;
      const ha = team === homeCode ? 'home' : team === awayCode ? 'away' : null;
      const opp = team === homeCode ? awayCode : team === awayCode ? homeCode : null;
      out[id] = { name: ident.name || nm, team, pos: ident.pos || null, opp, ha, lines, event: `${awayCode || ev.away_team} @ ${homeCode || ev.home_team}`, commence: ev.commence_time };
    }
  }
  return { props: out, events_fetched: fetched, host: prov.host };
}

/* ── resolve player season lines → Sleeper ids ───────────────────────────
   `rid` is the cron's resolver (name+team → sleeperId). The workbook has no
   team column, so we lean on its unique-name fallback; ambiguous names that
   don't resolve are simply skipped (logged in the count). */
function buildVegasPlayers(seed, rid, resolver, identity) {
  const players = {};
  let matched = 0;
  for (const p of seed?.players || []) {
    const id = rid(resolver, p.name, '');
    if (!id) continue;
    matched++;
    const ident = identity?.[id] || {};
    players[id] = {
      name: ident.name || p.name,            // identity from Sleeper, workbook fallback
      team: ident.team || null,
      pos: p.pos,
      rank: p.rank,
      season: p.stats,                       // season-total stat line
    };
  }
  return { players, matched, total: (seed?.players || []).length };
}

/* schedule → matchup-to-week map.
   Sleeper /schedule/nfl/regular/{season} returns one row per game with
   { week, home, away }. We key BOTH orientations so a lookup by either
   (away, home) or (home, away) finds the right week. Used to tag each
   live odds game with the NFL week it belongs to — without that tag
   the client can't filter by current week and ends up with a mix. */
async function loadWeekByMatchup(season) {
  try {
    const r = await fetch(`https://api.sleeper.com/schedule/nfl/regular/${season}`, { headers: UA });
    if (!r.ok) return {};
    const data = await r.json();
    const out = {};
    for (const g of data || []) {
      const w = g.week; if (!w) continue;
      const home = (g.home || '').toUpperCase(), away = (g.away || '').toUpperCase();
      if (!home || !away) continue;
      // Key ONLY the exact away@home orientation. Keying both orientations
      // collides for division home-and-away pairs: the later meeting (e.g. the
      // Week-14 LAR@SF) overwrites the earlier meeting (Week-1 SF@LAR) for BOTH
      // keys, so the current-week game gets the wrong week and the client drops
      // it. The odds source's home/away matches the schedule's per meeting, so
      // the exact orientation is correct; an unmatched game just stays untagged.
      out[`${away}@${home}`] = w;
    }
    return out;
  } catch (e) { warn('schedule', e); return {}; }
}

/* ── orchestrate: returns { vegas_teams, vegas_players, meta } ──────────── */
export async function buildVegas(season, week, rid, resolver, identity = {}) {
  const seed = await loadVegasSeed();
  if (!seed) return { vegas_teams: {}, vegas_players: {}, meta: { mode: 'none' } };

  // live team totals: Odds API → ESPN → none. liveOddsAPI returns {implied,games};
  // liveESPN returns a flat implied map. Normalize both to { implied, games }.
  let live = null, liveSrc = 'none', liveGames = [];
  try {
    const oa = await liveOddsAPI(week);
    if (oa) { live = oa.implied; liveGames = oa.games || []; liveSrc = oa.host || 'the-odds-api'; }
  } catch (e) { warn('vegas:odds-api', e); }
  if (!live) {
    try { const e2 = await liveESPN(season, week); if (e2) { live = e2; liveSrc = 'espn'; } }
    catch (e) { warn('vegas:espn', e); }
  }

  // tag each live odds game with its NFL week, so the client can show only
  // the current week's slate (Odds API returns every upcoming game across
  // multiple weeks; without this tag they all collapse together).
  if (liveGames.length) {
    const weekByMatchup = await loadWeekByMatchup(season);
    for (const g of liveGames) {
      const k = `${g.away}@${g.home}`;
      if (weekByMatchup[k]) g.week = weekByMatchup[k];
    }
  }

  const vegas_teams = blend(seed, live, week);
  const { players: vegas_players, matched, total } = buildVegasPlayers(seed, rid, resolver, identity);
  const w = clamp((week - 1) / 3, 0, 1);

  // weekly player props — dormant until PROPS_API_KEY is set (ParlayAPI / Odds API)
  let propsBundle = null;
  try { propsBundle = await liveProps(rid, resolver, identity); }
  catch (e) { warn('vegas:props', e); }

  return {
    vegas_teams,
    vegas_games: liveGames,                            // [] until live (per-game spread/total/ML + price + book)
    vegas_players,
    vegas_player_props: propsBundle?.props || {},      // {} until subscribed
    meta: {
      live_source: liveSrc,
      live_teams: live ? Object.keys(live).length : 0,
      live_games: liveGames.length,
      blend_weight: round(w),            // 0 = pure preseason, 1 = pure live
      players_matched: matched,
      players_total: total,
      league_avg: seed.league_avg_team_total,
      props_source: propsBundle ? propsBundle.host : 'none',
      props_players: propsBundle ? Object.keys(propsBundle.props).length : 0,
      props_events: propsBundle ? propsBundle.events_fetched : 0,
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
