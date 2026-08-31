#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · GAME-MARKET SNAPSHOT LOG  →  data/game_line_history.json

   The game-market twin of scripts/snapshot-prop-history.mjs. Banks the raw
   spread / total / moneyline snapshots the settlement + CLV harness needs,
   using data we already ship (data/lineup-feed.json vegas_games) — no API
   calls, no credits.

   WHY THIS EXISTS SEPARATELY from data/line_history.json:
     line_history.json feeds the LIVE board (open→cur movement) and DROPS a
     game the moment it leaves the feed (finished). Settlement needs the
     opposite: finished games must be KEPT so we can grade them once the score
     lands. So this file RETAINS every key, exactly like prop_line_history.

   FREEZE + RETAIN, keyed by season|seasonType|week|AWY@HOM:
     · first time a key is seen, its snapshot is frozen as `open`;
     · every later run rolls `cur` forward and appends to `samples` only when
       something actually moved;
     · keys that leave the feed (game played) are KEPT untouched — the last
       sample is the closing-line proxy the CLV harness reads.
     · seasonType is in the key so preseason week N and regular week N never
       collide (same reason as the prop log).

   Output (read by scripts/settle_bets.py):
     { generated, season, seasonType, week, keys, games: {
        "AWY@HOM key": { season, seasonType, week, away, home, commence,
          open:{spread,total,mlHome,ts}, cur:{…}, firstSeen, lastSeen,
          samples:[{spread,total,mlHome,ts}, …] } } }

   Usage:  node scripts/snapshot-game-history.mjs
           node scripts/snapshot-game-history.mjs --feed=data/lineup-feed.json --out=data/game_line_history.json --dry
   ════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARG = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DRY = !!ARG.dry;
const FEED = ARG.feed ? resolve(process.cwd(), ARG.feed) : resolve(HERE, '..', 'data', 'lineup-feed.json');
const OUT = ARG.out ? resolve(process.cwd(), ARG.out) : resolve(HERE, '..', 'data', 'game_line_history.json');
const MAX_SAMPLES = 120;           // per key; open (idx 0) always kept, oldest middles drop
const log = (...a) => console.log('[game-history]', ...a);

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const med = a => { const s = (a || []).filter(v => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const normCdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

// Vault game model (data/game_model.json) — the same math gmPredict() serves in
// index.html. Banked per snapshot so the settlement harness can grade the model
// line AS IT WAS going into each game (the model refits weekly, so it drifts).
const GM = readJSON(resolve(HERE, '..', 'data', 'game_model.json'));
function vaultLine(away, home) {
  if (!GM || !GM.teams || GM.offseason) return null;   // offseason ratings are stale; gmPredict is gated off then too
  const A = GM.teams[away], H = GM.teams[home];
  if (!A || !H) return null;
  const hfa = GM.hfa || 0, base = GM.base_pts || 0;
  const margin = H.rate - A.rate + hfa;                       // home margin
  const total = 2 * base + (H.off + A.off) - (A.def + H.def); // hfa/2 terms cancel
  return { spread: num(-margin), total: num(total), winHome: num(normCdf(margin / (GM.sd_margin || 13.2))) };
}

function snapshot(g, ts) {
  return {
    spread: g.spread && g.spread.cons ? num(g.spread.cons.home) : null,   // home spread (signed)
    total: g.total ? num(g.total.cons) : null,                            // game total
    mlHome: g.ml && g.ml.quotes ? med(g.ml.quotes.map(q => q.home)) : null, // home moneyline (American)
    vault: vaultLine(g.away, g.home),                                     // model line as-of now (null offseason/unmapped)
    ts,
  };
}
// Value signature — used to skip appending a duplicate sample (ts-only refresh is free).
const sig = s => [s.spread, s.total, s.mlHome].join('|');

const feed = readJSON(FEED);
if (!feed || !Array.isArray(feed.vegas_games)) { log('no vegas_games in feed — nothing to snapshot'); process.exit(0); }

const season = feed.season ?? null, week = feed.week ?? null, seasonType = feed.season_type ?? null;
const now = new Date().toISOString();

const prev = readJSON(OUT) || {};
const games = (prev.games && typeof prev.games === 'object') ? prev.games : {};   // carry ALL prior keys forward (retain finished)

let created = 0, moved = 0, seen = 0;

for (const g of feed.vegas_games) {
  if (!g.away || !g.home) continue;
  seen++;
  const key = [season, seasonType, week, g.away + '@' + g.home].join('|');
  const cur = snapshot(g, now);
  const rec = games[key];

  if (!rec) {
    games[key] = {
      season, seasonType, week, away: g.away, home: g.home, commence: g.commence || null,
      open: cur, cur, firstSeen: now, lastSeen: now, samples: [cur],
    };
    created++;
    continue;
  }
  rec.lastSeen = now;
  rec.commence = g.commence || rec.commence || null;
  const last = rec.samples && rec.samples.length ? rec.samples[rec.samples.length - 1] : rec.open;
  if (!last || sig(last) !== sig(cur)) {
    rec.cur = cur;
    rec.samples = rec.samples || [rec.open];
    rec.samples.push(cur);
    if (rec.samples.length > MAX_SAMPLES) rec.samples.splice(1, rec.samples.length - MAX_SAMPLES); // keep open (idx 0), drop oldest middles
    moved++;
  } else {
    rec.cur = cur;   // ts refresh only; not a movement
  }
}

const payload = { generated: now, season, seasonType, week, keys: Object.keys(games).length, games };
log(`${seen} live games · ${created} new keys · ${moved} moved · ${payload.keys} total banked`);
if (DRY) { log('--dry: not written'); process.exit(0); }
writeFileSync(OUT, JSON.stringify(payload));
log('wrote ' + OUT);
