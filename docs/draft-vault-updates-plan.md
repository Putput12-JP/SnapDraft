# Draft Vault updates — plan (2026-07-27)

> **STATUS: all 7 shipped to `index.html` 2026-07-27, verified, not yet committed.**
> Verification results are recorded inline per item below.
> Label format resolved: **both** — `1.01` top-left, `#20` top-right (see item 1).

Every finding below was reproduced live at `localhost:4173` with Sleeper user **Putput**
and the completed 12-team / 16-round **Early Birds - X** draft connected
(`draft_id 1369311197354016768`, 192 picks, `myTeam = 6`).

## What shipped

| # | Item | Result |
|---|---|---|
| 1 | Board pick numbers | `1.01 RB` top-left · `#1 B` top-right; 0 overflow across all 192 cells incl. `16.04 / #184` |
| 2 | Grade Keys per format | Toggle now moves grades (Henry `[7,9,6,4]` dyn vs `[7,8,5,4]` rdr) |
| 3 | Mine sort | 0 unranked above a ranked player, both formats; unranked ordered by dynasty rank |
| 4 | Pick-grade sort | A/A/A- first, `–` last; 37ms render, one shared grade build (321 calls, not 642) |
| 5 | Header factor strip | Factor icons + values on one row, type scales 11→17px; pulses only on real change (0 anims on idle repaint) |
| 6 | Post-draft recap | Ring + letter + count-up + chips + best/toughest pick, all verified via `getAnimations()` |
| 7 | Kenneth Walker | pid `4634 → 8151`; `hasData:false → true`; board no-photo cells `35 → 0` |

Extra fixes found while implementing:
- `PLAYER_IDS["Patrick Mahomes II"]` pointed at pid **4358 = Austin Duke**, an unrostered
  WR. Corrected to 4046 and the whole table now sits behind the ranked map.
- `PICK_SLOTS` labels are unpadded (`1.1`) while `_dvPickStr` pads (`1.01`) — once filled
  cells printed a slot, filled and empty cells in the same column disagreed. Added
  `_dvPadSlot` and applied it to the empty cell, the filled fallback, and the mobile card.
- Five more duplicate-name pids now resolve to the active player: Jacoby Jones, Frank Gore,
  Kyle Williams, Brandon Johnson, Antonio Williams.

Deliberately **not** done:
- The Waiver Command phantom-FA name workaround at `index.html:20038` is left in place. It
  is now redundant but harmless, and removing it is riskier than keeping it.
- **Floor** is still format-blind (see item 2). It changes numbers rather than fixing a
  wiring bug, so it stays a separate decision.
- The remaining ~20 `sleeperPlayerMap[...]?.player_id` read sites are untouched. The three
  that resolve a pid for display or for a Sleeper write (`_pidByName`,
  `getPlayerHeadshotUrl`, `rpAvatarHtml`, `openPlayerStats`, the board avatar) now route
  through `vaultPidFor`.

---

## 1. Board cell numbers → pick number

**Now:** [index.html:14887](../index.html) renders `<span class="bc-pick">#${pk.r0}</span>`
— `r0` is the player's **overall board rank**, not anything about the pick. Verified: the
1.01 cell (Gibbs) reads `#3`, the 1.02 cell (Bijan) reads `#1`. That is why the number
looks like nothing.

**Data already present:** `pickLookup[key].pickNo` carries Sleeper's real `pick_no`
(verified `Gibbs → 1`, `Bijan → 2`, `Kenneth Walker → 2.08 / 20`), and manual picks get
`pickNo` derived from the slot label at [index.html:14815](../index.html). Nothing new to fetch.

**Change:** swap `#${pk.r0}` for the pick label built from `pickNo`.

Format decision — two defensible readings, see the question at the end:
- **`1.01`** (`_dvPickStr(pk.pickNo, NUM_TEAMS)`) — matches the vocabulary the rest of
  Vault already uses for a pick: the empty cell's own `bc-round` label, the mobile card's
  `.bm-slot`, the ADP column, and the pick-grade tooltip ("Walker at 2.08"). Filled and
  empty cells would finally read the same way. Round digit is redundant with the row.
- **`#20`** (overall) — the literal "pick number", and the only non-redundant number in a
  grid that already encodes round as the row and team as the column.

Either way the player's rank moves into the cell's hover `title` so it isn't lost.

