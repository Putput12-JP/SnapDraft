/* ════════════════════════════════════════════════════════════════════════
   VAULT · BETTING — client data layer  (v2: odds prices + book attribution)
   ────────────────────────────────────────────────────────────────────────
   One source of truth for the Betting tab. Loads the cron feed and normalizes
   GAME markets + PLAYER props into filterable models, each line carrying its
   price (American odds) and the book it came from.

   Line cell shape (everything normalizes to this):
     { line, over, under, book, modeled }
       • over / under  = American odds price (e.g. -110, +120)
       • book          = sportsbook the rep line is from (e.g. 'DraftKings')
       • modeled       = true when we synthesized odds (no live market yet)
     anytime_td cells carry { prob, over, book, modeled } (no line).

   Sources (priority, all graceful):
     1. FEED  deploy/data/lineup-feed.json
          vegas_games          per-game spread/total/ML + price + book
          vegas_player_props   per-player weekly props + price + book
          vegas_players        season-long stat lines (enriched name/team/pos)
          vegas_teams          implied team totals
     2. SEED  deploy/scripts/vegas-preseason.json  (workbook season lines)
     3. SLEEPER players map (cached) — fills id/team/pos/headshot when missing

   Off-season has no live odds, so:
     • GAME markets — if no vegas_games, we synthesize a SAMPLE slate by pairing
       teams; spread+total are math-consistent with the real implied totals,
       odds are standard placeholders, book rotates. Flagged sample:true.
     • PLAYER props — weekly lines projected from season totals (÷ games),
       odds modeled at -110. Flagged modeled/derived. Real book lines replace
       them automatically once a props feed is on.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const DEFAULTS = {
    feedUrl: 'data/lineup-feed.json',
    seedUrl: 'scripts/vegas-preseason.json',
    sleeperUrl: 'https://api.sleeper.app/v1/players/nfl',
    gamesPerSeason: 17,
    // ParlayAPI's live NFL book set (from the access probe) — order = column order.
    sampleBooks: ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'Pinnacle', 'BetRivers', 'Bovada', 'Hard Rock', 'Parx', 'ProphetX'],
  };

  const MARKETS = [
    { key: 'pass_yd', label: 'Pass Yds', short: 'PaYd', pos: ['QB'], kind: 'yd' },
    { key: 'pass_td', label: 'Pass TD', short: 'PaTD', pos: ['QB'], kind: 'td' },
    { key: 'rush_yd', label: 'Rush Yds', short: 'RuYd', pos: ['QB', 'RB'], kind: 'yd' },
    { key: 'rush_td', label: 'Rush TD', short: 'RuTD', pos: ['QB', 'RB'], kind: 'td' },
    { key: 'rec', label: 'Receptions', short: 'Rec', pos: ['RB', 'WR', 'TE'], kind: 'cnt' },
    { key: 'rec_yd', label: 'Rec Yds', short: 'ReYd', pos: ['RB', 'WR', 'TE'], kind: 'yd' },
    { key: 'rec_td', label: 'Rec TD', short: 'ReTD', pos: ['WR', 'TE', 'RB'], kind: 'td' },
    { key: 'anytime_td', label: 'Anytime TD', short: 'ATD', pos: ['QB', 'RB', 'WR', 'TE'], kind: 'prob' },
  ];
  const MARKET_BY_KEY = Object.fromEntries(MARKETS.map(m => [m.key, m]));

  const TEAMNAME = { ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs', LV: 'Raiders', LAC: 'Chargers', LAR: 'Rams', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SF: '49ers', SEA: 'Seahawks', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders' };

  const round = (n, d = 2) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };
  const half = n => Math.round(n * 2) / 2;
  const normName = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');
  const headshotFor = id => id ? 'https://sleepercdn.com/content/nfl/players/thumb/' + id + '.jpg' : '';
  const americanFromProb = p => p == null ? null : (p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round((1 - p) / p * 100));

  /* deterministic pseudo-random from a string seed (stable across renders) */
  function rng(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /* synthesize a believable multi-book quote set around a line (off-season demo) */
  function synthQuotes(line, kind, seed, books) {
    const r = rng(seed || ('s' + line));
    return books.map(book => {
      if (kind === 'prob') {
        const price = -Math.round(100 + r() * 80);              // -100..-180 vig
        return { book, line: null, over: price, under: null, prob: line };
      }
      const jLine = r() < 0.25 ? line + (r() < 0.5 ? -0.5 : 0.5) : line;   // some books shade the line
      const over = -Math.round(102 + r() * 36) + (r() < 0.18 ? 22 : 0);     // mostly -102..-138, occasional plus
      const under = -Math.round(102 + r() * 36) + (r() < 0.18 ? 22 : 0);
      return { book, line: round(jLine, 1), over, under, prob: null };
    });
  }
  function bestOf(quotes, side) {
    return quotes.reduce((b, q) => (q[side] != null && (!b || q[side] > b.price)) ? { book: q.book, price: q[side] } : b, null);
  }

  async function getJSON(url) {
    try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); }
    catch (e) { return null; }
  }

  /* ── format helpers (UI-facing) ───────────────────────────────────────── */
  const fmtOdds = p => p == null ? '—' : (p > 0 ? '+' + p : '' + p);
  const fmtLine = (cell, kind) => {
    if (cell == null) return '—';
    if (kind === 'prob') return cell.prob != null ? Math.round(cell.prob * 100) + '%' : '—';
    return cell.line != null ? String(cell.line) : '—';
  };

  /* ── Sleeper identity map ──────────────────────────────────────────────── */
  const SLEEPER_LS = 'vault_sleeper_namemap_v2';
  async function loadSleeperMap(url) {
    try { const c = localStorage.getItem(SLEEPER_LS); if (c) return JSON.parse(c); } catch (e) {}
    const all = await getJSON(url); if (!all) return {};
    const map = {};
    for (const id in all) {
      const p = all[id]; if (!p || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
      const nm = p.full_name || ((p.first_name || '') + ' ' + (p.last_name || ''));
      const key = normName(nm);
      if (key && !map[key]) map[key] = { id, team: (p.team || '').toUpperCase() || null, pos: p.position };
    }
    try { localStorage.setItem(SLEEPER_LS, JSON.stringify(map)); } catch (e) {}
    return map;
  }

  function slotFromCommence(iso) {
    if (!iso) return null;
    const d = new Date(iso); if (isNaN(d)) return null;
    const day = d.getUTCDay(), hourET = (d.getUTCHours() + 20) % 24;
    if (day === 4) return 'TNF';
    if (day === 1) return 'MNF';
    if (day === 0 && hourET >= 19) return 'SNF';
    if (day === 0) return 'SUN';
    return 'OTHER';
  }

  /* ── normalize a feed prop-line value into a cell ─────────────────────── */
  function cellFromFeed(v, kind) {
    if (v == null) return null;
    if (typeof v === 'number') {  // legacy: bare number → modeled odds
      return kind === 'prob' ? { prob: v, over: americanFromProb(v), book: 'model', modeled: true }
                             : { line: v, over: -110, under: -110, book: 'model', modeled: true };
    }
    // object from cron (real prices + book + per-book quotes)
    if (kind === 'prob') return { prob: v.prob ?? null, over: v.over ?? null, book: v.book || null, quotes: v.quotes || null, best: v.best || null, modeled: false };
    return { line: v.line ?? null, over: v.over ?? null, under: v.under ?? null, book: v.book || null, quotes: v.quotes || null, best: v.best || null, modeled: false };
  }
  function modeledCell(line, kind) {
    if (line == null) return null;
    return kind === 'prob' ? { prob: line, over: americanFromProb(line), book: 'model', modeled: true }
                           : { line, over: -110, under: -110, book: 'model', modeled: true };
  }

  /* ── main loader ──────────────────────────────────────────────────────── */
  async function load(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const feed = await getJSON(cfg.feedUrl);
    const hasFeedPlayers = feed && feed.vegas_players && Object.keys(feed.vegas_players).length;
    const hasFeedProps = feed && feed.vegas_player_props && Object.keys(feed.vegas_player_props).length;
    const hasFeedGames = feed && feed.vegas_games && feed.vegas_games.length;

    // ── season source ────────────────────────────────────────────────────
    let seasonById = {};
    let needSleeper = false;
    if (hasFeedPlayers) {
      for (const id in feed.vegas_players) {
        const p = feed.vegas_players[id];
        seasonById[id] = { ident: { name: p.name, team: p.team, pos: p.pos, rank: p.rank }, stats: p.season };
        if (!p.team) needSleeper = true;
      }
    } else {
      const seed = await getJSON(cfg.seedUrl);
      if (seed && seed.players) {
        needSleeper = true;
        for (const p of seed.players) seasonById['name:' + normName(p.name)] = { ident: { name: p.name, pos: p.pos, rank: p.rank }, stats: p.stats };
      }
    }
    let smap = {};
    if (needSleeper) smap = await loadSleeperMap(cfg.sleeperUrl);
    const resolveId = (key, ident) => {
      if (!key.startsWith('name:')) return key;
      const hit = smap[normName(ident.name)];
      if (hit) { ident.team = ident.team || hit.team; ident.pos = ident.pos || hit.pos; return hit.id; }
      return null;
    };

    // ── weekly props (live) ──────────────────────────────────────────────
    const weeklyById = {};
    if (hasFeedProps) {
      for (const id in feed.vegas_player_props) {
        const w = feed.vegas_player_props[id];
        const lines = {};
        for (const mk in (w.lines || {})) { const m = MARKET_BY_KEY[mk]; if (m) lines[mk] = cellFromFeed(w.lines[mk], m.kind); }
        weeklyById[id] = { lines, opp: w.opp || null, ha: w.ha || null, event: w.event || null, commence: w.commence || null, slot: slotFromCommence(w.commence), derived: false };
      }
    }

    // ── assemble players ─────────────────────────────────────────────────
    const players = [];
    for (const key in seasonById) {
      const { ident, stats } = seasonById[key];
      const id = resolveId(key, ident);
      // season cells (workbook lines → modeled odds)
      let season = null;
      if (stats) { season = { lines: {} }; for (const mk in stats) { const m = MARKET_BY_KEY[mk]; if (m) season.lines[mk] = modeledCell(stats[mk], m.kind); } }
      // weekly: live if present, else projected from season
      let weekly = id ? weeklyById[id] : null;
      if (!weekly && stats) {
        const lines = {};
        for (const m of MARKETS) {
          if (m.key === 'anytime_td') continue;
          if (stats[m.key] != null) lines[m.key] = modeledCell(round(stats[m.key] / cfg.gamesPerSeason, 1), m.kind);
        }
        if (Object.keys(lines).length) weekly = { lines, opp: null, ha: null, event: null, commence: null, slot: null, derived: true };
      }
      players.push({
        id: id || null, name: ident.name, team: ident.team || null,
        teamName: ident.team ? TEAMNAME[ident.team] : null, pos: ident.pos || null,
        rank: ident.rank ?? null, headshot: headshotFor(id), season, weekly,
      });
    }

    // ── team totals ──────────────────────────────────────────────────────
    const teams = [];
    const vt = (feed && feed.vegas_teams) || {};
    for (const code in vt) {
      const t = vt[code];
      teams.push({ code, name: TEAMNAME[code] || code, total: t.total, preseason: t.preseason, live: t.live, env: t.env, source: t.source });
    }
    teams.sort((a, b) => b.total - a.total).forEach((t, i) => t.rank = i + 1);

    // ── games ────────────────────────────────────────────────────────────
    let games, gamesSample = false;
    if (hasFeedGames) {
      games = feed.vegas_games.map(g => normalizeFeedGame(g));
    } else {
      games = sampleGames(teams, cfg); gamesSample = true;
    }

    return {
      season: feed ? feed.season : null,
      week: feed ? feed.week : null,
      generated: feed ? feed.generated : null,
      meta: (feed && feed.vegas_meta) || {},
      hasLiveProps: !!hasFeedProps,
      hasLiveGames: !!hasFeedGames,
      gamesSample,
      teams, players, games,
      _cfg: cfg,
    };
  }

  function normalizeFeedGame(g) {
    return {
      away: g.away, home: g.home,
      implied: g.implied || { home: null, away: null },
      spread: gameMarket(g.spread, 'spread'),
      total: gameMarket(g.total, 'total'),
      ml: gameMarket(g.ml, 'ml'),
      book: g.book || null, commence: g.commence || null, slot: slotFromCommence(g.commence), sample: false,
    };
  }
  function gameMarket(m, kind) {
    if (!m) return { quotes: [], best: {}, cons: null };
    return { quotes: m.quotes || [], best: m.best || {}, cons: m.cons ?? null, fav: m.fav ?? null };
  }

  /* sample slate: pair teams by rank; spread+total are math-consistent with the
     real implied totals. Per-book quotes synthesized around those lines so the
     comparison grid is populated off-season. Flagged sample:true. */
  function sampleGames(teams, cfg) {
    const out = [];
    const books = cfg.sampleBooks;
    const sorted = teams.slice().sort((a, b) => b.total - a.total);
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      const a = sorted[i], b = sorted[i + 1];           // a >= b implied
      const away = a.code, home = b.code;
      const totalLine = round(a.total + b.total, 1);
      const absSpread = half(a.total - b.total) || 0.5;  // away (a) favored
      const seed = away + home;
      // total quotes (o/line/u around totalLine)
      const tq = synthQuotes(totalLine, 'yd', 'T' + seed, books).map(q => ({ book: q.book, line: q.line, over: q.over, under: q.under }));
      // spread quotes: away -absSpread, home +absSpread, prices jittered
      const r = rng('S' + seed);
      const sq = books.map(book => {
        const aw = -Math.round(102 + r() * 30), hm = -Math.round(102 + r() * 30);
        const shade = r() < 0.25 ? (r() < 0.5 ? 0.5 : -0.5) : 0;
        return { book, away: { line: round(-absSpread + shade, 1), price: aw }, home: { line: round(absSpread - shade, 1), price: hm } };
      });
      // moneyline quotes derived from spread magnitude
      const favMlBase = -Math.round(110 + absSpread * 22), dogMlBase = Math.round(100 + absSpread * 20);
      const mq = books.map(book => {
        const j = Math.round((r() - 0.5) * 24);
        return { book, away: favMlBase + j, home: dogMlBase + j };
      });
      const bestPrice = (arr, pick) => arr.reduce((best, q) => { const p = pick(q); return (p != null && (!best || p > best.price)) ? { book: q.book, price: p } : best; }, null);
      out.push({
        away, home,
        implied: { away: round(a.total, 1), home: round(b.total, 1) },
        total: { cons: totalLine, quotes: tq, best: { over: bestPrice(tq, q => q.over), under: bestPrice(tq, q => q.under) } },
        spread: { fav: away, cons: { away: -absSpread, home: absSpread }, quotes: sq, best: { away: bestPrice(sq, q => q.away.price), home: bestPrice(sq, q => q.home.price) } },
        ml: { quotes: mq, best: { away: bestPrice(mq, q => q.away), home: bestPrice(mq, q => q.home) } },
        book: null, commence: null, slot: null, sample: true,
      });
    }
    return out;
  }

  /* ── flatten props to one row per (player, market) ────────────────────── */
  function propRows(model, f) {
    f = f || {};
    const tf = f.timeframe || 'season';
    const rows = [];
    for (const p of model.players) {
      if (f.pos && p.pos !== f.pos) continue;
      if (f.team && p.team !== f.team) continue;
      const block = tf === 'weekly' ? p.weekly : p.season;
      if (!block || !block.lines) continue;
      const wk = tf === 'weekly' ? p.weekly : null;
      if (f.opp && (!wk || wk.opp !== f.opp)) continue;
      if (f.slot && (!wk || wk.slot !== f.slot)) continue;
      for (const mk in block.lines) {
        if (f.market && mk !== f.market) continue;
        const m = MARKET_BY_KEY[mk]; if (!m) continue;
        if (f.posMarketOnly && p.pos && !m.pos.includes(p.pos)) continue;
        const cell = block.lines[mk]; if (!cell) continue;
        const val = m.kind === 'prob' ? cell.prob : cell.line;
        if (f.min != null && val < f.min) continue;
        if (f.max != null && val > f.max) continue;
        // per-book quotes: real from feed, else synthesized (deterministic) for the grid
        const books = (model._cfg && model._cfg.sampleBooks) || [];
        let quotes = cell.quotes;
        if (!quotes || !quotes.length) quotes = synthQuotes(val, m.kind, (p.id || p.name) + ':' + mk + ':' + tf, books);
        const best = cell.best && (cell.best.over || cell.best.under)
          ? cell.best
          : { over: bestOf(quotes, 'over'), under: bestOf(quotes, 'under') };
        rows.push({
          id: p.id, name: p.name, team: p.team, teamName: p.teamName, pos: p.pos,
          headshot: p.headshot, rank: p.rank,
          market: mk, marketLabel: m.label, marketShort: m.short, kind: m.kind,
          line: cell.line ?? null, prob: cell.prob ?? null, value: val,
          over: cell.over ?? null, under: cell.under ?? null, book: cell.book || null, modeled: !!cell.modeled,
          quotes, best,
          timeframe: tf,
          opp: wk ? wk.opp : null, ha: wk ? wk.ha : null, event: wk ? wk.event : null, slot: wk ? wk.slot : null,
          derived: wk ? !!wk.derived : false,
        });
      }
    }
    if (f.search) { const q = f.search.toLowerCase(); return rows.filter(r => r.name.toLowerCase().includes(q)); }
    return rows;
  }

  /* ── menu helpers ─────────────────────────────────────────────────────── */
  const teams = model => model.teams.map(t => t.code).sort();
  const bookColumns = model => {
    // live: union of books actually present in player/game quotes; else sample list
    const set = new Set();
    for (const p of model.players) {
      const wk = p.weekly && p.weekly.lines;
      if (!wk) continue;
      for (const mk in wk) (wk[mk].quotes || []).forEach(q => q.book && set.add(q.book));
    }
    if (!set.size) for (const g of model.games || []) ['spread', 'total', 'ml'].forEach(k => (g[k] && g[k].quotes || []).forEach(q => q.book && set.add(q.book)));
    return set.size ? [...set] : ((model._cfg && model._cfg.sampleBooks) || []).slice();
  };
  const opponents = model => [...new Set(model.players.map(p => p.weekly && p.weekly.opp).filter(Boolean))].sort();
  const marketsFor = pos => MARKETS.filter(m => !pos || m.pos.includes(pos));
  const sortRows = (rows, key, dir) => rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string') return (dir || 1) * av.localeCompare(bv);
    return (dir || 1) * ((av ?? -Infinity) - (bv ?? -Infinity));
  });

  window.VaultBetting = { load, propRows, sortRows, teams, opponents, marketsFor, bookColumns, fmtOdds, fmtLine, MARKETS, MARKET_BY_KEY, TEAMNAME, headshotFor, normName };
})();
