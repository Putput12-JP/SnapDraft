#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · PROP SNAPSHOT LOG  →  data/prop_line_history.json

   Banks the raw inputs needed to BACKTEST the Betting page, using data we
   already ship — no API calls, no credits. Two questions this feeds later:

     1. CLV (closing-line value) for the de-vig / line-shopping engine:
        did the price we flagged (open / best) beat the closing price?
        Answerable WITHOUT game outcomes — just open vs. close per side.
     2. Model Lean backtest: did "Over when proj > line" clear the ~52.4%
        break-even? Answerable by joining `proj_open`/`line` to the weekly
        actuals in data/nflverse_stats_<season>.json.

   Reads the lines already in data/lineup-feed.json:
     · vegas_player_props[pid].lines[market] → line, over, under, best prices
     · players[pid].stats[market]            → Vault projection (Model Lean)

   FREEZE + RETAIN, keyed by season|week|pid|market:
     · first time a key is seen, its snapshot is frozen as `open`;
     · every later run rolls `cur` forward and appends to `samples` only when
       something actually moved (quiet hours are free);
     · keys that leave the feed (game played, prop pulled) are KEPT untouched —
       a backtest needs finished weeks, so unlike line_history nothing is
       dropped. The week in the key means week N and N+1 never collide.

   Usage:  node scripts/snapshot-prop-history.mjs
           node scripts/snapshot-prop-history.mjs --feed=data/lineup-feed.json --out=data/prop_line_history.json --dry
   ════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARG = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DRY = !!ARG.dry;
const FEED = ARG.feed ? resolve(process.cwd(), ARG.feed) : resolve(HERE, '..', 'data', 'lineup-feed.json');
const OUT = ARG.out ? resolve(process.cwd(), ARG.out) : resolve(HERE, '..', 'data', 'prop_line_history.json');
const MAX_SAMPLES = 80;            // per key; open is always kept, oldest extras drop
const log = (...a) => console.log('[prop-history]', ...a);

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Combo yardage markets are derived in the app from base stats; mirror that so
// pass_rush_yd / rush_rec_yd carry a projection too.
function projFor(stats, mk) {
  if (!stats) return null;
  if (stats[mk] != null) return num(stats[mk]);
  if (mk === 'pass_rush_yd' && stats.pass_yd != null && stats.rush_yd != null) return num(stats.pass_yd + stats.rush_yd);
  if (mk === 'rush_rec_yd' && stats.rush_yd != null && stats.rec_yd != null) return num(stats.rush_yd + stats.rec_yd);
  return null;
}

// Best price a bettor could actually take on each side (falls back to scanning
// quotes if the feed didn't precompute `best`).
function bestPrices(cell) {
  let bO = cell.best && cell.best.over ? num(cell.best.over.price) : null;
  let bU = cell.best && cell.best.under ? num(cell.best.under.price) : null;
  for (const q of cell.quotes || []) {
    const o = num(q.over), u = num(q.under);
    if (o != null && (bO == null || o > bO)) bO = o;
    if (u != null && (bU == null || u > bU)) bU = u;
  }
  return { bO, bU };
}

function snapshot(cell, proj, ts) {
  const { bO, bU } = bestPrices(cell);
  return { line: num(cell.line), over: num(cell.over), under: num(cell.under), bestOver: bO, bestUnder: bU, proj: num(proj), ts };
}
// Value signature — used to skip appending a duplicate sample.
const sig = s => [s.line, s.over, s.under, s.bestOver, s.bestUnder, s.proj].join('|');

const feed = readJSON(FEED);
if (!feed || !feed.vegas_player_props || typeof feed.vegas_player_props !== 'object') {
  log('no vegas_player_props in feed — nothing to snapshot'); process.exit(0);
}

const season = feed.season ?? null, week = feed.week ?? null, seasonType = feed.season_type ?? null;
const players = (feed.players && typeof feed.players === 'object') ? feed.players : {};
const now = new Date().toISOString();

const prev = readJSON(OUT) || {};
const props = (prev.props && typeof prev.props === 'object') ? prev.props : {};   // carry ALL prior keys forward (retain finished weeks)

let created = 0, moved = 0, seen = 0;

for (const pid in feed.vegas_player_props) {
  const p = feed.vegas_player_props[pid];
  if (!p || !p.lines) continue;
  const stats = players[pid] && players[pid].stats;
  for (const mk in p.lines) {
    const cell = p.lines[mk];
    if (!cell) continue;
    // real two-way only: need both prices (line may be null for prob-kind markets)
    if (cell.over == null || cell.under == null) continue;
    seen++;

    const key = [season, week, pid, mk].join('|');
    const cur = snapshot(cell, projFor(stats, mk), now);
    const rec = props[key];

    if (!rec) {
      props[key] = {
        season, week, seasonType, pid, name: p.name || null, team: p.team || null,
        pos: p.pos || null, opp: p.opp || null, ha: p.ha || null, market: mk,
        open: cur, cur, firstSeen: now, lastSeen: now, samples: [cur],
      };
      created++;
      continue;
    }
    // existing key: roll cur forward, append a sample only when something moved
    rec.lastSeen = now;
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
}

const payload = { generated: now, season, week, seasonType, keys: Object.keys(props).length, props };
log(`${seen} live two-way lines · ${created} new keys · ${moved} moved · ${payload.keys} total banked`);
if (DRY) { log('--dry: not written'); process.exit(0); }
writeFileSync(OUT, JSON.stringify(payload));
log('wrote ' + OUT);