**Mobile:** `renderBoardMobile` ([index.html:14939](../index.html), :14953) already shows
`.bm-slot` = `1.01` **and** `.bm-rank` = `#3`. If desktop goes to `1.01`, mobile needs no
change. If desktop goes to `#20`, `.bm-rank` should become the overall pick too so the two
surfaces don't disagree.

CSS: `.bc-pick` ([index.html:998](../index.html)) is a 9px mono span in a 92px cell —
`1.01` and `#20` both fit the footprint `#46` occupies today. No layout work.

---

## 2. Should Grade Keys differ for Redraft vs Dynasty?

**Yes — and they already do, partially. But the Draft Vault feeds the engine the wrong
format signal, so today the toggle does nothing.**

### What the engine already varies by format (`computeFactors`, [index.html:24360](../index.html))

| Factor | Dynasty | Redraft |
|---|---|---|
| **Upside** | age/runway term, youth ↑ age ↓ (`(25−age)*0.03`) | flat +0.06 if ≤24 |
| **Risk** | `vaultAgeRisk` ramps continuously from RB 25 / WR 27 / TE 28 / QB 32 | hard cliffs only: RB 27→29, WR 30, TE 31, QB 36 |
| **Situational** | offense 0.12, need/scarcity 0.48 | offense 0.28, need/scarcity 0.38 |
| **Percentile pool** | separate `poolFor('dynasty')` | separate `poolFor('redraft')` |
| **Floor** | *identical* | *identical* |

Measured effect where it is wired (Derrick Henry, `[upside, floor, risk, situational]`):
redraft `7 / 8 / 5 / 5` vs dynasty `6 / 9 / 6 / 5`. So the format split is real and
material — it just never reaches the board.

### The bug

`_dvGradeCtx()` ([index.html:10948](../index.html)) reads `window._draftIsDynasty`, which is
set at [index.html:9664](../index.html) from **`rounds >= 15`**. Early Birds is a `type: 0`
**redraft** league with 16 rounds → `_draftIsDynasty === true`. Its Grade Keys are dynasty
grades.

Worse, flipping the toolbar Dynasty/Redraft toggle changes values, ADP and My Rankings but
**not** the grades. Verified: `_dvMode = 'dynasty'` and `_dvMode = 'redraft'` both return
Henry `[6, 9, 6, 4]`. Two reasons:
1. `_dvGradeCtx` never looks at `_dvMode`.
2. `_dvFactorsSig()` ([index.html:10977](../index.html)) doesn't include `_dvMode`, so even a
   fixed ctx would be served the stale cached index.

The grade-key legend copy already *promises* this ("**Dynasty boards** credit youth more…",
[index.html:5686](../index.html)), so the UI is currently lying.

### Fix

1. `_dvGradeCtx().dynasty` → `window._dvMode ? window._dvMode !== 'redraft' : !!window._draftIsDynasty`.
   This is exactly the precedence the FantasyCalc value context already uses at
   [index.html:15689](../index.html) — one signal for the whole page.
2. Add `window._dvMode` to `_dvFactorsSig()` so flipping the toggle invalidates the index.
3. `_dvAutoMode()` ([index.html:12175](../index.html)) already has the good cascade
   (draft name/type regex → `_isDynastyLeague(lg)` on `settings.type` → `rounds >= 15` last),
   so routing through `_dvMode` also fixes the Early Birds misdetection for free.

**Optional, separate judgement call:** make **Floor** format-aware too — it's the one factor
that is identical in both, and availability (`games/17`) should arguably carry more weight in
redraft, where a missed month ends the season, than in dynasty. I'd hold this until (1)-(3)
ship, since it changes numbers rather than fixing a wiring bug.

---

## 3. "Mine" sort puts unranked players ahead of ranked ones

**Confirmed, and it is redraft-only.**

`sortKey === 'my-col'` ([index.html:13903](../index.html)):

```js
let mi = MyRankings.getRankInfo(n, f);
if (!mi) mi = MyRankings.getRankInfo(n, 'dynasty');  // ← the bug
return mi ? mi.myRank : 99999;
```

FantasyCalc's 1QB redraft endpoint prices far fewer players than its dynasty one:
**redraft board = 200 rows, dynasty board = 399**, against 328 non-pick players on the Vault
board. So in redraft, **128 players have no redraft rank** and fall through to a *dynasty*
rank in the 1–399 range, which interleaves them straight through the middle of the board
instead of parking them at the end.

Reproduced (redraft, sorted by Mine):

