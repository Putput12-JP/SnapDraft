/* prop-model.js  ────────────────────────────────────────────────────────────
   VAULT · VaultPropModel — Vault's OWN player-prop projection, client-side.

   Serves the model fit offline by scripts/build_prop_projections.py (params in
   data/prop_model.json) exactly the way edge-nfl's predict.js serves its trained
   calibrator: recency-weighted VOLUME × shrunk EFFICIENCY → a distribution →
   P(over line) → isotonic calibration. The result is a genuine `fairProb` Vault
   derived itself, which the Betting Edge Board can turn into an edge via
   VaultBettingMath.findEdge — instead of only de-vigging the book's own price.

   Player game logs are read through VaultPropHistory (same nflverse season files
   it already fetches), so this module adds no new network cost.

   Every getter returns null until the params file lands, so a cold cache or a
   missing market falls straight back to the existing Sleeper projection.
   ──────────────────────────────────────────────────────────────────────────── */
window.VaultPropModel = (function () {
  'use strict';

  const BASE = (typeof NFLVERSE_BASE !== 'undefined' && NFLVERSE_BASE)
    ? NFLVERSE_BASE
    : ((location.hostname.endsWith('github.io')) ? '' : '/data');
  const URL = `${BASE}/prop_model.json`;

  let _params = null;      // Promise<model|null>
  function params() {
    if (!_params) {
      _params = fetch(URL).then(r => (r.ok ? r.json() : null)).catch(() => null);
    }
    return _params;
  }

  const num = v => { const f = Number(v); return Number.isFinite(f) ? f : null; };

  // ── projection math (must mirror build_prop_projections.py) ───────────────
  function wmean(vals, halfLife) {
    const n = vals.length;
    if (!n) return [null, 0];
    let acc = 0, sw = 0;
    for (let i = 0; i < n; i++) {
      const age = (n - 1) - i;                 // 0 = most recent
      const w = Math.pow(0.5, age / halfLife);
      acc += w * vals[i]; sw += w;
    }
    return [sw ? acc / sw : null, sw];
  }
  // Empirical-Bayes shrink of the recency-weighted mean toward `prior`.
  function shrink(vals, prior, halfLife, k) {
    const [wm, sw] = wmean(vals, halfLife);
    if (wm == null) return prior;
    return (sw * wm + k * prior) / (sw + k);
  }

  // Chronological component series from a player's weeks (oldest → newest).
  function series(weeks, field) {
    const out = [];
    for (const w of weeks) { const v = num(w[field]); if (v != null) out.push(v); }
    return out;
  }
  // Per-game SUM of several fields (rush+rec TDs → anytime); a game counts if at
  // least one field is present, missing fields contribute 0.
  function sumSeries(weeks, fields) {
    const out = [];
    for (const w of weeks) {
      const vals = fields.map(f => num(w[f]));
      if (vals.every(v => v == null)) continue;
      out.push(vals.reduce((a, v) => a + (v || 0), 0));
    }
    return out;
  }

  // Point projection for one market from a player's ordered weeks. null if the
  // player has fewer than min_prior usable games (→ caller falls back).
  function projectFrom(weeks, m, minPrior) {
    // Direct recency-shrunk projection UNLESS the market declares usage fields
    // (vol + eff_num) — yards always, and rec_td (targets × TD-rate) opts in.
    if (!(m.vol && m.eff_num) && (m.kind === 'count' || m.kind === 'poisson')) {
      const s = m.stat_sum ? sumSeries(weeks, m.stat_sum) : series(weeks, m.stat);
      if (s.length < minPrior) return null;
      return shrink(s, m.prior[Object.keys(m.prior)[0]], m.half_life, m.k_vol);
    }
    // volume × efficiency, each shrunk to its own prior
    const vs = [], es = [];
    for (const w of weeks) {
      const vol = num(w[m.vol]), en = num(w[m.eff_num]);
      if (vol != null) vs.push(vol);
      if (vol && vol > 0 && en != null) es.push(en / vol);
    }
    if (vs.length < minPrior || es.length < minPrior) return null;
    const key = k => m.prior[k];
    const mkt = _marketKeyOf(m);
    const pv = shrink(vs, key(mkt + '|vol'), m.half_life, m.k_vol);
    const pe = shrink(es, key(mkt + '|eff'), m.half_life, m.k_eff);
    return pv * pe;
  }
  // recover the market key from a market's prior keys (e.g. "rec_yd|vol")
  function _marketKeyOf(m) {
    const k = Object.keys(m.prior)[0] || '';
    return k.includes('|') ? k.split('|')[0] : k;
  }

  // ── distribution → calibrated probability ─────────────────────────────────
  function sdAt(m, proj) { return Math.sqrt(Math.max(m.sd_v0 + m.sd_v1 * Math.max(proj, 0), 1e-6)); }

  function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  // Abramowitz-Stegun 7.1.26 erf approximation (max err ~1.5e-7).
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  function rawOver(proj, sd, line, count) {
    const L = count ? line - 0.5 : line;         // continuity correction for counts
    if (sd <= 0) return proj >= L ? 1 : 0;
    return 1 - normCdf((L - proj) / sd);
  }
  // #4 alt distributions (chosen per market at build time).
  function nbOver(mean, line, r) {                 // Negative Binomial P(X >= ceil(line))
    if (!(mean > 0) || !(r > 0)) return 0;
    const m = Math.ceil(line); if (m <= 0) return 1;
    const p = r / (r + mean); let term = Math.pow(p, r), cdf = term;
    for (let k = 1; k < m; k++) { term *= (k - 1 + r) / k * (1 - p); cdf += term; }
    return Math.max(0, 1 - Math.min(cdf, 1));
  }
  function lognormOver(proj, sd, line) {           // log-normal P(Y > line)
    if (proj <= 0) return 0;
    if (line <= 0) return 1;
    const s2 = Math.log(1 + (sd * sd) / (proj * proj));
    if (s2 <= 0) return proj > line ? 1 : 0;
    return 1 - normCdf((Math.log(line) - (Math.log(proj) - s2 / 2)) / Math.sqrt(s2));
  }
  // #3 market shrink: temperature scaling toward 0.5 (the pickem/market prior).
  // w<1 pulls an overconfident prob toward a coin-flip; w≈1 (yards) is a no-op.
  function shrinkProb(p, w) {
    if (!w || w === 1) return p;
    p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
    return 1 / (1 + Math.exp(-w * Math.log(p / (1 - p))));
  }
  // #3 market blend: pull the model's P(over) toward the vig-free market P(over),
  // weighted by w (published per market from the settlement loop's measured model-
  // vs-market log-loss). w>=1 or no market prob → pure model — the no-evidence
  // default (a no-op offseason), so only priced two-way rows in-season ever move.
  function blendToward(pModel, pMarket, w) {
    if (pModel == null) return pModel;
    const ww = (typeof w === 'number' && w >= 0 && w < 1) ? w : 1;
    if (ww >= 1 || pMarket == null) return pModel;
    const lg = p => { p = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(p / (1 - p)); };
    return clamp(1 / (1 + Math.exp(-(ww * lg(pModel) + (1 - ww) * lg(pMarket)))), 0.01, 0.99);
  }
  // Poisson tail: P(X >= ceil(line)) for a .5 line = 1 - P(X <= floor(line)).
  function poisOver(lam, line) {
    if (lam <= 0) return 0;
    const k = Math.floor(line);
    let term = Math.exp(-lam), acc = term;
    for (let i = 1; i <= k; i++) { term *= lam / i; acc += term; }
    return Math.max(0, 1 - Math.min(acc, 1));
  }

  // Piecewise-linear interpolation on the isotonic calibration points.
  function calibrate(calib, p) {
    if (!calib || !calib.length) return p;
    if (p <= calib[0][0]) return calib[0][1];
    if (p >= calib[calib.length - 1][0]) return calib[calib.length - 1][1];
    for (let i = 0; i < calib.length - 1; i++) {
      const [x0, y0] = calib[i], [x1, y1] = calib[i + 1];
      if (p >= x0 && p <= x1) {
        const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0);
        return y0 + t * (y1 - y0);
      }
    }
    return p;
  }

  // ── public: fair prob that a player goes OVER a line ──────────────────────
  // opts: { seasons:[y1,y2], oppMult, envMult }  (oppMult/envMult default 1,
  // applied to the projection; the Edge Board supplies them from DvP + Vegas).
  async function fairProbOver(name, marketKey, line, opts) {
    opts = opts || {};
    const P = await params(); if (!P || !P.markets || !P.markets[marketKey]) return null;
    if (typeof window.VaultPropHistory === 'undefined') return null;
    const m = P.markets[marketKey];
    const minPrior = (P.meta && P.meta.min_prior) || 3;

    // gather the player's weeks across the requested seasons, chronological
    const seasons = opts.seasons || [2024, 2025];
    const nkey = window.vaultNameKey || (window.VaultPropHistory._nkey) ||
                 (s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, ''));
    const key = nkey(name);
    let weeks = [];
    for (const s of seasons) {
      const idx = await window.VaultPropHistory.index(s);
      const p = idx && idx[key];
      if (p && p.weeks) weeks = weeks.concat(p.weeks.slice().sort((a, b) => (a.wk || 0) - (b.wk || 0)));
    }
    if (!weeks.length) return null;

    let proj = projectFrom(weeks, m, minPrior);
    if (proj == null) return null;
    proj *= (num(opts.oppMult) ?? 1) * (num(opts.envMult) ?? 1);

    // #4: the distribution is chosen per market at build time (m.dist). Fall back
    // to kind for pre-#4 model files.
    const dist = m.dist || (m.kind === 'poisson' ? 'poisson' : 'normal');
    const count = m.kind === 'count';
    const sd = dist === 'poisson' ? Math.sqrt(Math.max(proj, 0))
             : dist === 'nbinom' ? Math.sqrt(Math.max(proj, 0) + proj * proj / (m.nb_r || 1e6))
             : sdAt(m, proj);                          // info only
    const L = num(line);
    if (L == null) return { proj: round(proj, 2), sd: round(sd, 2), fairProb: null, over: null };
    const raw = dist === 'poisson' ? poisOver(proj, L)
              : dist === 'nbinom' ? nbOver(proj, L, m.nb_r)
              : dist === 'lognormal' ? lognormOver(proj, sd, L)
              : rawOver(proj, sd, L, count);
    const cal0 = clamp(shrinkProb(clamp(calibrate(m.calib, raw), 0.01, 0.99), m.shrink), 0.01, 0.99);
    const cal = blendToward(cal0, num(opts.marketProbOver), m.blend_w);   // #3: toward the vig-free market where measured
    return { proj: round(proj, 2), sd: round(sd, 2), over: round(cal, 4), under: round(1 - cal, 4),
             fairProb: round(cal, 4), raw: round(raw, 4), n: m.n, r2: m.r2, games: weeks.length };
  }

  // just the point projection (for the Model Lean "Vault" number), no line
  async function projectStat(name, marketKey, opts) {
    const r = await fairProbOver(name, marketKey, null, opts);
    return r ? r.proj : null;
  }

  const round = (x, n) => { const f = 10 ** n; return Math.round(x * f) / f; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function has(marketKey) { return params().then(P => !!(P && P.markets && P.markets[marketKey])); }

  return { params, fairProbOver, projectStat, has, BASE };
})();
