#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   VAULT · GRADE-MATH REGRESSION TEST
   ────────────────────────────────────────────────────────────────────────
   Guards the 4-factor grade engine (Upside / Floor / Risk / Situational).

   It loads the REAL engine straight out of index.html — the <script
   id="vaultgrades-inline"> block — and runs it against the REAL
   data/nflverse_stats.json, with the browser surface stubbed. Nothing is
   re-implemented here: if the engine changes, this tests the change. A copy
   of the formula in the test would drift from the app exactly the way the
   app's two engine copies drifted from each other, which is the bug this
   whole area is recovering from.

   Why these checks exist (each one is a real defect we shipped and fixed):
     · pools populate            — a `s.ceil` vs `s.ceiling` typo left every
                                   ceiling pool empty, silently flat-lining
                                   34% of the Upside weight at a constant.
     · market pool, not all-stats— grading against "anyone who took a snap"
                                   padded each position with undraftable depth,
                                   unevenly (TE ~2.8x vs QB ~1.6x), inflating
                                   replacement-level players.
     · pins can't move a grade   — the pool is the market universe, so a user
                                   reordering their board must not restate
                                   anyone's grade.
     · half-PPR is its own tier  — it used to snap to full PPR.
     · pass-catching RB bonus    — was live in one engine, `0 // reserved` in
                                   the other.
     · no-data baseline risk     — one engine charged +0.6 only to rookies,
                                   making a veteran with no recent tape look
                                   SAFER than a rookie.
     · league-independence       — Upside/Floor/Risk are intrinsic; the same
                                   player must not grade differently in two of
                                   your leagues. Only Situational takes ctx.

   Run:  node scripts/test-grades.mjs        (exit 0 = pass, 1 = fail)
   ════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const STATS = path.join(ROOT, 'data', 'nflverse_stats.json');

// ── tiny assert harness ────────────────────────────────────────────────
const failures = [];
let passed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`); }
}
const fmt = n => (typeof n === 'number' ? n.toFixed(2) : String(n));

// ── load the engine out of index.html ──────────────────────────────────
function loadEngine(stats) {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/<script id="vaultgrades-inline">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('could not find <script id="vaultgrades-inline"> in index.html');

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    NFLVERSE_BASE: '/data',
    // mirrors index.html's normName
    normName: s => String(s || '').toLowerCase().replace(/['`]/g, '').replace(/\./g, '')
                    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(),
    getPlayerTrend: () => 0,
    // mirrors window.vaultAgeRisk (shared by the engine; stubbed so this test
    // isolates the GRADE math rather than the age curve)
    vaultAgeRisk: (pos, age, dyn) => {
      if (age == null) return 0;
      const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      if (!dyn) {
        if (pos === 'RB' && age >= 27) return age >= 29 ? 2.4 : 1.4;
        if (pos === 'WR' && age >= 30) return 1.6;
        if (pos === 'TE' && age >= 31) return 1.5;
        if (pos === 'QB' && age >= 36) return 1.6;
        return 0;
      }
      if (pos === 'RB') return c((age - 25) * 0.8, 0, 3.2);
      if (pos === 'WR') return c((age - 27) * 0.55, 0, 2.4);
      if (pos === 'TE') return c((age - 28) * 0.5, 0, 2.2);
      if (pos === 'QB') return c((age - 32) * 0.5, 0, 2.2);
      return 0;
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(stats) }),
  };
  sandbox.window = sandbox;
  sandbox.VaultDurability = { ensure: () => Promise.resolve(null), priorRisk: () => 0, ready: () => true };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: 'vaultgrades-inline' });
  return sandbox;
}

