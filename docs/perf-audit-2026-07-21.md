# Vault Fantasy — performance audit, 2026-07-21

Method: profiled the live app (localhost, Sleeper user `Putput`, real league data,
400-player board) rather than reading for smells. Every number below is measured,
and every fix was A/B'd against the committed `HEAD` build serving identical output.

## The headline

`renderList()` was the whole problem. Measured on the draft board:

| renderer | before | after |
|---|---|---|
| **renderList (desktop)** | **107.2 ms** | **39.9 ms** |
| **renderList (mobile)** | **~112 ms** | **~26 ms** |
| renderBoard, renderStrip, renderRoster, renderSuggestions, renderDraftSummary, dvRenderDraftControl | ~0 ms | ~0 ms |

Output is byte-identical before/after: 400 rows, 391 player rows, 9 tier breaks,
11,201 DOM nodes desktop / 5,700 mobile.

Why it caused *live* stutter specifically: every Sleeper poll ends in `renderAll()`,
which fans out to all eight renderers inside a single `requestAnimationFrame`.
The sync cadence is 1.5–4 s (`getSyncInterval`), so during a live draft the main
thread was blocked for >100 ms — about 6 dropped frames — every few seconds.

## What was actually burning the time

Instrumented call counts for one 111 ms render:

| function | calls | ms | share |
|---|---|---|---|
| `MyRankings.getRankInfo` | 638 | 49.1 | 44% |
| `dvComputeFactors` (via `dvBuildFactors`) | 319 | 22.8 | 20% |
| `innerHTML` insert | — | ~12 | 11% |
| ~15k other helper calls | 15,000+ | ~5.7 | 5% |

Sorting was never the issue — `sortedPlayers()` measured 0.2 ms.

## Fixes applied

**1. `fcSig()` memoisation — the big one** (`MyRankings.maybeRebuild`)

`maybeRebuild()` ran on *every* `getRankInfo()` call. It calls `fcSig()`, which does
two `Object.keys()` allocations over ~900- and ~400-key objects plus `_dvIsSuperflex()`
detection — 15.7 ms + 18.8 ms per 638 calls. None of its inputs can change inside one
synchronous render, so it now computes once per task and clears on the microtask
boundary. Async data landing still rebuilds on the next tick, so self-healing is intact.

`getRankInfo` 638 calls: **44.2 ms → 0.2 ms.**

**2. `dvBuildFactors()` result caching**

The comment said "cheap enough to rebuild each render" — it was 23–28 ms. Only
`situational` tracks the live roster; upside/floor/risk are static. Now keyed on a
signature of everything `factorsFor` actually reads (player count, an `r0` fingerprint
to catch rankings reloads, grade readiness, dynasty/superflex/PPR/teams, roster needs).

**28.5 ms → 0 ms** on unchanged renders.

**3. Build only the visible row variant** (`renderList`)

The map built *both* the desktop `<tr>` and the mobile card for all 400 players, then
threw half away. An existing comment already flagged the DOM cost but the template cost
remained. Rows now carry a single `html` field, and tier-break detection uses an explicit
`tb` flag instead of three `String.includes('tier-break-row')` scans per row.

**4. `my-col` sort decorate-sort-undecorate** (`sortedPlayers`)

The "Mine" comparator ran up to two `getRankInfo` lookups *per comparison* — O(n log n)
lookups, ~3,500 for 400 players. Now uses the `bySortedKey` helper already present in the
same function. Verified: ranks come out 1,2,3…15 ascending, 0.6 ms.

**5. Duplicate-GET collapsing** (new `vf-fetch-dedupe` script)

In-flight dedupe for all GETs, plus a 5 s TTL for static feeds only (RosterAudit
rankings, FantasyCalc values, `state/nfl`, `/data/nflverse_*`, `/data/adp_*`).
Everything the app *writes* to — rosters, matchups, lineups, waivers, trades — gets
in-flight dedupe only, which can never serve stale data because it just shares a request
already in the air. `window.vfInvalidateFetch(substr)` is exposed for forced refresh.

Clean load: **122 → 115 requests.** Modest, because the root cause is structural (below).

## Not fixed — recommendations

**A. No single source of truth for league data** — this is the real cause of the request
duplication. `league/{id}/rosters` and `/users` are fetched from ~12 independent call
sites (`index.html` lines 13217, 13317, 14803, 15351, 18877, 19135, 19908, 20196, 25476,
29725, 30099, 30203). On a clean load `rosters` was hit 6× and `users` 4×. A small
`VaultLeagueData.get(lid)` cache would remove the rest and is a better fix than my
network shim. Worth doing.

**B. The board renders all 400 rows** — remaining ~40 ms is now ~20 ms DOM insert +
~15 ms template building, both linear in row count. Virtualising or windowing the list
is the only way past that, but it changes scroll/search behaviour, so it's your call.

**C. `index.html` is 3.1 MB / 37,300 lines** — one file, 27 inline scripts, 1,033
functions. GitHub Pages gzips it so the wire cost is fine, but parse/compile is real on
mid-range mobile. Splitting the draft-board code into a deferred module would help
first paint. Big job; flagging, not recommending urgency.

**D. `getPlayerValue` is called 11× per row and `getFCValue` 12× per row** (4,428 and
4,747 calls). They're fast individually now (2.5 ms and 1.0 ms total) so this is minor,
but a per-row memo would trim a few ms.

**E. Pre-existing cosmetic bug** — tier-break rows use `colspan="7"` but the table has
13 columns, so the tier divider stops short of the grade columns. Visible in the
screenshot; unrelated to these changes.

**F. Paint is clean, don't chase it.** The earlier backdrop-filter work held up: on the
draft page only fixed overlays and a handful of chips still have live `backdrop-filter`,
and only 50 in-flow elements have box-shadow. The stutter was never paint-bound.

**G. Fonts** — 9 files / 297 KB load eagerly, but all six Archivo weights are genuinely
used (700 × 680, 600 × 297, 800 × 262, 500 × 58, 900 × 26, 400 × 19). No safe cut.

## Verification

- 27 inline scripts, 0 syntax errors.
- All five pages (draft, teams, research, portfolio, visual) render, no console errors.
- Desktop and mobile board screenshotted — headshots, values, MINE deltas, all four
  grade columns, tier breaks correct in both.
- Diff: 117 insertions, 22 deletions, all in `index.html`.
