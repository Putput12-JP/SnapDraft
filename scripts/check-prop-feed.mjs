/* ═══════════════════════════════════════════════════════════════════════════
   check-prop-feed.mjs — guardian for data/lineup-feed.json player props.

   The board draws player props from several sources (ParlayAPI book lines via
   build-lineup-feed, plus PrizePicks / Underdog / Sleeper via fetch-pickem-props).
   When one comes back THIN, the feed can quietly lose whole market families —
   e.g. every QB passing line — and the board (default view: QB Passing Yards)
   looks empty. build-lineup-feed now MERGES rather than overwrites, so a thin
   response can't delete anything; this script is the second net: it asserts the
   feed is actually healthy and exits non-zero when it isn't, so the guardian
   workflow can self-heal (re-run the free PrizePicks enrichment) and, if it's
   STILL degraded, fail — which emails the repo owner.

   Usage:
     node scripts/check-prop-feed.mjs [--feed=data/lineup-feed.json]
   Exit 0 = healthy (or off-season, where thin/empty props are expected and only
   reported). Exit 1 = degraded during the regular season.

   Thresholds are deliberately conservative so a normal bye week (up to ~6 teams
   idle) never trips a false alarm — the real failure signature is a CORE MARKET
   vanishing entirely, which these catch immediately.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs';

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const FEED = arg('feed') || 'data/lineup-feed.json';

/* ── health invariants ──────────────────────────────────────────────────── */
// A core market missing ENTIRELY is the bug signature (the thin ParlayAPI
// response dropped every one of these). Any of them at zero → degraded.
const CORE_MARKETS = ['pass_yd', 'pass_td', 'rush_yd', 'rec_yd', 'rec'];
const MIN_MARKETS  = 8;                                    // distinct markets across the feed
const MIN_PROPS    = 120;                                  // players carrying ≥1 line
const MIN_BY_POS   = { QB: 12, RB: 20, WR: 30, TE: 12 };   // floors leave room for byes
const MAX_STALE_H  = 18;                                   // props_pp_generated liveness (regular season)

function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`FATAL: cannot read ${path}: ${e.message}`); process.exit(1); }
}

const feed = load(FEED);
const pp = feed.vegas_player_props || {};
const meta = feed.vegas_meta || {};
const regular = /^reg/i.test(feed.season_type || '');

// tally
const mkCount = {}, posCount = {};
for (const id in pp) {
  const p = pp[id];
  posCount[p.pos] = (posCount[p.pos] || 0) + 1;
  for (const k in (p.lines || {})) mkCount[k] = (mkCount[k] || 0) + 1;
}
const nProps = Object.keys(pp).length;
const markets = Object.keys(mkCount);
const ppGen = meta.props_pp_generated ? new Date(meta.props_pp_generated) : null;
const ageH = ppGen ? (Date.now() - ppGen.getTime()) / 3.6e6 : null;

/* ── evaluate ───────────────────────────────────────────────────────────── */
const fail = [];
for (const mk of CORE_MARKETS) if (!mkCount[mk]) fail.push(`core market "${mk}" absent`);
if (markets.length < MIN_MARKETS) fail.push(`only ${markets.length} distinct markets (need ≥${MIN_MARKETS})`);
if (nProps < MIN_PROPS) fail.push(`only ${nProps} props (need ≥${MIN_PROPS})`);
for (const pos in MIN_BY_POS) {
  const n = posCount[pos] || 0;
  if (n < MIN_BY_POS[pos]) fail.push(`${pos}: only ${n} players (need ≥${MIN_BY_POS[pos]})`);
}
if (ageH != null && ageH > MAX_STALE_H) fail.push(`enrichment ${ageH.toFixed(1)}h stale (max ${MAX_STALE_H}h)`);
else if (ageH == null) fail.push('no props_pp_generated timestamp (enrichment never ran)');

/* ── report ─────────────────────────────────────────────────────────────── */
const lines = [];
lines.push(`Feed: ${FEED}`);
lines.push(`Season: ${feed.season} week ${feed.week} (${feed.season_type})`);
lines.push(`Props: ${nProps} players · ${markets.length} markets · enrichment ${ageH != null ? ageH.toFixed(1) + 'h ago' : 'never'}`);
lines.push(`By position: ${['QB', 'RB', 'WR', 'TE'].map(p => `${p} ${posCount[p] || 0}`).join(' · ')}`);
lines.push(`Markets: ${markets.sort().join(', ') || '(none)'}`);

const healthy = fail.length === 0;
if (healthy) {
  lines.unshift('✅ PROP FEED HEALTHY');
} else if (!regular) {
  lines.unshift('ℹ️ off-season — thin/empty props are expected, not failing');
  lines.push('Would-be issues (informational): ' + fail.join('; '));
} else {
  lines.unshift('❌ PROP FEED DEGRADED');
  lines.push('Issues: ' + fail.join('; '));
}

const out = lines.join('\n');
console.log(out);
// mirror to the GitHub Actions job summary when running in CI
if (process.env.GITHUB_STEP_SUMMARY) {
  try { (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n'); } catch {}
}

// exit non-zero only when the regular season is actually broken
process.exit(healthy || !regular ? 0 : 1);
