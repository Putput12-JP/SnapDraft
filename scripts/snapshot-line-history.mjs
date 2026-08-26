#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · LINE HISTORY  →  data/line_history.json

   Records the OPENING line for each game market so the Betting Game Markets
   Edge Board can show line movement (open→current) and flag sharp/steam moves.

   Reads the game lines already in data/lineup-feed.json (vegas_games) — no API
   calls, no credits. First time a game+market is seen its current line is
   frozen as the "open"; every later run updates "cur" and keeps the open.
   Games that leave the feed (finished) drop out.

   Output (read by betting-app.js):
     { generated, count, games: {
         "AWY@HOM": { away, home, commence,
           spread:{open,cur,openedAt},   // home team spread line (signed)
           total:{open,cur,openedAt},    // game total points
           mlHome:{open,cur,openedAt} }  // home team moneyline (American) } }

   Usage:  node scripts/snapshot-line-history.mjs
           node scripts/snapshot-line-history.mjs --feed=data/lineup-feed.json --out=data/line_history.json --dry
   ════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARG = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DRY = !!ARG.dry;
const FEED = ARG.feed ? resolve(process.cwd(), ARG.feed) : resolve(HERE, '..', 'data', 'lineup-feed.json');
const OUT = ARG.out ? resolve(process.cwd(), ARG.out) : resolve(HERE, '..', 'data', 'line_history.json');
const log = (...a) => console.log('[line-history]', ...a);

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; } };
const med = a => { const s = (a || []).filter(v => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// First-seen freeze: keep the open, roll the current forward.
function track(prev, cur, now) {
  if (cur == null) return prev || null;                       // unpriced now → keep whatever we had
  if (!prev || prev.open == null) return { open: cur, cur, openedAt: now };
  return { open: prev.open, cur, openedAt: prev.openedAt };
}

const feed = readJSON(FEED);
if (!feed || !Array.isArray(feed.vegas_games)) { log('no vegas_games in feed — nothing to snapshot'); process.exit(0); }
const prevAll = (readJSON(OUT) || {}).games || {};
const now = new Date().toISOString();
const games = {};

for (const g of feed.vegas_games) {
  if (!g.away || !g.home) continue;
  const key = g.away + '@' + g.home;
  const cur = {
    spread: g.spread && g.spread.cons ? g.spread.cons.home ?? null : null,
    total: g.total ? (g.total.cons ?? null) : null,
    mlHome: g.ml && g.ml.quotes ? med(g.ml.quotes.map(q => q.home)) : null,
  };
  const prev = prevAll[key] || {};
  games[key] = {
    away: g.away, home: g.home, commence: g.commence || null,
    spread: track(prev.spread, cur.spread, now),
    total: track(prev.total, cur.total, now),
    mlHome: track(prev.mlHome, cur.mlHome, now),
  };
}

const payload = { generated: now, count: Object.keys(games).length, games };
const moved = Object.values(games).filter(g => (g.spread && g.spread.open !== g.spread.cur) || (g.total && g.total.open !== g.total.cur) || (g.mlHome && g.mlHome.open !== g.mlHome.cur)).length;
log(payload.count + ' games tracked · ' + moved + ' with movement since open');
if (DRY) { log('--dry: not written'); process.exit(0); }
writeFileSync(OUT, JSON.stringify(payload));
log('wrote ' + OUT);
