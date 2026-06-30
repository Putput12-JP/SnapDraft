#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · PICK'EM PROPS  →  vegas_player_props
   ────────────────────────────────────────────────────────────────────────
   Free, keyless player-prop feed for the Betting tab. Pulls PrizePicks
   pick'em lines (and, best-effort, Underdog), resolves each player to its
   Sleeper id, maps PrizePicks stat types to Vault's market keys, and merges
   the result into data/lineup-feed.json under `vegas_player_props` — the exact
   shape betting-data.js already consumes. No API key, no credits.

   Cell shape written (matches betting-data.js):
     lines[marketKey] = {
       line, over, under, book,
       quotes:[{book,line,over,under}],
       best:{ over:{book,price}|null, under:{book,price}|null },
       pickem:true                      // flag: single-number line, no 2-sided price
     }

   Pick'em lines have no two-sided American price, so over/under are null. The
   grid renders the line; prices show as "—". (A later UI tweak can label
   pick'em columns "PICK" instead.)

   Run:
     node scripts/fetch-pickem-props.mjs                 # fetch live, merge feed
     node scripts/fetch-pickem-props.mjs --dry           # fetch, print summary, write nothing
     node scripts/fetch-pickem-props.mjs --force         # write even if 0 props (clears stale)
   Offline test (no network):
     node scripts/fetch-pickem-props.mjs --dry \
       --pp-fixture=scripts/_pp.sample.json \
       --sleeper-fixture=scripts/_sleeper.sample.json

   Env / flags:
     --feed=PATH         feed json to merge into        (default data/lineup-feed.json)
     --league=ID         PrizePicks league id           (default 9 = NFL)
     --pp-fixture=PATH   read PrizePicks json from file instead of network
     --sleeper-fixture=PATH  read Sleeper players json from file instead of network
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/* ── args ─────────────────────────────────────────────────────────────── */
const ARG = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DRY      = !!ARG.dry;
const FORCE    = !!ARG.force;
const FEED     = ARG.feed     || 'data/lineup-feed.json';
const LEAGUE   = String(ARG.league || 9);            // 9 = NFL on PrizePicks
const PP_FIX   = ARG['pp-fixture'] || null;
const SL_FIX   = ARG['sleeper-fixture'] || null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const log = (...a) => console.log('[pickem]', ...a);

/* ── identity helpers (mirror betting-data.js normName) ───────────────── */
const normName = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');

/* ── PrizePicks stat_type → Vault market key ──────────────────────────── */
/* matched by normalized contains, longest-key first so "pass+rush" wins over "rush" */
const STAT_MAP = [
  ['passrushyards',  'pass_rush_yd'],
  ['passrushyds',    'pass_rush_yd'],
  ['rushrecyards',   'rush_rec_yd'],
  ['rushrecyds',     'rush_rec_yd'],
  ['passingyards',   'pass_yd'],
  ['passyards',      'pass_yd'],
  ['passingtds',     'pass_td'],
  ['passtds',        'pass_td'],
  ['passtouchdowns', 'pass_td'],
  ['passcompletions','pass_cmp'],
  ['completions',    'pass_cmp'],
  ['passattempts',   'pass_att'],
  ['interceptions',  'pass_int'],
  ['longestcompletion','long_pass'],
  ['rushingyards',   'rush_yd'],
  ['rushyards',      'rush_yd'],
  ['rushingtds',     'rush_td'],
  ['rushtds',        'rush_td'],
  ['rushattempts',   'rush_att'],
  ['carries',        'rush_att'],
  ['longestrush',    'long_rush'],
  ['receivingyards', 'rec_yd'],
  ['recyards',       'rec_yd'],
  ['receivingtds',   'rec_td'],
  ['rectds',         'rec_td'],
  ['receptions',     'rec'],
  ['longestreception','long_rec'],
  ['kickingpoints',  'kick_pts'],
  ['fgmade',         'fg_made'],
  ['fieldgoalsmade', 'fg_made'],
  ['tacklesassists', 'tackles'],
  ['tackles',        'tackles'],
  ['sacks',          'sacks'],
];
function marketKeyFor(statType) {
  const n = (statType || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [needle, key] of STAT_MAP) if (n.includes(needle)) return key;
  return null;
}

/* ── fetch helpers ────────────────────────────────────────────────────── */
async function getJSON(url, label) {
  const r = await fetch(url, { headers: {
    'User-Agent': UA, 'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9', 'Origin': 'https://app.prizepicks.com',
    'Referer': 'https://app.prizepicks.com/',
  }});
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  return r.json();
}
function readFixture(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/* ── Sleeper name → {id,team,pos} map ─────────────────────────────────── */
async function loadSleeperMap() {
  const all = SL_FIX ? readFixture(SL_FIX)
    : await getJSON('https://api.sleeper.app/v1/players/nfl', 'sleeper');
  const map = {};        // normName -> {id,team,pos}
  const byNameTeam = {}; // normName+team -> {id,team,pos}  (disambiguates dup names)
  for (const id in all) {
    const p = all[id];
    if (!p || !['QB', 'RB', 'WR', 'TE', 'K', 'LB', 'DB', 'DL'].includes(p.position)) continue;
    const nm = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`;
    const key = normName(nm); if (!key) continue;
    const team = (p.team || '').toUpperCase() || null;
    const rec = { id, team, pos: p.position };
    if (!map[key]) map[key] = rec;
    if (team) byNameTeam[key + ':' + team] = rec;
  }
  return { map, byNameTeam };
}
function resolveSleeper(sl, name, team) {
  const key = normName(name); if (!key) return null;
  if (team && sl.byNameTeam[key + ':' + team.toUpperCase()]) return sl.byNameTeam[key + ':' + team.toUpperCase()];
  return sl.map[key] || null;
}

/* ── PrizePicks loader (paginated JSON:API) ───────────────────────────── */
async function loadPrizePicks() {
  let raw, firstPageError = null;
  if (PP_FIX) {
    raw = [readFixture(PP_FIX)];
  } else {
    raw = [];
    for (let page = 1; page <= 12; page++) {
      const url = `https://api.prizepicks.com/projections?league_id=${LEAGUE}&per_page=250&single_stat=true&page=${page}`;
      let j;
      try { j = await getJSON(url, `prizepicks p${page}`); }
      catch (e) { log('fetch failed:', e.message); if (page === 1) firstPageError = e; break; }
      raw.push(j);
      const data = j.data || [];
      const totalPages = j.meta && j.meta.total_pages;
      if (!data.length) break;
      if (totalPages && page >= totalPages) break;
      await new Promise(r => setTimeout(r, 350)); // be polite
    }
  }
  // Surface a hard failure (Cloudflare block, network) by re-throwing — the
  // cron's outer catch logs it and exits 0, but the visible "ERROR:" log + the
  // 0-props line in the workflow tells you the pipeline broke vs. PP being empty.
  if (firstPageError) throw new Error(`PrizePicks unreachable (page 1): ${firstPageError.message}`);
  // flatten across pages
  const players = {}; // ppId -> {name,team,pos}
  const projections = [];
  for (const j of raw) {
    for (const inc of (j.included || [])) {
      if (inc.type === 'new_player' || inc.type === 'player') {
        const a = inc.attributes || {};
        players[inc.id] = {
          name: a.display_name || a.name || '',
          team: (a.team || a.team_name || '').toUpperCase() || null,
          pos: (a.position || '').toUpperCase() || null,
        };
      }
    }
    for (const d of (j.data || [])) {
      if (d.type !== 'projection') continue;
      const a = d.attributes || {};
      const rel = d.relationships || {};
      const ppId = rel.new_player?.data?.id || rel.player?.data?.id || null;
      projections.push({
        ppId,
        stat: a.stat_type || a.stat_display_name || '',
        line: a.line_score != null ? Number(a.line_score) : null,
        oddsType: a.odds_type || 'standard',   // standard | demon | goblin
        start: a.start_time || a.board_time || null,
        desc: a.description || '',
        status: a.status || null,
      });
    }
  }
  return { players, projections };
}

/* ── transform → vegas_player_props ───────────────────────────────────── */
function buildProps(pp, sl) {
  const out = {};           // sleeperId -> {lines, opp, commence}
  const seen = new Set();   // sleeperId|market — keep first standard line
  let events = new Set(), matched = 0, unmatched = 0, lines = 0;

  // standard lines first (so demon/goblin alt lines don't overwrite the rep line)
  const ordered = pp.projections.slice().sort((a, b) =>
    (a.oddsType === 'standard' ? 0 : 1) - (b.oddsType === 'standard' ? 0 : 1));

  for (const proj of ordered) {
    if (proj.line == null || !proj.ppId) continue;
    if (proj.status && /^(suspended|inactive)$/i.test(proj.status)) continue;
    const market = marketKeyFor(proj.stat); if (!market) continue;
    const ppPlayer = pp.players[proj.ppId]; if (!ppPlayer) continue;

    const hit = resolveSleeper(sl, ppPlayer.name, ppPlayer.team);
    if (!hit) { unmatched++; continue; }
    const id = hit.id;
    const dedupe = id + '|' + market;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    if (!out[id]) {
      // Embed identity (name/team/pos) on the prop so the betting UI can
      // surface props for players the preseason workbook doesn't cover
      // (PrizePicks routinely posts lines for backups and lesser-known WRs
      // the workbook skips). Identity comes from the Sleeper resolver hit.
      out[id] = {
        name: ppPlayer.name || null,
        team: hit.team || ppPlayer.team || null,
        pos: hit.pos || ppPlayer.pos || null,
        lines: {}, opp: null, commence: null,
      };
    }
    const cell = {
      line: proj.line, over: null, under: null, book: 'PrizePicks',
      quotes: [{ book: 'PrizePicks', line: proj.line, over: null, under: null }],
      best: { over: null, under: null },
      pickem: true,
    };
    out[id].lines[market] = cell;
    if (proj.start && !out[id].commence) out[id].commence = proj.start;
    if (proj.desc && !out[id].opp) {
      const m = proj.desc.match(/\b([A-Z]{2,3})\b/);
      if (m) out[id].opp = m[1];
    }
    if (proj.start) events.add(proj.start.slice(0, 10));
    lines++;
  }
  matched = Object.keys(out).length;
  return { props: out, stats: { players: matched, unmatched, lines, events: events.size } };
}

/* ── merge into feed ──────────────────────────────────────────────────── */
function mergeFeed(props, stats) {
  if (!existsSync(FEED)) { log('feed not found, nothing to merge:', FEED); return false; }
  const feed = JSON.parse(readFileSync(FEED, 'utf8'));
  const had = feed.vegas_player_props ? Object.keys(feed.vegas_player_props).length : 0;

  if (!stats.players && !FORCE) {
    log(`0 props parsed — leaving existing feed untouched (had ${had}). Use --force to clear.`);
    return false;
  }
  feed.vegas_player_props = props;
  feed.vegas_meta = feed.vegas_meta || {};
  feed.vegas_meta.props_source  = stats.players ? 'prizepicks' : 'none';
  feed.vegas_meta.props_players = stats.players;
  feed.vegas_meta.props_events  = stats.events;
  feed.vegas_meta.props_generated = new Date().toISOString();
  if (DRY) { log('DRY — would write feed with', stats.players, 'players /', stats.lines, 'lines'); return true; }
  writeFileSync(FEED, JSON.stringify(feed));
  log(`wrote ${FEED}: ${stats.players} players, ${stats.lines} lines (was ${had})`);
  return true;
}

/* ── main ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const sl = await loadSleeperMap();
    log('sleeper map:', Object.keys(sl.map).length, 'names');
    const pp = await loadPrizePicks();
    log('prizepicks:', Object.keys(pp.players).length, 'players,', pp.projections.length, 'projections');
    const { props, stats } = buildProps(pp, sl);
    log(`mapped: ${stats.players} players, ${stats.lines} lines, ${stats.events} event-days, ${stats.unmatched} unmatched names`);
    mergeFeed(props, stats);
  } catch (e) {
    log('ERROR:', e.message);
    process.exit(0); // never fail the workflow / never wipe the feed on error
  }
})();