// ── a stand-in market universe ─────────────────────────────────────────
// In the app this comes from MyRankings.marketUniverse (FantasyCalc order).
// FC values are fetched at runtime and aren't in the repo, so rank by season
// points instead — we're testing the FORMULA and the POOL rule, not FC's
// opinion. Shape matches marketUniverse exactly.
function buildUniverse(stats, limit) {
  const arr = [];
  for (const n in stats) {
    const e = stats[n];
    if (!e || !e.season || !['QB', 'RB', 'WR', 'TE'].includes(e.pos)) continue;
    arr.push({ name: n, pos: e.pos, team: e.team, age: 26, _pts: e.season.total_pts || 0 });
  }
  arr.sort((a, b) => b._pts - a._pts);
  const pc = {};
  return arr.slice(0, limit).map((p, i) => ({
    name: p.name, pos: p.pos, team: p.team, age: p.age,
    ovrRank: i + 1, posRank: (pc[p.pos] = (pc[p.pos] || 0) + 1),
  }));
}

const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const factorAvg = (map, key) => { const v = []; for (const [, f] of map) v.push(f[key]); return avg(v); };

async function main() {
  if (!fs.existsSync(STATS)) { console.error(`missing ${STATS} — run the nflverse workflow first`); process.exit(1); }
  const stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
  const sb = loadEngine(stats);
  await sb.VaultGrades.ensure();
  const VG = sb.VaultGrades;
  const norm = sb.normName;

  let UNIVERSE = buildUniverse(stats, 400);
  sb.MyRankings = { marketUniverse: () => UNIVERSE };
  const all = () => UNIVERSE.map(p => ({ name: p.name, pos: p.pos }));

  console.log('\nVAULT · grade-math regression');
  console.log(`engine: index.html <script id="vaultgrades-inline">`);
  console.log(`stats : data/nflverse_stats.json (${Object.keys(stats).length} players)`);
  console.log(`market universe: ${UNIVERSE.length}\n`);

  // ── 1. engine is reachable and grades ────────────────────────────────
  console.log('engine');
  check('VaultGrades exposes gradesFor + factorsFor',
    typeof VG.gradesFor === 'function' && typeof VG.factorsFor === 'function');
  const base = VG.gradesFor(all(), { dynasty: true, ppr: 1, teams: 12 });
  check('grades the full market universe', base && base.size > 200, `${base ? base.size : 0} graded`);

  // ── 2. the ceiling term is LIVE (guards the s.ceil/s.ceiling typo) ───
  console.log('\npools — is the ceiling term actually wired?');
  // The original defect: the stat map emits `ceiling`, one reader asked for
  // `ceil`, every ceiling pool came back empty, and pctRank fell back to its
  // 0.5 default for everyone — silently freezing 34% of the Upside weight at a
  // constant. Nothing threw and Upside still *varied* (via boom% and ppg), so a
  // "does Upside vary?" check sails right past it. The only honest test is to
  // move a player's ceiling and NOTHING else, then demand Upside responds.
  //
  // ppg / boom / bust / games all come from the season block; only `ceil` is
  // derived from the weekly log. So re-shaping weeks isolates the ceiling term.
  const victimName = Object.keys(stats).find(n => {
    const e = stats[n];
    return e && e.season && e.pos === 'WR' && (e.weeks || []).length >= 8 && (e.season.games || 0) >= 8;
  });
  if (!victimName) {
    check('found a player to probe the ceiling term', false, 'no WR with >= 8 weekly rows');
  } else {
    const reshape = (weeks) => {
      const s = JSON.parse(JSON.stringify(stats));
      s[victimName].weeks = weeks.map(p => ({ pts: p }));
      return s;
    };
    const flat  = reshape(Array(12).fill(10));                       // ceiling == 10
    const spiky = reshape([0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 45, 50]);  // ceiling ~45
    const gradeVictim = async (st) => {
      const s2 = loadEngine(st);
      await s2.VaultGrades.ensure();
      s2.MyRankings = { marketUniverse: () => UNIVERSE };
      const g = s2.VaultGrades.gradesFor([{ name: victimName, pos: 'WR' }], { dynasty: false, ppr: 1, teams: 12 });
      return g.get(norm(victimName));
    };
    const fFlat = await gradeVictim(flat);
    const fSpiky = await gradeVictim(spiky);
    check('Upside responds to ceiling alone (ceiling pool is live)',
      !!fFlat && !!fSpiky && fSpiky.upside > fFlat.upside,
      `${victimName}: flat-weeks upside=${fFlat && fFlat.upside} vs spiky-weeks upside=${fSpiky && fSpiky.upside}`);
  }

  // ── 3. no NaN / out of range, across every ctx permutation ───────────
  console.log('\nranges (all ctx permutations)');
  let graded = 0; const bad = [];
  for (const dynasty of [true, false])
    for (const ppr of [0, 0.5, 1])
      for (const rosterNeed of [null, 0, 1])
        for (const superflex of [false, true]) {
          const g = VG.gradesFor(all(), { dynasty, ppr, rosterNeed, superflex, teams: 12, why: true });
          for (const [k, f] of g) {
            graded++;
            for (const key of ['upside', 'floor', 'risk', 'situational']) {
              const v = f[key];
              if (typeof v !== 'number' || Number.isNaN(v)) bad.push(`NaN ${key} ${k}`);
              else if (v < 0 || v > 10) bad.push(`${key}=${v} out of 0-10 for ${k}`);
            }
            if (Number.isNaN(f.composite)) bad.push(`NaN composite ${k}`);
            if (!f.why || !f.why.upside || !f.why.situational) bad.push(`missing why for ${k}`);
          }
        }
  check('no NaN / out-of-range / missing tooltip', bad.length === 0,
    `${graded} grades checked${bad.length ? `; first: ${bad[0]}` : ''}`);

  // ── 4. Upside/Floor/Risk are INTRINSIC (league ctx must not touch them) ──
  console.log('\nleague-independence (the reason grades match across surfaces)');
  const ref = VG.gradesFor(all(), { dynasty: true, ppr: 1, teams: 12 });
  const variants = [
    ['rosterNeed', { dynasty: true, ppr: 1, teams: 12, rosterNeed: 1 }],
    ['superflex',  { dynasty: true, ppr: 1, teams: 12, superflex: true }],
    ['teams=10',   { dynasty: true, ppr: 1, teams: 10 }],
    ['ppr=0',      { dynasty: true, ppr: 0, teams: 12 }],
  ];
  for (const [label, ctx] of variants) {
    const g = VG.gradesFor(all(), ctx);
    let same = 0, n = 0, sitMoved = 0;
    for (const [k, f] of g) {
      const r = ref.get(k); if (!r) continue; n++;
      if (r.upside === f.upside && r.floor === f.floor && r.risk === f.risk) same++;
      if (r.situational !== f.situational) sitMoved++;
    }
    check(`ctx.${label} leaves Upside/Floor/Risk untouched`, same === n, `${same}/${n}`);
    if (label !== 'teams=10') check(`ctx.${label} does move Situational`, sitMoved > 0, `${sitMoved} changed`);
  }

  // ── 5. pins can't move a grade: the pool is the market, not the caller ──
  console.log('\npool is the market universe (pins cannot restate a grade)');
  const subset = all().slice(0, 25);
  const gSub = VG.gradesFor(subset, { dynasty: true, ppr: 1, teams: 12 });
  let subSame = 0;
  for (const [k, f] of gSub) {
    const r = ref.get(k);
    if (r && r.upside === f.upside && r.floor === f.floor && r.risk === f.risk && r.situational === f.situational) subSame++;
  }
  check('grading a 25-player subset yields identical grades', subSame === gSub.size,
    `${subSame}/${gSub.size} — pool ignores which players you ask for`);

  // ── 6. half-PPR is its own tier ──────────────────────────────────────
  console.log('\nscoring tiers');
  const rbs = UNIVERSE.filter(p => p.pos === 'RB').slice(0, 40).map(p => ({ name: p.name, pos: p.pos }));
  const rbSit = ppr => factorAvg(VG.gradesFor(rbs, { dynasty: false, ppr, teams: 12 }), 'situational');
  const [sStd, sHalf, sFull] = [rbSit(0), rbSit(0.5), rbSit(1)];
  check('half-PPR is distinct from both std and full', sHalf !== sStd && sHalf !== sFull,
    `std=${fmt(sStd)} half=${fmt(sHalf)} full=${fmt(sFull)}`);
  check('half-PPR sits between std and full', sHalf >= Math.min(sStd, sFull) && sHalf <= Math.max(sStd, sFull),
    `std=${fmt(sStd)} half=${fmt(sHalf)} full=${fmt(sFull)}`);

  // ── 7. pass-catching RB bonus is wired ───────────────────────────────
  const catchers = UNIVERSE.filter(p => {
    const e = stats[p.name];
    return p.pos === 'RB' && e && e.season && (e.season.avg_tgt || 0) >= 4;
  }).map(p => ({ name: p.name, pos: 'RB' }));
  if (catchers.length) {
    const pprSit = factorAvg(VG.gradesFor(catchers, { dynasty: false, ppr: 1, teams: 12 }), 'situational');
    const stdSit = factorAvg(VG.gradesFor(catchers, { dynasty: false, ppr: 0, teams: 12 }), 'situational');
    check('pass-catching RBs score higher once receptions count', pprSit > stdSit,
      `PPR=${fmt(pprSit)} vs STD=${fmt(stdSit)} over ${catchers.length} RBs`);
  } else {
    check('found pass-catching RBs to test', false, 'none with avg_tgt >= 4');
  }

  // ── 8. no-data players: +0.6 baseline uncertainty, applied uniformly ──
  console.log('\nno-data (rookie / no recent tape) path');
  const ghost = VG.gradesFor([{ name: '__NoSuchPlayer__', pos: 'RB', ovrRank: 200 }],
                             { dynasty: false, ppr: 1, teams: 12 });
  const gf = ghost.get(norm('__NoSuchPlayer__'));
  check('an unknown player still grades', !!gf && gf.hasData === false);
  // risk = 5.2 - clamp((60-min(60,200))/60*1.6, 0, 1.6) + 0.6 baseline = 5.8 → 6
  check('no-data risk carries the +0.6 baseline', !!gf && gf.risk === 6, gf ? `risk=${gf.risk}` : 'n/a');
  // early market rank ⇒ better no-data grade than a late one
  const early = VG.gradesFor([{ name: '__Early__', pos: 'RB', ovrRank: 5 }], { dynasty: false, ppr: 1, teams: 12 }).get(norm('__Early__'));
  const late  = VG.gradesFor([{ name: '__Late__',  pos: 'RB', ovrRank: 300 }], { dynasty: false, ppr: 1, teams: 12 }).get(norm('__Late__'));
  check('no-data upside tracks market rank', early.upside > late.upside,
    `rank5 upside=${early.upside} vs rank300 upside=${late.upside}`);

  // ── 9. the pool rule itself: a wider pool inflates mediocre players ───
  console.log('\npool rule (why we grade against the draftable market)');
  const midTE = UNIVERSE.filter(p => p.pos === 'TE').slice(30, 45).map(p => ({ name: p.name, pos: 'TE' }));
  const tightAvg = factorAvg(VG.gradesFor(midTE, { dynasty: false, ppr: 1, teams: 12 }), 'upside');
  UNIVERSE = buildUniverse(stats, 1200);              // pad with undraftable depth
  VG.gradesFor([{ name: UNIVERSE[0].name, pos: UNIVERSE[0].pos }], { dynasty: false, ppr: 1, teams: 12 }); // force pool rebuild
  const wideAvg = factorAvg(VG.gradesFor(midTE, { dynasty: false, ppr: 1, teams: 12 }), 'upside');
  UNIVERSE = buildUniverse(stats, 400);
  check('a wider all-stats pool would inflate mediocre players', wideAvg > tightAvg,
    `market pool upside=${fmt(tightAvg)} vs all-stats pool=${fmt(wideAvg)} — the inflation we removed`);

  // ── report ───────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  if (failures.length) {
    console.log(`FAILED — ${failures.length} check(s), ${passed} passed\n`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`PASSED — ${passed} checks, ${graded.toLocaleString()} grades exercised\n`);
}

main().catch(e => { console.error('\nharness error:', e && e.stack || e); process.exit(1); });
