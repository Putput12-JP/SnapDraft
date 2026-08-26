#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · KALSHI GAME MARKETS  →  data/prediction_markets.json

   Pulls NFL game-winner prices from Kalshi, a CFTC-regulated prediction
   exchange, and writes a second, independent implied-probability per game so
   the Betting tab's Game Markets Edge Board can cross-check the sportsbook fair
   and flag cross-venue arbitrage (VaultBettingMath.findArbitrage).

   Keyless, public, no credits — same free posture as the PrizePicks feed.
   Endpoint: https://api.elections.kalshi.com/trade-api/v2 (series KXNFLGAME).
   Each event is a game with two markets (one per team); a market's yes price
   is that team's win probability. We take the bid/ask mid and require a little
   liquidity so thin/stale markets never post a fake number.

   Output shape (read by betting-app.js):
     { source, generated, count, games: {
         "AWY@HOM": { away, home, ml:{away:<prob>,home:<prob>},
                      liquidity, close } } }

   Moneyline (game winner) only for now; KXNFLSPREAD / KXNFLTOTAL can be added
   the same way. Usage:
     node scripts/fetch-kalshi.mjs                 # fetch, write data/prediction_markets.json
     node scripts/fetch-kalshi.mjs --dry           # fetch, print summary, write nothing
     node scripts/fetch-kalshi.mjs --out=path.json # custom output
   ════════════════════════════════════════════════════════════════════════ */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARG = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DRY = !!ARG.dry;
const OUT = ARG.out ? resolve(process.cwd(), ARG.out) : resolve(HERE, '..', 'data', 'prediction_markets.json');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = { 'User-Agent': 'VaultFantasy/1.0 (+vaultfantasy.com)', 'Accept': 'application/json' };
const MAX_SPREAD = 0.10;    // yes bid/ask spread — wider = too thin/stale to trust
                            // (Kalshi's liquidity_dollars reads 0 here even on
                            //  tight two-sided markets, so spread is the real gate)
const log = (...a) => console.log('[kalshi]', ...a);

// Kalshi team abbreviation → Vault code (most already match).
const ALIAS = { WSH: 'WAS', JAC: 'JAX', LVR: 'LV', LA: 'LAR', SFO: 'SF', GBP: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', TAM: 'TB' };
const code = a => { const u = String(a || '').toUpperCase(); return ALIAS[u] || u; };

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

// Follow Kalshi's cursor to collect all open events for a series, with markets.
async function fetchEvents(series) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const u = new URL(BASE + '/events');
    u.searchParams.set('series_ticker', series);
    u.searchParams.set('status', 'open');
    u.searchParams.set('with_nested_markets', 'true');
    u.searchParams.set('limit', '200');
    if (cursor) u.searchParams.set('cursor', cursor);
    const j = await getJSON(u.toString());
    (j.events || []).forEach(e => out.push(e));
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  return out;
}

// Kalshi yes price for a market: mid of (yes_bid, yes_ask), yes_ask = 1 - no_bid.
// Returns { prob, spread } in dollars, or null when not a real two-sided quote.
function yesQuote(m) {
  const yb = num(m.yes_bid_dollars);
  const nb = num(m.no_bid_dollars);
  const ya = nb != null ? 1 - nb : null;
  if (yb == null || ya == null) return null;
  return { prob: (yb + ya) / 2, spread: Math.abs(ya - yb) };
}

// Shared match id from any series ticker: KXNFLGAME-26AUG27PITBUF → 26AUG27PITBUF.
const matchId = t => String(t || '').split('-')[1] || '';