```
114: k=117  Jayden Reed (WR)
115: k=118  Ty Simpson (QB)   ← NO REDRAFT RANK
116: k=118  Oronde Gadsden (TE)
...
135: k=136  Michael Penix (QB) ← NO REDRAFT RANK
```

Ty Simpson, a rookie QB with no redraft price, sits at #118 ahead of ~85 players who *do*
have a redraft rank. And the MINE **column** ([index.html:14224](../index.html)) does *not*
do the dynasty fallback — it renders `—` — so the user sees a dash-ranked player sitting
above ranked ones. That is precisely the reported symptom.

Dynasty mode is fine: unmatched players resolve to `99999` and land at the bottom
(first fallback appears at position 310 of 328).

**Fix:** keep the fallback only as a data-not-loaded escape hatch, and otherwise push
unranked below every ranked player while preserving a sensible order among themselves:

```js
// unranked in the ACTIVE format → below every ranked player, ordered by the
// dynasty board so the deep end doesn't collapse into insertion order
const rdrLen = <active-format board length>;
k = direct ? mi.myRank : rdrLen + (dynastyRank || 99999);
```

Only fall back wholesale to the dynasty board when the active-format board is *empty*
(the cold-load case the original fallback was written for).

---

## 4. Sort by pick grade

The **PG** column already exists (`td-pg`, [index.html:14266](../index.html)) with its header
`#hdr-pgrade` at [index.html:5716](../index.html) — the header simply has no `onclick`. None
of the four factor columns are sortable either.

**Change:**
1. Give `#hdr-pgrade` `class="fhdr col-hdr-sortable"`, an `onclick="setSort('pg-col')"`, and
   an `<span class="sort-ind" id="ind-pg">↕</span>`.
2. Add `'pg'` to the list in `updateColumnHdrIndicators` ([index.html:11967](../index.html)).
3. New branch in `sortedPlayers()`: `bySortedKey(p => -(pickGrade(p)?.s ?? -1), 1)` so best
   grade first and ungradeable players (`K`/`DEF`/picks/no-ADP) sink to the bottom rather
   than sorting as a 0.
4. Add the chip to the mobile sort bars (`#pm-sortbar`, `#plist-mobile-sort`).

**Perf:** `dvPickScore` over all 400 players measured **2.4 ms** (321 gradeable) against a
48 ms `renderList`, so cost is not the issue — but the row render already computes the same
score per row, so I'll build the map **once per render** into `window._dvPickGrades` and have
both the sort and the PG cell read it. Doubling the work is the kind of thing that caused the
earlier live-draft stutter.

**Caveat worth stating in the UI:** pick grade is "the grade this player would earn *at your
next slot*", so it only exists mid-draft for available players. On a completed draft every
cell is `–` (visible in the current screenshot). Sorting by it on a finished board is a no-op;
I'll gate the header's sortable affordance on `nextSlot` existing.

---

## 5. Live Upside / Floor / Risk / Situational under the header Draft Grade

`dvTeamGrade()` ([index.html:11072](../index.html)) **already returns exactly this** — the
starter-weighted average of all four factors. Today it's buried in the card's `title`
attribute ([index.html:11107](../index.html)). Live values right now for Putput:

```
B · 82/100 · "Solid foundation" · 8 starters of 16
upside 6.6 · floor 7.6 · risk 4.4 · situational 5.0
```

**Change:** add a 4-chip micro-strip inside `#ds-grade-card`
([index.html:5494](../index.html)) beneath the `Draft Grade` label — each chip the factor's
existing icon + colour (`--te` / `--rb` / `--red` / `--wr`, matching `DVF_COL` and the Grade
Keys legend) and a one-decimal value, `data-tip` carrying the same plain-English text the
board cells use.

Room: measured the cell at **149 × 117 px** inside the 6-column grid
(`1.4fr .7fr .7fr .9fr 1.2fr 1.55fr`, [index.html:37430](../index.html)) — four ~32px chips
fit on one row. New CSS must land **after** the `dv-shadcn-restyle` block per `CLAUDE.md`,
and I'll check which of the three layered `#page-draft .dsc-stat` blocks actually wins before
writing anything.

**Live updating is free:** `dvUpdateGradeCard()` is already called from
`renderDraftSummary()` ([index.html:16805](../index.html)) on every sync poll. Values change
per pick because `situational` tracks your open starter slots.

Values animate on change with a short colour/opacity transition only — no transform on a
grid cell, no `--ease-spring` on anything that lays out.

