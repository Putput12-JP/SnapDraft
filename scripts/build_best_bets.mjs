#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · BEST BETS  →  data/lineup-feed.json (best_bets)
   ────────────────────────────────────────────────────────────────────────
   Precomputes Vault's top prop picks of the slate so the Betting tab can show
   a "Best Bets" hero without every client re-scoring the whole board.

   It scores EVERY prop in the feed with the SAME model + gates the UI uses, so
   the list is honest — not "top 3 by raw EV", which would surface exactly the
   junk the board already guards against:

     • the LOG-BASED projection (mirrors prop-model.js fairProbOver): recency-
       weighted volume × efficiency → per-market distribution → P(over) →
       isotonic calibration → market shrink. Reads the same
       data/nflverse_stats_<season>.json game logs prop-history.js uses.
     • only the 9 MODELED markets (prop_model.json) — the ones with measured
       signal; nothing else is scored.
     • CORROBORATION gate: a line needs ≥2 books agreeing within tolerance.
       A lone-book line (the phantom-edge trap) is never a best bet.
     • CONFIDENCE shrink: the favored-side probability is pulled toward a coin
       flip on thin samples (vaultGrade padj), so a 3-game hot streak can't
       masquerade as a lock.
     • ranked by CONFIDENCE-ADJUSTED EV vs the best available price (line-first,
       so flat DFS pricing can't win a cell on price alone).

   Game "leans" (spreads/totals) come from data/game_model.json — but that
   model MATCHES the market without beating it, so they ship as clearly-labeled
   CONTEXT, never as edge, and are empty while the model is in its offseason
   gate (the same gate the game-line UI honors).

   Writes feed.best_bets = { generated, season, week, be_ref, props:[…],
   game_leans:[…], note }. Run AFTER the props fetch so it scores fresh lines.

   Run:  node scripts/build_best_bets.mjs                 # score, write feed
         node scripts/build_best_bets.mjs --dry           # score, print, no write
         node scripts/build_best_bets.mjs --top=3         # how many props (default 3)
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ARG = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DRY   = !!ARG.dry;
const TOP   = Number(ARG.top || 4);
const LEANS = Number(ARG.leans || 3);
const FEED  = ARG.feed || resolve(ROOT, 'data/lineup-feed.json');
const SEASONS = [2024, 2025];                 // log window (mirror prop-model.js default)
const BE_REF = 0.524;                         // standard -110 book break-even (entry-agnostic bar)
const MIN_GAMES = 8;                          // enough log to trust the projection
const PRICE_MIN = -250, PRICE_MAX = 200;      // bettable band: no -300 chalk, no lottery longshots
const log = (...a) => console.log('[best-bets]', ...a);

/* ── data-key helpers (mirror the app) ─────────────────────────────────── */
const nkey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const num = v => { const f = Number(v); return Number.isFinite(f) ? f : null; };
const round = (x, n) => { const f = 10 ** n; return Math.round(x * f) / f; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* ── nflverse game logs → per-player weeks (mirror prop-history.js) ─────── */
const _idx = {};   // season → { nameKey → entry }
function seasonIndex(season) {
  if (season in _idx) return _idx[season];
  const p = resolve(ROOT, `data/nflverse_stats_${season}.json`);
  if (!existsSync(p)) { _idx[season] = null; return null; }
  const data = JSON.parse(readFileSync(p, 'utf8'));
  const idx = {};
  for (const nm in data) {
    const k = nkey(nm), e = data[nm];
    if (!idx[k] || (e.weeks?.length || 0) > (idx[k].weeks?.length || 0)) idx[k] = e;
  }
  _idx[season] = idx;
  return idx;
}
function weeksFor(name) {
  const key = nkey(name); let weeks = [];
  for (const s of SEASONS) {
    const idx = seasonIndex(s);
    const p = idx && idx[key];
    if (p && p.weeks) weeks = weeks.concat(p.weeks.slice().sort((a, b) => (a.wk || 0) - (b.wk || 0)));
  }
  return weeks;
}

/* ── projection + probability (mirror prop-model.js exactly) ───────────── */
function wmean(vals, halfLife) {
  const n = vals.length; if (!n) return [null, 0];
  let acc = 0, sw = 0;
  for (let i = 0; i < n; i++) { const w = Math.pow(0.5, ((n - 1) - i) / halfLife); acc += w * vals[i]; sw += w; }
  return [sw ? acc / sw : null, sw];
}
function shrink(vals, prior, halfLife, k) {
  const [wm, sw] = wmean(vals, halfLife); if (wm == null) return prior;
  return (sw * wm + k * prior) / (sw + k);
}
function series(weeks, field) { const o = []; for (const w of weeks) { const v = num(w[field]); if (v != null) o.push(v); } return o; }
function sumSeries(weeks, fields) {
  const o = [];
  for (const w of weeks) { const vals = fields.map(f => num(w[f])); if (vals.every(v => v == null)) continue; o.push(vals.reduce((a, v) => a + (v || 0), 0)); }
  return o;
}
function marketKeyOf(m) { const k = Object.keys(m.prior)[0] || ''; return k.includes('|') ? k.split('|')[0] : k; }
function projectFrom(weeks, m, minPrior) {
  if (m.kind === 'count' || m.kind === 'poisson') {
    const s = m.stat_sum ? sumSeries(weeks, m.stat_sum) : series(weeks, m.stat);
    if (s.length < minPrior) return null;
    return shrink(s, m.prior[Object.keys(m.prior)[0]], m.half_life, m.k_vol);
  }
  const vs = [], es = [];
  for (const w of weeks) { const vol = num(w[m.vol]), en = num(w[m.eff_num]); if (vol != null) vs.push(vol); if (vol && vol > 0 && en != null) es.push(en / vol); }
  if (vs.length < minPrior || es.length < minPrior) return null;
  const mkt = marketKeyOf(m);
  return shrink(vs, m.prior[mkt + '|vol'], m.half_life, m.k_vol) * shrink(es, m.prior[mkt + '|eff'], m.half_life, m.k_eff);
}
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
const sdAt = (m, proj) => Math.sqrt(Math.max(m.sd_v0 + m.sd_v1 * Math.max(proj, 0), 1e-6));
function rawOver(proj, sd, line, count) { const L = count ? line - 0.5 : line; if (sd <= 0) return proj >= L ? 1 : 0; return 1 - normCdf((L - proj) / sd); }
function nbOver(mean, line, r) { if (!(mean > 0) || !(r > 0)) return 0; const m = Math.ceil(line); if (m <= 0) return 1; const p = r / (r + mean); let term = Math.pow(p, r), cdf = term; for (let k = 1; k < m; k++) { term *= (k - 1 + r) / k * (1 - p); cdf += term; } return Math.max(0, 1 - Math.min(cdf, 1)); }
function lognormOver(proj, sd, line) { if (proj <= 0) return 0; if (line <= 0) return 1; const s2 = Math.log(1 + (sd * sd) / (proj * proj)); if (s2 <= 0) return proj > line ? 1 : 0; return 1 - normCdf((Math.log(line) - (Math.log(proj) - s2 / 2)) / Math.sqrt(s2)); }
function poisOver(lam, line) { if (lam <= 0) return 0; const k = Math.floor(line); let term = Math.exp(-lam), acc = term; for (let i = 1; i <= k; i++) { term *= lam / i; acc += term; } return Math.max(0, 1 - Math.min(acc, 1)); }
function shrinkProb(p, w) { if (!w || w === 1) return p; p = clamp(p, 1e-6, 1 - 1e-6); return 1 / (1 + Math.exp(-w * Math.log(p / (1 - p)))); }
function calibrate(calib, p) {
  if (!calib || !calib.length) return p;
  if (p <= calib[0][0]) return calib[0][1];
  if (p >= calib[calib.length - 1][0]) return calib[calib.length - 1][1];
  for (let i = 0; i < calib.length - 1; i++) { const [x0, y0] = calib[i], [x1, y1] = calib[i + 1]; if (p >= x0 && p <= x1) { const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0); return y0 + t * (y1 - y0); } }
  return p;
}
function fairProbOver(PM, name, marketKey, line) {
  const m = PM.markets[marketKey]; if (!m) return null;
  const minPrior = (PM.meta && PM.meta.min_prior) || 3;
  const weeks = weeksFor(name); if (!weeks.length) return null;
  const proj = projectFrom(weeks, m, minPrior); if (proj == null) return null;
  const dist = m.dist || (m.kind === 'poisson' ? 'poisson' : 'normal');
  const count = m.kind === 'count';
  const sd = dist === 'poisson' ? Math.sqrt(Math.max(proj, 0))
           : dist === 'nbinom' ? Math.sqrt(Math.max(proj, 0) + proj * proj / (m.nb_r || 1e6))
           : sdAt(m, proj);
  const L = num(line); if (L == null) return null;
  const raw = dist === 'poisson' ? poisOver(proj, L)
            : dist === 'nbinom' ? nbOver(proj, L, m.nb_r)
            : dist === 'lognormal' ? lognormOver(proj, sd, L)
            : rawOver(proj, sd, L, count);
  const cal = clamp(shrinkProb(clamp(calibrate(m.calib, raw), 0.01, 0.99), m.shrink), 0.01, 0.99);
  return { proj: round(proj, 2), over: round(cal, 4), under: round(1 - cal, 4), games: weeks.length };
}

/* ── grade / trust / pricing (mirror index.html) ───────────────────────── */
function vaultGrade(over, under, n) {
  if (over == null || under == null) return null;
  const p = Math.max(over, under), side = over >= under ? 'over' : 'under';
  const K = 6, g = n || 0, padj = 0.5 + (p - 0.5) * (g / (g + K));
  return { side, p, padj, n: g };
}
const gradeLetter = (padj, be) => { const mrg = padj - be; return mrg >= 0.05 ? 'A' : mrg >= 0.03 ? 'B' : mrg >= 0.01 ? 'C' : mrg >= -0.02 ? 'D' : 'F'; };
function lineTrust(quotes, line) {
  const seen = new Map();
  for (const q of (quotes || [])) if (q && q.book && q.line != null && !seen.has(q.book)) seen.set(q.book, q.line);
  const books = seen.size; if (books < 2) return { books, corrob: false };
  const lines = [...seen.values()]; const spread = Math.max(...lines) - Math.min(...lines);
  const tol = Math.max(1.5, 0.06 * Math.abs(line || 0));
  return { books, corrob: spread <= tol, spread };
}
function bestSide(quotes, side) {
  const better = side === 'over' ? (a, b) => a < b : (a, b) => a > b;
  return quotes.reduce((best, q) => {
    if (q[side] == null) return best;
    const cand = { book: q.book, price: q[side], line: q.line ?? null };
    if (!best) return cand;
    if (cand.line != null && best.line != null && cand.line !== best.line) return better(cand.line, best.line) ? cand : best;
    return cand.price > best.price ? cand : best;
  }, null);
}
const americanToProb = p => p == null ? null : (p < 0 ? (-p) / (-p + 100) : 100 / (p + 100));
// EV per $1 for a win probability at an American price (payout side only).
function evPerDollar(winProb, american) {
  if (winProb == null || american == null) return null;
  const payout = american > 0 ? american / 100 : 100 / (-american);
  return round(winProb * payout - (1 - winProb), 4);
}

const MKT_LABEL = {
  pass_yd: 'Pass Yds', pass_att: 'Pass Att', pass_cmp: 'Completions', pass_td: 'Pass TD',
  rush_yd: 'Rush Yds', rush_att: 'Rush Att', rec: 'Receptions', rec_yd: 'Rec Yds', rec_td: 'Rec TD',
};

/* ── score every prop ──────────────────────────────────────────────────── */
function scoreProps(feed, PM) {
  const props = feed.vegas_player_props || {};
  const cands = [];
  let scored = 0, gated = 0, preskip = 0;
  // Preseason gate (mirror the board's propRows): exhibition-game props price a
  // starter's cameo or a backup's heavy workload, so they're apples-to-oranges
  // with a regular-season projection. In preseason keep only real regular-season
  // lines (kickoff on/after Sep 1); in-season this drops nothing.
  const isPre = /^pre/i.test(feed.season_type || '');
  const yr = Number(feed.season) || new Date().getUTCFullYear();
  const regCutoff = Date.UTC(yr, 8, 1);   // Sep 1
  // Starter gate: a backup who won't see the field is never a best bet, however
  // good his historical projection looks (a QB2's pass line, a 4th RB's carries).
  // depth_chart_order 1 = starter; the per-position ceiling keeps genuine
  // committee/rotation players (RB2, WR3) while cutting deep backups.
  const depth = feed.vegas_depth || {};
  const DEPTH_MAX = { QB: 1, RB: 2, WR: 3, TE: 2 };
  let benchskip = 0;
  for (const id in props) {
    const p = props[id];
    if (isPre && p.commence) { const t = new Date(p.commence).getTime(); if (Number.isFinite(t) && t < regCutoff) { preskip++; continue; } }
    const dep = depth[id];   // [depth_chart_order, active]
    if (dep) {
      if (dep[1] === 0) { benchskip++; continue; }                                 // inactive / out
      const cap = DEPTH_MAX[p.pos];
      if (cap != null && dep[0] != null && dep[0] > cap) { benchskip++; continue; } // buried on the depth chart
    }
    for (const mk in (p.lines || {})) {
      if (!PM.markets[mk]) continue;                       // modeled markets only
      const cell = p.lines[mk];
      const quotes = (cell.quotes || []).filter(q => q && q.line != null);
      if (quotes.length < 2) continue;                     // need corroboration to even consider
      const line = num(cell.line); if (line == null) continue;
      const v = fairProbOver(PM, p.name, mk, line);
      if (!v || v.games < MIN_GAMES) continue;
      scored++;
      const g = vaultGrade(v.over, v.under, v.games);
      const side = g.side;
      const sideProb = side === 'under' ? v.under : v.over;
      const bs = bestSide(quotes, side);
      if (!bs || bs.price == null) continue;
      const trust = lineTrust(quotes, line);
      // honest gates: corroborated line, confidence clears the bar, real +EV
      const ev = evPerDollar(g.padj, bs.price);            // confidence-adjusted EV vs best price
      const letter = gradeLetter(g.padj, BE_REF);
      const bettable = bs.price >= PRICE_MIN && bs.price <= PRICE_MAX;   // no chalk, no lottery tickets
      const pass = trust.corrob && (letter === 'A' || letter === 'B') && ev != null && ev > 0 && bettable;
      if (!pass) { gated++; continue; }
      cands.push({
        id, name: p.name, team: p.team || null, pos: p.pos || null, opp: p.opp || null,
        market: mk, marketLabel: MKT_LABEL[mk] || mk, line, side,
        book: bs.book, price: bs.price,
        ev: round(ev * 100, 1),                            // % EV per $1 at best price
        proj: v.proj, prob: round(g.padj, 3), rawProb: round(sideProb, 3),
        grade: letter, books: trust.books, games: v.games,
      });
    }
  }
  // Rank by confidence-adjusted EV — the real value. The price band (above)
  // already strips both -300 chalk (trivial certainties) and lottery longshots
  // (the plus-money tickets that leaned on the model's overfit TD tail), so
  // what's left is genuine value on bettable lines. Confidence breaks ties.
  cands.sort((a, b) => b.ev - a.ev || b.prob - a.prob);
  // One bet per player in the headline list — a "top 3" should be three names,
  // not one player's whole card. (Full ranked pool is still counted.)
  const seenPlayer = new Set(), list = [];
  for (const c of cands) { if (seenPlayer.has(c.id)) continue; seenPlayer.add(c.id); list.push(c); if (list.length >= TOP) break; }
  return { list, scored, gated, preskip, benchskip, total: cands.length };
}

/* ── game leans (CONTEXT only; empty while the model is gated) ──────────── */
function gameLeans(feed) {
  let gm = null;
  try { gm = JSON.parse(readFileSync(resolve(ROOT, 'data/game_model.json'), 'utf8')); } catch (e) { return { list: [], gated: 'no-model' }; }
  // The game model matches but does not beat the market, and gates itself off
  // in the offseason — honor that. Leans light up in-season.
  if (gm.offseason) return { list: [], gated: 'offseason' };
  const teams = gm.teams || {}, hfa = num(gm.hfa) || 0, base = num(gm.base_pts) || 22.5;
  const out = [];
  for (const g of (feed.vegas_games || [])) {
    const H = teams[g.home], A = teams[g.away]; if (!H || !A) continue;
    const projMargin = (num(H.rate) - num(A.rate)) + hfa;            // home minus away
    const projTotal = 2 * base + num(H.off) + num(A.off) + num(H.def) + num(A.def);
    const mktSpreadHome = g.spread && g.spread.cons ? num(g.spread.cons.home) : null;   // home line (neg = favored)
    const mktTotal = g.total ? num(g.total.cons) : null;
    // spread lean: model's home margin vs the market's implied home margin (−spread)
    if (mktSpreadHome != null) {
      const edge = projMargin - (-mktSpreadHome);
      if (Math.abs(edge) >= 1.0) out.push({ type: 'spread', game: `${g.away} @ ${g.home}`, side: edge > 0 ? g.home : g.away, lean: round(Math.abs(edge), 1), market_line: mktSpreadHome, model_margin: round(projMargin, 1), commence: g.commence || null });
    }
    if (mktTotal != null) {
      const edge = projTotal - mktTotal;
      if (Math.abs(edge) >= 1.5) out.push({ type: 'total', game: `${g.away} @ ${g.home}`, side: edge > 0 ? 'Over' : 'Under', lean: round(Math.abs(edge), 1), market_line: mktTotal, model_total: round(projTotal, 1), commence: g.commence || null });
    }
  }
  out.sort((a, b) => b.lean - a.lean);
  return { list: out.slice(0, LEANS), gated: null };
}

/* ── main ──────────────────────────────────────────────────────────────── */
(async () => {
  try {
    if (!existsSync(FEED)) { log('feed not found:', FEED); process.exit(0); }
    const feed = JSON.parse(readFileSync(FEED, 'utf8'));
    const PM = JSON.parse(readFileSync(resolve(ROOT, 'data/prop_model.json'), 'utf8'));
    if (!PM.markets) { log('prop_model.json has no markets — skipping'); process.exit(0); }

    const props = scoreProps(feed, PM);
    const leans = gameLeans(feed);
    log(`props: ${props.total} qualified of ${props.scored} scored (${props.gated} gated, ${props.benchskip} benched) → top ${props.list.length}`);
    log(`game leans: ${leans.gated ? leans.gated : props.total >= 0 ? leans.list.length : 0}${leans.gated ? ' (empty)' : ''}`);
    for (const b of props.list) log(`  • ${b.name} ${b.marketLabel} ${b.side.toUpperCase()} ${b.line} @ ${b.book} ${b.price > 0 ? '+' : ''}${b.price} — ${b.grade}, ${b.ev}% EV, ${b.books} books, ${b.games}g`);

    feed.best_bets = {
      generated: new Date().toISOString(),
      season: feed.season || null, week: feed.week || null,
      be_ref: BE_REF,
      props: props.list,
      game_leans: leans.list,
      game_leans_note: leans.gated === 'offseason'
        ? 'Game leans light up in-season — the game model is context, not an edge, and is gated off in the offseason.'
        : 'Game leans are model context, not an edge — the game model matches the market without beating it.',
      note: 'Top props by confidence-adjusted EV on corroborated lines (≥2 books), modeled markets only.',
    };
    if (DRY) { log('DRY — not writing'); return; }
    writeFileSync(FEED, JSON.stringify(feed));
    log('wrote best_bets to', FEED);
  } catch (e) {
    log('ERROR:', e.message);
    process.exit(0);   // never fail the workflow
  }
})();