// KXNFLGAME event → { mid, key, away, home, ml } (the clean two-way winner).
function parseGame(ev) {
  const markets = ev.markets || [];
  if (markets.length !== 2) return null;
  const vs = (ev.title || '').split(/\s+vs\.?\s+/i);
  const awayCity = (vs[0] || '').trim(), homeCity = (vs[1] || '').trim();
  let away = null, home = null, mlAway = null, mlHome = null, worstSpread = 0, close = null;
  for (const m of markets) {
    const abbr = code(String(m.ticker || '').split('-').pop());
    const q = yesQuote(m);
    if (!q) return null;
    worstSpread = Math.max(worstSpread, q.spread);
    const city = (m.yes_sub_title || '').trim();
    close = m.close_time || close;
    if (awayCity && city && awayCity.toLowerCase().includes(city.toLowerCase())) { away = abbr; mlAway = q.prob; }
    else if (homeCity && city && homeCity.toLowerCase().includes(city.toLowerCase())) { home = abbr; mlHome = q.prob; }
    else if (!away) { away = abbr; mlAway = q.prob; } else { home = abbr; mlHome = q.prob; }
  }
  if (!away || !home || mlAway == null || mlHome == null || worstSpread > MAX_SPREAD) return null;
  return { mid: matchId(ev.event_ticker), key: away + '@' + home, away, home,
    ml: { away: +mlAway.toFixed(4), home: +mlHome.toFixed(4) }, close };
}

// KXNFLTOTAL event → sorted "Over strike" ladder [[strike, P(over)], …] (tight strikes only).
function totalLadder(ev) {
  const out = [];
  for (const m of ev.markets || []) {
    const s = num(m.floor_strike), q = yesQuote(m);
    if (s == null || !q || q.spread > MAX_SPREAD) continue;
    out.push([s, +q.prob.toFixed(3)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length >= 3 ? out : null;
}

// KXNFLSPREAD event → per-team "wins by over strike" ladders { ABBR: [[strike, P], …] }.
function spreadLadders(ev, away, home) {
  const by = {};
  for (const m of ev.markets || []) {
    const suf = String(m.ticker || '').split('-').pop();      // "BUF17"
    const abbr = code((suf.match(/^[A-Za-z]+/) || [''])[0]);
    const s = num(m.floor_strike), q = yesQuote(m);
    if (!abbr || s == null || !q || q.spread > MAX_SPREAD) continue;
    if (abbr !== away && abbr !== home) continue;
    (by[abbr] = by[abbr] || []).push([s, +q.prob.toFixed(3)]);
  }
  for (const a in by) by[a].sort((x, y) => x[0] - y[0]);
  return Object.keys(by).length ? by : null;
}

(async () => {
  let gameEvs, totalEvs, spreadEvs;
  try { [gameEvs, totalEvs, spreadEvs] = await Promise.all([fetchEvents('KXNFLGAME'), fetchEvents('KXNFLTOTAL'), fetchEvents('KXNFLSPREAD')]); }
  catch (e) { log('fetch failed:', e.message); process.exit(1); }
  log(gameEvs.length + ' game · ' + totalEvs.length + ' total · ' + spreadEvs.length + ' spread events');

  const byMatch = {};
  for (const ev of gameEvs) { const g = parseGame(ev); if (g) byMatch[g.mid] = g; }
  for (const ev of totalEvs) { const g = byMatch[matchId(ev.event_ticker)]; if (g) g.total = totalLadder(ev); }
  for (const ev of spreadEvs) { const g = byMatch[matchId(ev.event_ticker)]; if (g) g.spread = spreadLadders(ev, g.away, g.home); }

  const games = {};
  for (const mid in byMatch) { const g = byMatch[mid]; games[g.key] = { away: g.away, home: g.home, ml: g.ml, total: g.total || null, spread: g.spread || null, close: g.close }; }
  const payload = { source: 'kalshi', series: 'KXNFLGAME+SPREAD+TOTAL', generated: new Date().toISOString(), count: Object.keys(games).length, games };
  const nT = Object.values(games).filter(g => g.total).length, nS = Object.values(games).filter(g => g.spread).length;
  log(payload.count + ' games · ' + nT + ' with total ladder · ' + nS + ' with spread ladders');
  Object.values(games).slice(0, 5).forEach(g => log('  ' + g.away + '@' + g.home + '  ml ' + (g.ml.away * 100).toFixed(0) + '/' + (g.ml.home * 100).toFixed(0) + '¢  total ' + (g.total ? g.total.length : 0) + ' · spread ' + (g.spread ? Object.keys(g.spread).length : 0)));
  if (DRY) { log('--dry: not written'); return; }
  writeFileSync(OUT, JSON.stringify(payload));
  log('wrote ' + OUT);
})();
