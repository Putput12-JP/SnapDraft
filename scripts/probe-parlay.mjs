#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · PARLAYAPI ACCESS PROBE
   ────────────────────────────────────────────────────────────────────────
   Runs in GitHub Actions (manual dispatch) and DUMPS exactly what your
   ParlayAPI key can reach, so we can wire the Betting feed to the real shape
   instead of guessing. Reads nothing, writes nothing — pure read-only probe.

   It hits, in order, and logs the outcome of each:
     1. GET /v1/sports                         → which sports your key sees
     2. GET /v1/sports/{NFL}/odds              → game lines + BOOK NAMES
     3. GET /v1/sports/{NFL}/props/markets     → available prop MARKET KEYS
     4. GET /v1/sports/{NFL}/props             → sample props + books (NEW shape)
     5. GET /v1/sports/{NFL}/events            → upcoming events (fallback shape)

   Auth: ParlayAPI uses the `X-API-Key` header. We also retry with `?apiKey=`
   as a fallback in case your plan accepts the TOA-style query param.

   Set repo secret  PARLAY_API_KEY  (or it falls back to PROPS_API_KEY).
   Optional var      PARLAY_BASE     (defaults https://parlay-api.com/v1)
   ════════════════════════════════════════════════════════════════════════ */

const KEY = process.env.PARLAY_API_KEY || process.env.PROPS_API_KEY || '';
const BASE = (process.env.PARLAY_BASE || 'https://parlay-api.com/v1').replace(/\/$/, '');
const NFL = 'americanfootball_nfl';
const UA = { 'user-agent': 'vault-parlay-probe/1.0' };

const line = (c = '─') => console.log(c.repeat(72));
const head = t => { console.log('\n' + '═'.repeat(72)); console.log('  ' + t); console.log('═'.repeat(72)); };

if (!KEY) {
  console.error('✗ No API key. Set repo secret PARLAY_API_KEY (or PROPS_API_KEY) and re-run.');
  process.exit(1);
}
console.log(`ParlayAPI probe · base ${BASE} · key …${KEY.slice(-4)}`);

/* fetch with header auth, fall back to query-param auth on 401/403 */
async function probe(path, label) {
  const url = `${BASE}${path}`;
  try {
    let r = await fetch(url, { headers: { ...UA, 'X-API-Key': KEY } });
    let auth = 'X-API-Key header';
    if (r.status === 401 || r.status === 403) {
      const u2 = url + (url.includes('?') ? '&' : '?') + 'apiKey=' + KEY;
      const r2 = await fetch(u2, { headers: UA });
      if (r2.ok) { r = r2; auth = '?apiKey query'; }
    }
    const credits = r.headers.get('x-credits-remaining') || r.headers.get('x-requests-remaining');
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch (e) {}
    console.log(`\n[${label}] ${path}`);
    console.log(`  status ${r.status} ${r.statusText} · auth: ${auth}${credits ? ' · credits left: ' + credits : ''}`);
    if (!r.ok) {
      console.log('  body: ' + body.slice(0, 300));
      return { ok: false, status: r.status, json: null };
    }
    return { ok: true, status: r.status, json, raw: body };
  } catch (e) {
    console.log(`\n[${label}] ${path}\n  ✗ network error: ${e.message}`);
    return { ok: false, status: 0, json: null };
  }
}

const bookNamesFromGame = g => (g?.bookmakers || []).map(b => b.title || b.key);
const uniq = a => [...new Set(a)];

(async () => {
  // 1 ── sports
  head('1 · SPORTS your key can access');
  const sports = await probe('/sports', 'sports');
  if (sports.ok && Array.isArray(sports.json)) {
    const af = sports.json.filter(s => /football/i.test(s.group || s.title || ''));
    console.log(`  ${sports.json.length} sports total. American Football keys:`);
    af.forEach(s => console.log(`    · ${s.key}  (${s.title}${s.active === false ? ', INACTIVE' : ''})`));
    if (!sports.json.find(s => s.key === NFL)) console.log('  ⚠ NFL key not in list — may be off-season/out-of-season.');
  }

  // 2 ── game odds + book names
  head('2 · GAME LINES + BOOK NAMES (h2h, spreads, totals)');
  const odds = await probe(`/sports/${NFL}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american`, 'game-odds');
  if (odds.ok && Array.isArray(odds.json)) {
    console.log(`  ${odds.json.length} NFL games returned.`);
    if (odds.json.length) {
      const allBooks = uniq(odds.json.flatMap(bookNamesFromGame));
      console.log(`  BOOKS (${allBooks.length}): ${allBooks.join(', ')}`);
      const g0 = odds.json[0];
      console.log(`  sample game: ${g0.away_team} @ ${g0.home_team}`);
      const mk = uniq((g0.bookmakers || []).flatMap(b => (b.markets || []).map(m => m.key)));
      console.log(`  markets on sample: ${mk.join(', ')}`);
      console.log('  first bookmaker raw:');
      console.log('  ' + JSON.stringify((g0.bookmakers || [])[0], null, 2).split('\n').join('\n  ').slice(0, 800));
    } else {
      console.log('  (empty — likely off-season; access still confirmed by 200 status)');
    }
  }

  // 3 ── prop market catalog
  head('3 · PLAYER-PROP MARKET KEYS available for NFL');
  const pmk = await probe(`/sports/${NFL}/props/markets`, 'prop-markets');
  if (pmk.ok) {
    const keys = Array.isArray(pmk.json) ? pmk.json.map(m => (typeof m === 'string' ? m : (m.key || m.market))) : (pmk.json?.markets || []);
    console.log(`  ${keys.length} prop markets:`);
    console.log('  ' + (keys.length ? keys.join(', ') : JSON.stringify(pmk.json).slice(0, 400)));
  }

  // 4 ── props (new ParlayAPI shape: one call, all books)
  head('4 · PLAYER PROPS sample (ParlayAPI /props shape)');
  const props = await probe(`/sports/${NFL}/props?regions=us&oddsFormat=american`, 'props');
  if (props.ok) {
    const j = props.json;
    console.log('  top-level keys: ' + (j && typeof j === 'object' ? Object.keys(Array.isArray(j) ? j[0] || {} : j).join(', ') : typeof j));
    console.log('  RAW (first 1200 chars) — this tells us the exact shape to parse:');
    console.log('  ' + (props.raw || '').slice(0, 1200).split('\n').join('\n  '));
  }

  // 5 ── events fallback shape
  head('5 · EVENTS endpoint (TOA-style fallback)');
  const ev = await probe(`/sports/${NFL}/events`, 'events');
  if (ev.ok && Array.isArray(ev.json)) {
    console.log(`  ${ev.json.length} events. sample id: ${ev.json[0]?.id || '(none)'}`);
  }

  head('SUMMARY');
  console.log(`  sports:        ${sports.ok ? 'OK' : 'FAIL ' + sports.status}`);
  console.log(`  game odds:     ${odds.ok ? 'OK (' + (odds.json?.length || 0) + ' games)' : 'FAIL ' + odds.status}`);
  console.log(`  prop markets:  ${pmk.ok ? 'OK' : 'FAIL ' + pmk.status}`);
  console.log(`  props:         ${props.ok ? 'OK' : 'FAIL ' + props.status}`);
  console.log(`  events:        ${ev.ok ? 'OK' : 'FAIL ' + ev.status}`);
  line();
  console.log('  → Paste this whole log back and I\'ll wire the adapter to the exact shape your plan returns.');
})();
