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

// Follow Kalshi's cursor to collect all open KXNFLGAME events with markets.
async function fetchEvents() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const u = new URL(BASE + '/events');
    u.searchParams.set('series_ticker', 'KXNFLGAME');
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

function parseEvent(ev) {
  const markets = ev.markets || [];
  if (markets.length !== 2) return null;                 // want a clean two-way winner
  const title = ev.title || '';                          // "Pittsburgh vs Buffalo"
  const vs = title.split(/\s+vs\.?\s+/i);
  const awayCity = (vs[0] || '').trim(), homeCity = (vs[1] || '').trim();
  let away = null, home = null, mlAway = null, mlHome = null, worstSpread = 0, close = null;
  for (const m of markets) {
    const abbr = code(String(m.ticker || '').split('-').pop());
    const q = yesQuote(m);
    if (!q) return null;                                 // a side isn't quoted → skip game
    worstSpread = Math.max(worstSpread, q.spread);
    const city = (m.yes_sub_title || '').trim();
    close = m.close_time || close;
    // Assign to away/home by matching the yes_sub_title (team city) to the title.
    if (awayCity && city && awayCity.toLowerCase().includes(city.toLowerCase())) { away = abbr; mlAway = q.prob; }
    else if (homeCity && city && homeCity.toLowerCase().includes(city.toLowerCase())) { home = abbr; mlHome = q.prob; }
    else if (!away) { away = abbr; mlAway = q.prob; } else { home = abbr; mlHome = q.prob; }
  }
  if (!away || !home || mlAway == null || mlHome == null) return null;
  if (worstSpread > MAX_SPREAD) return null;             // too wide → thin/stale, don't post
  return { key: away + '@' + home, away, home, ml: { away: +mlAway.toFixed(4), home: +mlHome.toFixed(4) }, spreadCents: Math.round(worstSpread * 100), close };
}

(async () => {
  let events;
  try { events = await fetchEvents(); }
  catch (e) { log('fetch failed:', e.message); process.exit(1); }
  log(events.length + ' open KXNFLGAME events');
  const games = {};
  for (const ev of events) { const g = parseEvent(ev); if (g) games[g.key] = g; }
  const payload = { source: 'kalshi', series: 'KXNFLGAME', generated: new Date().toISOString(), count: Object.keys(games).length, games };
  log(payload.count + ' games priced (spread ≤ ' + (MAX_SPREAD * 100) + '¢)');
  Object.values(games).slice(0, 6).forEach(g => log('  ' + g.key + '  away ' + (g.ml.away * 100).toFixed(0) + '¢ / home ' + (g.ml.home * 100).toFixed(0) + '¢  · spread ' + g.spreadCents + '¢'));
  if (DRY) { log('--dry: not written'); return; }
  writeFileSync(OUT, JSON.stringify(payload));
  log('wrote ' + OUT);
})();
