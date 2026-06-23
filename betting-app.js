/* ════════════════════════════════════════════════════════════════════════
   VAULT · BETTING — in-app tab (Game Markets + Player Props comparison grids)
   ────────────────────────────────────────────────────────────────────────
   Self-contained UI module. Renders into #page-betting, driven by the shared
   data layer (betting-data.js → window.VaultBetting), which reads the live
   cron feed at data/lineup-feed.json. Call window.initBetting() on nav.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const F = () => window.VaultBetting;
  let MODEL = null, BOOTED = false, LOADING = false;
  let view = 'games', tf = 'season', curPos = 'QB', curMarket = 'pass_yd', curGM = 'spread';
  let teamFilter = '', searchQ = '';
  let gSort = { key: 'total', dir: -1 }, pSort = { key: 'value', dir: -1 };

  const POS_COLOR = { QB: 'var(--bt-qb)', RB: 'var(--bt-rb)', WR: 'var(--bt-wr)', TE: 'var(--bt-te)' };
  const GM_TABS = [['spread', 'Spread'], ['total', 'Total'], ['ml', 'Moneyline']];
  const car = (a, d) => '<span class="bt-car">' + (a ? (d < 0 ? '▼' : '▲') : '↕') + '</span>';
  const teamLogo = c => 'https://a.espncdn.com/i/teamlogos/nfl/500/' + ({ WAS: 'wsh', JAX: 'jax' }[c] || c || 'nfl').toLowerCase() + '.png';
  const sline = n => n == null ? '' : (n > 0 ? '+' + n : '' + n);
  const round05 = n => n == null ? null : Math.round(n * 2) / 2;
  const oddsCls = p => p == null ? 'bt-dim' : (p > 0 ? 'bt-odds pos' : 'bt-odds neg');

  /* ── styles (scoped to #page-betting) ─────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('bt-styles')) return;
    const css = `
#page-betting{--bt-s1:#0e1626;--bt-s2:#131d30;--bt-s3:#1b2740;--bt-s4:#243352;
  --bt-border:rgba(123,170,240,0.10);--bt-border2:rgba(123,170,240,0.17);--bt-border3:rgba(123,170,240,0.30);
  --bt-text:#eaf2fc;--bt-text2:#bdcce2;--bt-muted:#7d8ca3;--bt-faint:#5a6b85;
  --bt-accent:#2f63c4;--bt-accent2:#7bd0ff;--bt-qb:#ff6680;--bt-rb:#3DCC7A;--bt-wr:#7bd0ff;--bt-te:#f5c842;--bt-gold:#f5c842;--bt-green:#34d17e;
  --bt-mono:'JetBrains Mono','Space Mono',ui-monospace,monospace;
  padding:22px 28px 90px;color:var(--bt-text)}
#page-betting .bt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:18px}
#page-betting .bt-eyebrow{font-family:var(--bt-mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--bt-accent2);margin-bottom:9px}
#page-betting .bt-title{font-size:30px;font-weight:800;letter-spacing:-.035em;line-height:1;margin:0}
#page-betting .bt-rule{width:38px;height:3px;background:var(--bt-accent);border-radius:2px;margin:11px 0 9px}
#page-betting .bt-sub{font-size:13px;color:var(--bt-muted);line-height:1.5;max-width:560px}
#page-betting .bt-live{display:inline-flex;align-items:center;gap:7px;font-family:var(--bt-mono);font-size:10px;color:var(--bt-rb);border:1px solid var(--bt-border2);background:var(--bt-s1);padding:7px 12px;border-radius:9999px;white-space:nowrap}
#page-betting .bt-live .bt-dot{width:7px;height:7px;border-radius:50%;background:var(--bt-rb);box-shadow:0 0 8px var(--bt-rb)}
#page-betting .bt-seg{display:inline-flex;gap:3px;background:var(--bt-s1);border:1px solid var(--bt-border);border-radius:11px;padding:4px}
#page-betting .bt-seg button{border:none;background:transparent;color:var(--bt-muted);font-size:12.5px;font-weight:600;font-family:inherit;padding:8px 15px;border-radius:8px;cursor:pointer}
#page-betting .bt-seg button:hover{color:var(--bt-text)}
#page-betting .bt-seg button.on{background:rgba(77,134,240,.16);color:#fff;box-shadow:inset 0 0 0 1px rgba(77,134,240,.45)}
#page-betting .bt-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}
#page-betting .bt-tag{font-family:var(--bt-mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--bt-gold);border:1px solid rgba(245,200,66,.3);background:rgba(245,200,66,.08);padding:5px 10px;border-radius:7px}
#page-betting .bt-spacer{flex:1}
#page-betting .bt-pos{display:inline-flex;gap:4px}
#page-betting .bt-pos button{font-family:var(--bt-mono);font-size:12px;font-weight:700;color:var(--bt-muted);background:var(--bt-s1);border:1px solid var(--bt-border);padding:8px 15px;border-radius:9px;cursor:pointer}
#page-betting .bt-mkts{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:14px}
#page-betting .bt-mkts button{font-size:12.5px;font-weight:600;color:var(--bt-muted);background:var(--bt-s1);border:1px solid var(--bt-border);padding:8px 16px;border-radius:9px;cursor:pointer}
#page-betting .bt-mkts button:hover{color:var(--bt-text);border-color:var(--bt-border3)}
#page-betting .bt-mkts button.on{color:#06101f;background:var(--bt-accent2);border-color:transparent;font-weight:700}
#page-betting .bt-filters{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
#page-betting .bt-in{font-family:var(--bt-mono);font-size:12px;color:var(--bt-text);background:var(--bt-s1);border:1px solid var(--bt-border2);border-radius:9px;padding:9px 13px;outline:none}
#page-betting .bt-in:focus{border-color:var(--bt-border3)}
#page-betting select.bt-in{cursor:pointer}
#page-betting .bt-count{font-family:var(--bt-mono);font-size:10.5px;color:var(--bt-muted)}
#page-betting .bt-view{display:none}#page-betting .bt-view.on{display:block}
#page-betting .bt-banner{display:flex;align-items:center;gap:10px;background:rgba(245,200,66,.07);border:1px solid rgba(245,200,66,.25);border-radius:11px;padding:11px 15px;margin-bottom:14px;font-size:12px;color:var(--bt-text2);line-height:1.5}
#page-betting .bt-banner b.lab{color:var(--bt-gold);font-family:var(--bt-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(245,200,66,.3);padding:3px 7px;border-radius:6px;white-space:nowrap}
#page-betting .bt-wrap{overflow-x:auto;border:1px solid var(--bt-border);border-radius:14px;background:var(--bt-s1)}
#page-betting table.bt-t{border-collapse:separate;border-spacing:0;width:100%;min-width:max-content}
#page-betting .bt-t thead th{position:sticky;top:0;z-index:5;background:var(--bt-s2);font-family:var(--bt-mono);font-size:10px;letter-spacing:.04em;color:var(--bt-muted);font-weight:600;text-align:right;padding:11px 14px;white-space:nowrap;border-bottom:1px solid var(--bt-border2)}
#page-betting .bt-t thead th.s{cursor:pointer;user-select:none}
#page-betting .bt-t thead th.s:hover{color:var(--bt-text)}
#page-betting .bt-t thead th.on{color:#fff}
#page-betting .bt-t thead th.lft{text-align:left;padding-left:18px}
#page-betting .bt-t thead th.ctr{text-align:center}
#page-betting .bt-car{color:var(--bt-faint);font-size:9px;margin-left:4px}
#page-betting .bt-t thead th.on .bt-car{color:var(--bt-accent2)}
#page-betting .bt-t td{height:48px;padding:0 14px;text-align:right;font-family:var(--bt-mono);font-size:12.5px;color:var(--bt-text);white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.03)}
#page-betting .bt-t tbody tr:hover td{background:rgba(255,255,255,.025)}
#page-betting .bt-t td.lft{text-align:left;padding-left:18px}#page-betting .bt-t td.ctr{text-align:center}
#page-betting .bt-rank{color:var(--bt-faint);font-size:11px}
#page-betting .bt-pl{display:flex;align-items:center;gap:11px;text-align:left}
#page-betting .bt-av{width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bt-s3);border:1px solid var(--bt-border2);font-weight:800;font-size:11px;position:relative;overflow:hidden}
#page-betting .bt-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center}
#page-betting .bt-av.team img{object-fit:contain;padding:5px}
#page-betting .bt-av.sm{width:26px;height:26px;border-radius:7px;font-size:9px}
#page-betting .bt-name{font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--bt-text);white-space:nowrap}
#page-betting .bt-pl-line{font-family:var(--bt-mono);font-size:9.5px;color:var(--bt-muted);margin-top:2px;display:flex;align-items:center;gap:6px}
#page-betting .bt-posb{font-family:var(--bt-mono);font-size:9px;font-weight:700;letter-spacing:.04em;padding:1px 5px;border-radius:4px;border:1px solid;display:inline-block}
#page-betting .bt-vs{font-family:var(--bt-mono);font-size:10px;color:var(--bt-muted)}
#page-betting .bt-line-v{font-weight:700;font-size:14px;color:var(--bt-text)}
#page-betting .bt-line-sub{font-family:var(--bt-mono);font-size:8.5px;color:var(--bt-muted);margin-top:2px;letter-spacing:.04em}
#page-betting .bt-odds{font-size:12px}#page-betting .bt-odds.pos{color:var(--bt-green)}#page-betting .bt-odds.neg{color:var(--bt-text2)}
#page-betting .bt-dim{color:var(--bt-muted)}
#page-betting .bt-proj{font-family:var(--bt-mono);font-size:8px;font-weight:700;letter-spacing:.05em;color:var(--bt-te);border:1px solid rgba(245,200,66,.3);background:rgba(245,200,66,.08);padding:1px 5px;border-radius:4px;vertical-align:middle}
#page-betting .bt-note{margin-top:18px;font-size:11.5px;color:var(--bt-faint);font-family:var(--bt-mono);line-height:1.6}
/* grid */
#page-betting .bt-grid td.c0{position:sticky;left:0;z-index:6;width:46px;min-width:46px;background:var(--bt-s1);text-align:center}
#page-betting .bt-grid td.c1{position:sticky;left:46px;z-index:6;width:226px;min-width:226px;background:var(--bt-s1)}
#page-betting .bt-grid td.c2{position:sticky;left:272px;z-index:6;width:78px;min-width:78px;background:var(--bt-s1);text-align:center}
#page-betting .bt-grid td.c3{position:sticky;left:350px;z-index:6;width:170px;min-width:170px;background:var(--bt-s1);box-shadow:6px 0 14px -8px rgba(0,0,0,.7)}
#page-betting .bt-grid thead th.c0{position:sticky;left:0;z-index:9;width:46px;min-width:46px;background:var(--bt-s2)}
#page-betting .bt-grid thead th.c1{position:sticky;left:46px;z-index:9;width:226px;min-width:226px;background:var(--bt-s2)}
#page-betting .bt-grid thead th.c2{position:sticky;left:272px;z-index:9;width:78px;min-width:78px;background:var(--bt-s2);text-align:center}
#page-betting .bt-grid thead th.c3{position:sticky;left:350px;z-index:9;width:170px;min-width:170px;background:var(--bt-s2);box-shadow:6px 0 14px -8px rgba(0,0,0,.7)}
#page-betting .bt-grid tbody tr:hover td.c0,#page-betting .bt-grid tbody tr:hover td.c1,#page-betting .bt-grid tbody tr:hover td.c2,#page-betting .bt-grid tbody tr:hover td.c3{background:var(--bt-s2)}
#page-betting .bt-grid tbody tr:nth-child(even) td.c0,#page-betting .bt-grid tbody tr:nth-child(even) td.c1,#page-betting .bt-grid tbody tr:nth-child(even) td.c2,#page-betting .bt-grid tbody tr:nth-child(even) td.c3{background:#101824}
#page-betting .bt-best{display:flex;flex-direction:column;gap:3px;text-align:left;font-family:var(--bt-mono);font-size:11px}
#page-betting .bt-best .row{display:flex;align-items:center;gap:6px;white-space:nowrap}
#page-betting .bt-best .sd{color:var(--bt-muted);font-size:9px;min-width:24px}
#page-betting .bt-best .pr{font-weight:700}#page-betting .bt-best .pr.over{color:var(--bt-green)}
#page-betting .bt-best .bk{color:var(--bt-faint);font-size:9.5px;overflow:hidden;text-overflow:ellipsis;max-width:84px}
#page-betting .bt-bh{text-align:center;min-width:96px;font-size:10px;color:var(--bt-text2);font-weight:700;padding:11px 10px}
#page-betting .bt-bc{text-align:center;padding:0 8px}
#page-betting .bt-bc.hasbest{background:linear-gradient(180deg,rgba(52,209,126,.05),transparent)}
#page-betting .bt-bcell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-family:var(--bt-mono);line-height:1.15}
#page-betting .bt-bcell .o,#page-betting .bt-bcell .u{font-size:11px;color:var(--bt-text2)}
#page-betting .bt-bcell .o.best,#page-betting .bt-bcell .u.best{color:var(--bt-green);font-weight:700}
#page-betting .bt-bcell.na{color:var(--bt-faint);font-size:14px}
#page-betting .bt-empty{padding:50px;text-align:center;color:var(--bt-muted);font-family:var(--bt-mono);font-size:13px}`;
    const s = document.createElement('style'); s.id = 'bt-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  /* ── shell ────────────────────────────────────────────────────────────── */
  function shell() {
    return `
    <div class="bt-head">
      <div>
        <div class="bt-eyebrow">Vault · Betting</div>
        <h1 class="bt-title">Betting</h1>
        <div class="bt-rule"></div>
        <div class="bt-sub">Compare every sportsbook on one screen — game spreads &amp; totals, and player props with best-price highlighting across the market.</div>
      </div>
      <div><span class="bt-live"><span class="bt-dot"></span> <span id="bt-src">VEGAS · loading…</span></span></div>
    </div>
    <div class="bt-bar">
      <div class="bt-seg" id="bt-viewseg">
        <button class="on" data-v="games">Game Markets</button>
        <button data-v="props">Player Props</button>
      </div>
      <div class="bt-seg" id="bt-tfseg" style="display:none">
        <button class="on" data-tf="season">Season-Long</button>
        <button data-tf="weekly">Weekly</button>
      </div>
      <span class="bt-tag" id="bt-tftag">GAME MARKETS</span>
      <span class="bt-spacer"></span>
      <div class="bt-pos" id="bt-posseg" style="display:none"></div>
    </div>
    <div class="bt-mkts" id="bt-mkts" style="display:none"></div>
    <div class="bt-filters" id="bt-filters" style="display:none">
      <input id="bt-search" class="bt-in" type="text" placeholder="Search player…" autocomplete="off">
      <select id="bt-team" class="bt-in"></select>
      <span class="bt-count" id="bt-count"></span>
    </div>
    <div class="bt-view on" id="bt-v-games"></div>
    <div class="bt-view" id="bt-v-props"></div>
    <div class="bt-note" id="bt-note"></div>`;
  }

  /* ── GAME MARKETS grid ────────────────────────────────────────────────── */
  function gatherBooks(getQ) { const seen = [], set = new Set(); MODEL.games.forEach(g => (getQ(g) || []).forEach(q => { if (!set.has(q.book)) { set.add(q.book); seen.push(q.book); } })); return seen.length ? seen : F().bookColumns(MODEL); }
  function renderGames() {
    const fb = F(), gm = curGM;
    const books = gatherBooks(g => g[gm] && g[gm].quotes);
    let rows = MODEL.games.slice();
    rows.sort((a, b) => gm === 'total' ? gSort.dir * ((a.total.cons ?? -999) - (b.total.cons ?? -999))
      : gm === 'spread' ? gSort.dir * (Math.abs(a.spread.cons?.away ?? 0) - Math.abs(b.spread.cons?.away ?? 0))
      : gSort.dir * (((a.implied.away ?? 0) + (a.implied.home ?? 0)) - ((b.implied.away ?? 0) + (b.implied.home ?? 0))));
    const thead = '<tr><th class="c0">#</th><th class="c1 lft">Matchup</th><th class="c2 ctr">Line</th><th class="c3 lft">Best Odds</th>' + books.map(b => '<th class="bt-bh">' + b + '</th>').join('') + '</tr>';
    const body = rows.map((g, i) => {
      const qBy = {}; (g[gm].quotes || []).forEach(q => qBy[q.book] = q);
      const best = g[gm].best || {}; let bestBlock = '', cells = '', lineCell = '';
      if (gm === 'total') {
        const bo = best.over && best.over.book, bu = best.under && best.under.book;
        lineCell = '<span class="bt-line-v">' + (g.total.cons != null ? g.total.cons : '—') + '</span><div class="bt-line-sub">O / U</div>';
        bestBlock = '<div class="bt-best"><div class="row"><span class="sd">O</span><span class="pr over">' + (best.over ? fb.fmtOdds(best.over.price) : '—') + '</span><span class="bk">' + (bo || '') + '</span></div><div class="row"><span class="sd">U</span><span class="pr">' + (best.under ? fb.fmtOdds(best.under.price) : '—') + '</span><span class="bk">' + (bu || '') + '</span></div></div>';
        cells = books.map(b => { const q = qBy[b]; if (!q) return '<td class="bt-bc"><span class="bt-bcell na">–</span></td>'; return '<td class="bt-bc' + ((b === bo || b === bu) ? ' hasbest' : '') + '"><div class="bt-bcell"><span class="o' + (b === bo ? ' best' : '') + '">o ' + fb.fmtOdds(q.over) + '</span><span class="u' + (b === bu ? ' best' : '') + '">u ' + fb.fmtOdds(q.under) + '</span></div></td>'; }).join('');
      } else if (gm === 'spread') {
        const ba = best.away && best.away.book, bh = best.home && best.home.book;
        const favLine = g.spread.fav === g.away ? g.spread.cons?.away : g.spread.cons?.home;
        lineCell = '<span class="bt-line-v">' + (g.spread.fav || '') + ' ' + sline(favLine != null ? round05(favLine) : null) + '</span><div class="bt-line-sub">SPREAD</div>';
        bestBlock = '<div class="bt-best"><div class="row"><span class="sd">' + g.away + '</span><span class="pr over">' + (best.away ? fb.fmtOdds(best.away.price) : '—') + '</span><span class="bk">' + (ba || '') + '</span></div><div class="row"><span class="sd">' + g.home + '</span><span class="pr">' + (best.home ? fb.fmtOdds(best.home.price) : '—') + '</span><span class="bk">' + (bh || '') + '</span></div></div>';
        cells = books.map(b => { const q = qBy[b]; if (!q || !q.away) return '<td class="bt-bc"><span class="bt-bcell na">–</span></td>'; return '<td class="bt-bc' + ((b === ba || b === bh) ? ' hasbest' : '') + '"><div class="bt-bcell"><span class="o' + (b === ba ? ' best' : '') + '">' + fb.fmtOdds(q.away.price) + '</span><span class="u' + (b === bh ? ' best' : '') + '">' + fb.fmtOdds(q.home.price) + '</span></div></td>'; }).join('');
      } else {
        const ba = best.away && best.away.book, bh = best.home && best.home.book;
        lineCell = '<span class="bt-line-v" style="color:var(--bt-muted)">—</span><div class="bt-line-sub">ML</div>';
        bestBlock = '<div class="bt-best"><div class="row"><span class="sd">' + g.away + '</span><span class="pr over">' + (best.away ? fb.fmtOdds(best.away.price) : '—') + '</span><span class="bk">' + (ba || '') + '</span></div><div class="row"><span class="sd">' + g.home + '</span><span class="pr">' + (best.home ? fb.fmtOdds(best.home.price) : '—') + '</span><span class="bk">' + (bh || '') + '</span></div></div>';
        cells = books.map(b => { const q = qBy[b]; if (!q) return '<td class="bt-bc"><span class="bt-bcell na">–</span></td>'; return '<td class="bt-bc' + ((b === ba || b === bh) ? ' hasbest' : '') + '"><div class="bt-bcell"><span class="o' + (b === ba ? ' best' : '') + '">' + fb.fmtOdds(q.away) + '</span><span class="u' + (b === bh ? ' best' : '') + '">' + fb.fmtOdds(q.home) + '</span></div></td>'; }).join('');
      }
      return '<tr><td class="c0"><span class="bt-rank">' + (i + 1) + '</span></td>' +
        '<td class="c1 lft"><div class="bt-pl"><span class="bt-av team sm" data-logo="' + g.away + '"></span><span class="bt-av team sm" data-logo="' + g.home + '"></span><div style="margin-left:2px"><div class="bt-name">' + g.away + ' <span class="bt-vs">@</span> ' + g.home + '</div><div class="bt-pl-line"><b>' + (g.implied.away != null ? g.implied.away : '—') + '</b> / <b>' + (g.implied.home != null ? g.implied.home : '—') + '</b> implied' + (g.sample ? ' <span class="bt-proj">SAMPLE</span>' : '') + '</div></div></div></td>' +
        '<td class="c2 ctr">' + lineCell + '</td><td class="c3 lft">' + bestBlock + '</td>' + cells + '</tr>';
    }).join('');
    document.getElementById('bt-v-games').innerHTML =
      (MODEL.gamesSample ? '<div class="bt-banner"><b class="lab">Sample slate</b><span>Off-season — no live game lines yet. Spreads &amp; totals are math-consistent with the real implied team totals; matchups, prices &amp; books are illustrative. Live book lines replace this each week.</span></div>' : '') +
      '<div class="bt-wrap bt-grid"><table class="bt-t"><thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>';
    document.querySelectorAll('#bt-v-games th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; if (gSort.key === k) gSort.dir *= -1; else gSort = { key: k, dir: -1 }; renderGames(); });
    paintLogos('#bt-v-games');
  }

  /* ── PLAYER PROPS grid ────────────────────────────────────────────────── */
  function renderProps() {
    const fb = F(), m = fb.MARKET_BY_KEY[curMarket];
    let rows = fb.propRows(MODEL, { timeframe: tf, pos: curPos, market: curMarket, team: teamFilter || undefined, search: searchQ || undefined, posMarketOnly: true });
    const k = pSort.key;
    rows.sort((a, b) => k === 'name' ? pSort.dir * a.name.localeCompare(b.name)
      : k === 'bestover' ? pSort.dir * (((a.best.over && a.best.over.price) ?? -Infinity) - ((b.best.over && b.best.over.price) ?? -Infinity))
      : pSort.dir * ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)));
    const books = fb.bookColumns(MODEL), col = POS_COLOR[curPos], isProb = m.kind === 'prob', showOpp = tf === 'weekly';
    const thead = '<tr><th class="c0">#</th><th class="c1 lft">Player</th><th class="c2 ctr">Line</th><th class="c3 lft">Best Odds</th>' + books.map(b => '<th class="bt-bh">' + b + '</th>').join('') + '</tr>';
    const body = rows.length ? rows.map((r, i) => {
      const init = r.name.split(' ').map(w => w[0]).slice(0, 2).join('');
      const lineTxt = isProb ? (r.prob != null ? Math.round(r.prob * 100) + '%' : '—') : (r.line != null ? r.line : '—');
      const bo = r.best.over && r.best.over.book, bu = r.best.under && r.best.under.book;
      const qBy = {}; (r.quotes || []).forEach(q => qBy[q.book] = q);
      const cells = books.map(b => {
        const q = qBy[b]; if (!q) return '<td class="bt-bc"><span class="bt-bcell na">–</span></td>';
        if (isProb) return '<td class="bt-bc' + (b === bo ? ' hasbest' : '') + '"><div class="bt-bcell"><span class="o' + (b === bo ? ' best' : '') + '">' + fb.fmtOdds(q.over) + '</span></div></td>';
        return '<td class="bt-bc' + ((b === bo || b === bu) ? ' hasbest' : '') + '"><div class="bt-bcell"><span class="o' + (b === bo ? ' best' : '') + '">o ' + fb.fmtOdds(q.over) + '</span><span class="u' + (b === bu ? ' best' : '') + '">u ' + fb.fmtOdds(q.under) + '</span></div></td>';
      }).join('');
      const bestBlock = '<div class="bt-best"><div class="row"><span class="sd">O</span><span class="pr over">' + (r.best.over ? fb.fmtOdds(r.best.over.price) : '—') + '</span><span class="bk">' + (bo || '') + '</span></div>' +
        (isProb ? '' : '<div class="row"><span class="sd">U</span><span class="pr">' + (r.best.under ? fb.fmtOdds(r.best.under.price) : '—') + '</span><span class="bk">' + (bu || '') + '</span></div>') + '</div>';
      return '<tr><td class="c0"><span class="bt-rank">' + (i + 1) + '</span></td>' +
        '<td class="c1 lft"><div class="bt-pl"><span class="bt-av" data-hs="' + (r.headshot || '') + '" style="color:' + col + '">' + init + '</span><div><div class="bt-name">' + r.name + '</div><div class="bt-pl-line"><span class="bt-posb" style="color:' + col + ';border-color:' + col + '">' + r.pos + '</span>' + (r.team ? '<span>' + r.team + '</span>' : '') + (showOpp && r.opp ? '<span>vs ' + r.opp + '</span>' : '') + (r.modeled ? ' <span class="bt-proj">PROJ</span>' : '') + '</div></div></div></td>' +
        '<td class="c2 ctr"><span class="bt-line-v">' + lineTxt + '</span></td><td class="c3 lft">' + bestBlock + '</td>' + cells + '</tr>';
    }).join('') : '<tr><td class="c0">–</td><td class="c1 lft" colspan="' + (books.length + 3) + '"><div class="bt-empty">No players match these filters.</div></td></tr>';
    document.getElementById('bt-v-props').innerHTML =
      (!MODEL.hasLiveProps ? '<div class="bt-banner"><b class="lab">Projected book lines</b><span>No live props feed yet — book prices shown are modeled around each player\'s projected line so you can see the comparison grid. Once props post (ParlayAPI), real book odds replace these automatically.</span></div>' : '') +
      '<div class="bt-wrap bt-grid"><table class="bt-t"><thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>';
    paintHeadshots('#bt-v-props');
    document.getElementById('bt-count').textContent = rows.length + ' players · ' + books.length + ' books';
  }

  function paintHeadshots(scope) { document.querySelectorAll(scope + ' .bt-av[data-hs]').forEach(av => { if (av.querySelector('img')) return; const u = av.dataset.hs; if (!u) return; const img = document.createElement('img'); img.src = u; img.loading = 'lazy'; img.onerror = () => img.remove(); av.appendChild(img); }); }
  function paintLogos(scope) { document.querySelectorAll(scope + ' .bt-av.team').forEach(av => { if (av.querySelector('img')) return; const img = document.createElement('img'); img.src = teamLogo(av.dataset.logo); img.loading = 'lazy'; img.onerror = () => img.remove(); av.appendChild(img); }); }

  function renderPosSeg() {
    const seg = document.getElementById('bt-posseg');
    seg.style.display = view === 'props' ? 'inline-flex' : 'none';
    seg.innerHTML = ['QB', 'RB', 'WR', 'TE'].map(p => { const on = p === curPos, c = POS_COLOR[p]; return '<button data-p="' + p + '" style="' + (on ? 'color:#06101f;background:' + c + ';border-color:transparent' : 'color:' + c) + '">' + p + '</button>'; }).join('');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => { curPos = b.dataset.p; const mks = F().marketsFor(curPos); curMarket = mks[0].key; renderMkts(); renderProps(); });
  }
  function renderMkts() {
    const el = document.getElementById('bt-mkts');
    el.style.display = (view === 'props' || view === 'games') ? 'flex' : 'none';
    if (view === 'games') { el.innerHTML = GM_TABS.map(([k, l]) => '<button data-gm="' + k + '" class="' + (k === curGM ? 'on' : '') + '">' + l + '</button>').join(''); el.querySelectorAll('button').forEach(b => b.onclick = () => { curGM = b.dataset.gm; renderMkts(); renderGames(); }); return; }
    const mks = F().marketsFor(curPos); if (!mks.find(m => m.key === curMarket)) curMarket = mks[0].key;
    el.innerHTML = mks.map(m => '<button data-mk="' + m.key + '" class="' + (m.key === curMarket ? 'on' : '') + '">' + m.label + '</button>').join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => { curMarket = b.dataset.mk; renderMkts(); renderProps(); });
  }
  function renderFilters() {
    document.getElementById('bt-filters').style.display = view === 'props' ? 'flex' : 'none';
    document.getElementById('bt-tfseg').style.display = view === 'props' ? 'inline-flex' : 'none';
    const sel = document.getElementById('bt-team');
    if (!sel.dataset.built) {
      sel.innerHTML = '<option value="">All teams</option>' + F().teams(MODEL).map(c => '<option value="' + c + '">' + c + '</option>').join('');
      sel.dataset.built = '1';
      sel.onchange = () => { teamFilter = sel.value; renderProps(); };
      document.getElementById('bt-search').oninput = e => { searchQ = e.target.value; renderProps(); };
    }
  }
  function renderNote() {
    document.getElementById('bt-note').innerHTML = view === 'games'
      ? '◆ GAME MARKETS — spread, total &amp; implied team scores with the price and book each line is from. Live via ParlayAPI during the season.'
      : '◆ PLAYER PROPS — every sportsbook side-by-side; best price each side is highlighted green. Real book lines show when props post; until then modeled around the projected line (PROJ).';
  }
  function render() {
    document.getElementById('bt-tftag').textContent = view === 'games' ? 'GAME MARKETS · ' + GM_TABS.find(t => t[0] === curGM)[1].toUpperCase() : (tf === 'season' ? 'SEASON-LONG · ' + (MODEL.season || '') : 'WEEKLY · ' + (MODEL.hasLiveProps ? 'LIVE LINES' : 'PROJECTED'));
    renderPosSeg(); renderMkts(); renderFilters();
    if (view === 'games') renderGames(); else renderProps();
    renderNote();
  }
  function wire() {
    document.querySelectorAll('#bt-tfseg button').forEach(b => b.onclick = () => { document.querySelectorAll('#bt-tfseg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); tf = b.dataset.tf; renderProps(); });
    document.querySelectorAll('#bt-viewseg button').forEach(b => b.onclick = () => { document.querySelectorAll('#bt-viewseg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); view = b.dataset.v; document.getElementById('bt-v-games').classList.toggle('on', view === 'games'); document.getElementById('bt-v-props').classList.toggle('on', view === 'props'); render(); });
  }

  /* ── entry ────────────────────────────────────────────────────────────── */
  async function initBetting() {
    const host = document.getElementById('page-betting');
    if (!host) return;
    injectStyles();
    if (BOOTED) return;            // already rendered once; keep state
    if (LOADING) return; LOADING = true;
    host.innerHTML = shell();
    wire();
    try {
      MODEL = await F().load();
      BOOTED = true;
      const m = MODEL.meta || {};
      const src = MODEL.hasLiveProps ? ('props · ' + (m.props_source || 'live')) : (m.live_source && m.live_source !== 'none' ? ('games · ' + m.live_source) : 'preseason workbook');
      document.getElementById('bt-src').textContent = 'VEGAS · ' + src + ' · ' + MODEL.games.length + ' games · ' + MODEL.players.length + ' players';
      render();
    } catch (e) {
      host.querySelector('#bt-v-games').innerHTML = '<div class="bt-empty">Couldn\'t load the betting feed.<br>' + (e && e.message ? e.message : '') + '</div>';
    } finally { LOADING = false; }
  }
  window.initBetting = initBetting;
})();