---

## 6. Post-draft popup: draft grade, animated

The post-draft popup is `#draft-complete-modal` ([index.html:4219](../index.html)), shown by
`showDraftCompletePrompt()` ([index.html:14658](../index.html)) from `renderDraftSummary()`
when `isActiveDraftComplete()`. It fires both when a live draft finishes and when you
reconnect to a finished one, so it is the right surface.

**Everything needed is already computed:**
- `dvTeamGrade()` → `B`, `82/100`, `"Solid foundation"`, the 4 factors, `8` starters of `16`.
- `window._bdTeamAgg[myTeam]` → pick-by-pick rollup: `16` graded picks, best
  **Justin Herbert A+** (`+42` picks of value at 127), toughest **Xavier Worthy F**
  (`−35` reach at 103).

**Change:** insert a grade block between `.dc-modal-head` and `.dcp-choices` —

- Circular grade ring, reusing the existing `stroke-dasharray`/`stroke-dashoffset` pattern
  from [index.html:13026](../index.html), with the letter + score centred.
- The four factor chips from item 5, so the two surfaces tell one story.
- A `Best pick` / `Toughest pick` line from `_bdTeamAgg`.

**Animation, following the motion system in `CLAUDE.md`:**
- Ring sweeps 0 → score via `stroke-dashoffset` with `--ease-out`; **not** `--ease-spring`,
  which must stay on `transform` only.
- Letter pops in on `transform: scale()` with `--ease-spring` — that one *is* a transform.
- Score counts 0 → 82 and the factor chips count up, staggered ~60 ms apart.
- Flush the start state with a **forced reflow** (`void el.offsetWidth`), not `rAF` — a
  backgrounded tab never runs `rAF` and would strand the animation mid-flight, the same trap
  documented for `.rail-noanim` and `openPlayerStats()`.
- Count-up uses `rAF` for the intermediate frames only, with the final value written
  unconditionally so a throttled tab still lands on the right number. (There's a `.vf-count`
  helper at [index.html:31255](../index.html), but it's armed only on `ov-content` /
  `power-rankings`, so this needs its own small runner.)
- Full degradation in the existing `prefers-reduced-motion: reduce` block — final state, no
  motion.

**Readiness:** `showDraftCompletePrompt()` returns *before* `renderAll()`/`renderList()` run,
so `_dvFactors` and `VaultGrades` may not be warm on the very first paint. I'll render a
`.skel` placeholder in the grade block and repaint via `VaultGrades.onReady()` — a skeleton,
not a spinner, since the shape is known (per `CLAUDE.md`).

**Note:** `.dc-modal`'s width/padding rule is scoped to `#draft-connect-modal`
([index.html:22560](../index.html)), so this modal currently inherits generic `.modal`
sizing. I'll measure it before adding content rather than assuming 540px.

---

## 7. Kenneth Walker — two separate bugs, both confirmed

### 7a. Sleeper has two players named "Kenneth Walker", and Vault picks the wrong one

Straight from `api.sleeper.app/v1/players/nfl`:

| pid | pos | team | active | search_rank | years_exp |
|---|---|---|---|---|---|
| **4634** | WR | `null` | **false** | 9999999 | 5 |
| **8151** | RB | KC | true | **7** | 4 |

`_pidByName()` ([index.html:20071](../index.html)) builds a reverse index of
`globalPidToName` with `if (!m[nm]) m[nm] = pid` — **first wins** — and iterates the Sleeper
DB in its own order, where 4634 sits at index 4632 and 8151 at index 8110.

**Verified: `_pidByName('Kenneth Walker')` returns `4634`** — the retired, team-less WR.
(Controls: `Brandon Aiyuk → 6803`, `Travis Hunter → 12530`, both correct.)

That id is what `dvDraftFromBoard` posts to Sleeper from the board's **Draft** button
([index.html:14238](../index.html)), and what Waiver Command and the trade-comps lookup use.
There is already a **symptom patch** for this at [index.html:20038](../index.html) — a
name-based exclusion added because Walker was surfacing as a "phantom free agent" — but the
root cause was never fixed.

`sleeperPlayerMap[normName(name)].player_id` has the same shape of problem in its two writers
([index.html:10388](../index.html), [index.html:15938](../index.html)) — keyed on name,
last-write-wins, no eligibility check.

