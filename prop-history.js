/* prop-history.js  ────────────────────────────────────────────────────────────
   VAULT · VaultPropHistory — per-player game logs + hit-rates for the Betting
   tab's Edge Board detail (the game-log bar chart and the L5/L10/L20/SZN
   heatmap). Reads the weekly actuals the data pipeline already ships in
   data/nflverse_stats_<season>.json (keyed by player name, each with a
   `weeks[]` array of per-game stats), joins a prop to it by normalized name,
   and counts how often the player cleared a given line.

   Real data only: if a player has no weekly logs, every getter returns null and
   the caller shows the panel's empty state — nothing is invented.

   Known gap: the weekly rows carry `wk` but no opponent, so there is no H2H
   split and bars are labelled by week, not by opponent, until a schedule join
   is added. See docs / the Betting redesign notes.
   ──────────────────────────────────────────────────────────────────────────── */
window.VaultPropHistory = (function () {
  'use strict';

  // Mirror the app's data host resolution (github.io in prod, /data locally).
  const BASE = (typeof NFLVERSE_BASE !== 'undefined' && NFLVERSE_BASE)
    ? NFLVERSE_BASE
    : ((typeof window !== 'undefined' && /github\.io|putput12-jp/i.test(window.location?.hostname || ''))
        ? 'https://putput12-jp.github.io/Vault-Fantasy/data' : '/data');

  // Vault market key → nflverse weekly field. Only counting-stat markets have a
  // per-game actual; "longest" and prob markets (anytime_td) are handled apart.
  const FIELD = {
    pass_yd: 'pyds', pass_td: 'ptds', pass_int: 'ints', pass_cmp: 'cmp', pass_att: 'att',
    rush_yd: 'ryds', rush_td: 'rtds', rush_att: 'car',
    rec_yd: 'recyds', rec: 'rec', rec_td: 'rectds',
  };

  const nkey = s => (typeof window !== 'undefined' && typeof window.vaultNameKey === 'function')
    ? window.vaultNameKey(s)
    : String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

  const _file = {};   // season → Promise<statsJson|null>
  const _index = {};  // season → { nameKey → playerEntry } | null

  function load(season) {
    if (!_file[season]) {
      _file[season] = fetch(`${BASE}/nflverse_stats_${season}.json`)
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
    }
    return _file[season];
  }

  // Name-keyed index for one season, memoized. Duplicate names keep the entry
  // with more games (avoids a practice-squad collision shadowing the starter).
  async function index(season) {
    if (season in _index) return _index[season];
    const data = await load(season);
    if (!data) { _index[season] = null; return null; }
    const idx = {};
    for (const nm in data) {
      const k = nkey(nm), e = data[nm];
      if (!idx[k] || (e.weeks?.length || 0) > (idx[k].weeks?.length || 0)) idx[k] = e;
    }
    _index[season] = idx;
    return idx;
  }

  // Chronological game log for a player+market across seasons (oldest → newest).
  // Returns [{ season, wk, val }], or null if the market has no per-game field.
  async function gameLog(name, marketKey, opts) {
    opts = opts || {};
    const field = FIELD[marketKey];
    if (!field) return null;
    const seasons = opts.seasons || [2024, 2025]; // chronological; newest last
    const key = nkey(name);
    const out = [];
    for (const s of seasons) {
      const idx = await index(s);
      const p = idx && idx[key];
      if (!p || !p.weeks) continue;
      for (const w of p.weeks) if (w[field] != null) out.push({ season: s, wk: w.wk, val: w[field] });
    }
    return out;
  }

  // Hit-rate buckets vs a line for a side. over = actual >= line (push counts as
  // a clear on the over, matching how books grade a whole-number-adjacent line;
  // fine for the .5 lines props actually use). SZN = the most recent season only.
  function hitRates(gl, line, side) {
    if (!gl || !gl.length) return { L5: null, L10: null, L20: null, SZN: null };
    const over = side !== 'under';
    const pct = arr => arr.length ? Math.round(arr.filter(g => over ? g.val >= line : g.val < line).length / arr.length * 100) : null;
    const last = n => gl.slice(-n);
    const latest = gl[gl.length - 1].season;
    return {
      L5: pct(last(5)), L10: pct(last(10)), L20: pct(last(20)),
      SZN: pct(gl.filter(g => g.season === latest)),
    };
  }

  // One call for the featured card: game log (last `limit`) + the heatmap.
  async function forProp(name, marketKey, line, side, opts) {
    opts = opts || {};
    const glAll = await gameLog(name, marketKey, opts);
    if (!glAll || !glAll.length) return null;
    const gl = opts.limit ? glAll.slice(-opts.limit) : glAll;
    return { gl, glAll, heat: hitRates(glAll, Number(line), side), field: FIELD[marketKey], line: Number(line), side };
  }

  return { load, index, gameLog, hitRates, forProp, FIELD, BASE, _nkey: nkey };
})();