Scope: **36 duplicate names** across skill positions, **6 of which resolve to the wrong
player** under first-wins (Kenneth Walker, Jacoby Jones, Frank Gore, Kyle Williams, Brandon
Johnson, Antonio Williams). Walker is by far the most consequential — `search_rank 7`.

**Fix:** make name→pid resolution prefer the *real* player instead of the first one seen.
Rank candidates by `(active && team) → lowest search_rank → highest years_exp` and keep the
winner. Applied in one place so `_pidByName`, `sleeperPlayerMap` and `globalPidToName` all
agree, then remove the name-based phantom-FA workaround at :20038 once the root fix is
verified against Waiver Command.

### 7b. nflverse calls him "Kenneth Walker III", so his stats never join

`normName('Kenneth Walker') = 'kenneth walker'` but nflverse keys him
`'Kenneth Walker III'`. `vaultHeadshot`'s `_vhMap` ([index.html:6449](../index.html)) and
`VaultGrades`' `statsMap` ([index.html:24323](../index.html)) are both plain `normName`
lookups, so both miss.

**Consequence — verified.** A four-season starting RB is graded as a rookie with no data:

```
Kenneth Walker  → upside 4, floor 3, risk 5, situational 6, composite 4.7, hasData: FALSE
                  "estimated from market rank (~#46) — no recent stats yet"
Bijan Robinson  → upside 10, floor 8, risk 1, situational 9, composite 9.1, hasData: true
```

His board cell also renders the grey `RB` placeholder instead of a headshot (visible in the
board screenshot) — and it can't fall back to the Sleeper thumb either, because `PLAYERS`
(from RosterAudit) carries **no `sleeperId`** and `renderBoard` passes
`findPlayer(name)?.sleeperId` straight through.

**16 players hit this suffix mismatch, 6 inside the top 80:**

| Vault / FC name | nflverse name | board rank |
|---|---|---|
| Kenneth Walker | Kenneth Walker III | 46 |
| Harold Fannin | Harold Fannin Jr. | 64 |
| Luther Burden | Luther Burden III | 65 |
| Marvin Harrison | Marvin Harrison Jr. | 76 |
| Brian Thomas | Brian Thomas Jr. | 80 |
| Oronde Gadsden | Oronde Gadsden II | 120 |

plus Chris Godwin, Michael Penix, Tyrone Tracy, Chris Rodriguez, Efton Chism, Ollie Gordon,
Marvin Mims, Joe Milton, Theo Wease, LeQuint Allen — and Deebo Samuel (`Deebo Samuel Sr.`).

**The codebase already solved this once.** `_fuzzy()` ([index.html:6459](../index.html))
strips `Jr/Sr/II/III/IV` and retries — which is why `getNflversePlayer('Kenneth Walker')`
*does* return the right player while `vaultHeadshot` and `VaultGrades` don't. The join key is
the problem, not the data.

**Fix:** one canonical key helper (`normName` + suffix strip) used to *index* the nflverse
maps — build both `'kenneth walker iii'` and `'kenneth walker'` → same entry — so
`_vhMap`, `VaultGrades.statsMap` and `VaultDurability`'s history all resolve. Index the
canonical key alongside the exact key rather than replacing it, so no currently-working
lookup can regress.

Then add a nickname alias for the one non-suffix case, **Kenneth Gainwell ↔ Kenny Gainwell**.
The ADP builder already ships an `aka` field for exactly this class of drift
(`scripts/build_sleeper_adp.py:459`) but only between the two *Sleeper* spellings, never
against nflverse.

**Separately worth doing:** give `renderBoard`'s avatar a pid fallback
(`_pidByName` / `sleeperPlayerMap`) so the ~19 players genuinely absent from nflverse —
Travis Hunter, Carnell Tate, Brandon Aiyuk, Tank Dell and other rookies / missed-season
veterans — get a Sleeper thumb instead of a grey `RB` box. 35 of 192 board cells currently
have no photo; the suffix fix accounts for about half.

---

## Sequencing

1. **7a + 7b** first. Both are correctness bugs with blast radius beyond Draft Vault
   (grades, headshots, Sleeper writes), and 7b changes the grade numbers that items 4–6
   display — fixing it after would mean re-verifying those.
2. **2** — small wiring change, also moves grades.
3. **3**, **4** — independent sort work.
4. **1** — isolated.
5. **5**, then **6** — 6 reuses 5's factor chips.

## Verification

Per `CLAUDE.md`: reload against `.claude/launch.json`'s static server, cache-bust
`vault-ds.css` if it's touched (and bump the `?v=` on its `<link>`), load Sleeper user
**Putput**, reconnect the Early Birds draft and confirm at desktop + mobile widths before any
push. Specific checks:

- Board cells show a pick label matching Sleeper's own board for a traded pick.
- `Kenneth Walker` grades with `hasData: true` and shows a photo; `_pidByName` returns `8151`.
- Grade Keys change when the Dynasty/Redraft toggle flips.
- Mine sort in **redraft**: no `—`-ranked player above a ranked one.
- Pick-grade sort ordering matches the PG column, mid-draft.
- Header factor strip moves after a pick lands.
- Post-draft modal: confirm the ring/letter really animate by checking
  `el.getAnimations()` after a real open — final geometry being correct proves nothing, and
  the preview tab may not paint.

## Verified (2026-07-27)

Ran against a clean load, Putput + Early Birds, rewound to pick 90 for the live-draft states:

```
1_boardLabels            ["1.01 RB #1 B", "1.02 RB #2 B+"]
2_gradeKeysFollowFormat   true
3_mineSortClean           true
4_pickGradeSortTop        ["A", "A", "A-"]
5_headerFactorStrip       "U 6.4 F 7.1 R 4.1 S 5.4"
6_walkerHasData           true
7_walkerPid               "8151"
8_boardNoPhotoCount       0
9_mahomesPid              "4046"
```

Also checked: no console errors; onyx + light themes (tokens flip correctly, no hardcoded
hexes); 375px mobile with no horizontal overflow and the factor strip wrapping 2×2;
reduced-motion returns 0 animations with the ring already at its final offset and the score
at 82; the recap's skeleton path (4 shimmering placeholders → real content on
`VaultGrades.onReady`, `_dvrWaiting` reset).

## Follow-up revision — factor strip sizing (same day)

The first cut of item 5's strip was 9.5px letter-prefixed values (`U 6.4 …`). Revised on
request to be **much bigger, with the factor icons, on a single row**:

- The four `DVF_ICON` glyphs replace the `U/F/R/S` letters — same icons as the Grade Keys
  legend directly below and as the board's factor columns, so the reading never rests on
  colour alone (Upside's gold vs Risk's red is the pair most likely to be confused).
- One row, `flex-wrap:nowrap`. The type **scales** instead of wrapping:
  `clamp(11px, 1.05vw, 17px)`, with the icon at `1em` so the pair scales together.
- Grade column widened to `minmax(0, 1.45fr)` (from `.9fr`), taking width off Left/Drafted
  which hold a single 2-3 digit number. `minmax(0, …)` matters: a bare `fr` carries an auto
  minimum, so a 4-character value (**10.0** — a factor can max out) would widen the column
  and shove every other cell in the strip.
- That cell's side padding trimmed to 10px; the rest keep 20px.
- **Mobile (≤700px)**: the summary is a horizontal snap carousel whose cells are flex items
  still carrying the default `shrink:1` against `min-width:84px` — so the cell collapsed to
  84px and clipped the row. Fixed with `flex-shrink:0` on that one cell, sizing it to
  max-content (172px normal / 197px worst case) instead of hard-coding a width. Two traps
  here: `width:100%` on the row pins it to the collapsed cell rather than letting the cell
  grow, and the `align-items:center` rule for these cells is scoped `min-width:701px`, so
  mobile needed its own.

Fit verified at every width with **all four factors at 10.0** (the worst case), one row and
no clipping throughout:

| viewport | font | cell | worst-case headroom |
|---|---|---|---|
| 375 (mobile) | 11px | 197px | fits, `scrollWidth == clientWidth` |
| 1024 | 11px | 219px | 15px |
| 1280 | 13.4px | 284px | 43px |
| 1600 | 16.8px | 355px | 65px |

Recap variant (`.dvr-facs`) gets one row at 16px, dropping to 14px under 560px.

## Still to do

- Re-check Waiver Command against a league with an active wire, to confirm the pid fix
  didn't change its free-agent list before considering removal of the :20038 workaround.
- Pre-existing uncommitted work is **not** part of this push: `auth/` (incl. the new
  `vault-appcheck.js`), `functions/src/`, `login.html`, `trade-intel-*.html`, the concept
  mockups, `pm-cockpit/`, `skills-lock.json`. `scripts/__pycache__/` should be gitignored
  rather than committed.
