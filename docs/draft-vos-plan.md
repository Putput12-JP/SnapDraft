# Value Over Slot — the real draft grade

**Status:** scoped, not built. 2026-07-21.

## Why

Vault renders three different numbers as letter grades, and none of them
actually answers "how well did this manager draft."

| Surface | Function | Measures | Fails as a draft grade because |
|---|---|---|---|
| League → Grades | `renderGradesView` (index.html:31882) | Roster market value, league-relative | Grades the draft slot as much as the decisions. The 1.01 team wins a startup on value even if it drafted identically well. |
| Draft board team column | `_bdTeamAgg` (index.html:14498) via `dvPickScore` (index.html:10884) | Mean of per-pick 0–10 ADP-beat scores | Unweighted mean. A 40-pick steal in round 14 counts the same as a 4-pick miss in round 1. This is why Putput reads `B- 5.7` on the board while holding the league's #1 roster. |
| Draft cockpit card | `dvTeamGrade` (index.html:10812) | Absolute 4-factor quality of the 9-man starting lineup | Not a draft measure at all — reads identically for a roster assembled entirely by trade. |

## The measure

For every pick, compare the market value of the player taken against the
value the consensus expected to be available at that overall pick number:

```
VOS(team) = Σ over the team's picks [ value(playerTaken) − baseline(overallPickNo) ]
```

Properties that make this the honest one:

- **Slot-neutral.** Every seat starts at zero expected surplus, so 1.01 and
  1.12 are on the same footing. It grades decisions, not the draw.
- **Correctly weighted, for free.** Denominated in value points, so a round-1
  error costs ~8× a round-14 error without anyone hand-tuning weights. This is
  the exact defect in the current board average.
- **Additive and auditable.** The team total decomposes into the individual
  picks that produced it. You can name the three picks that made the draft.
- **Falsifiable.** Swap `value()` for next-season actual production and the
  same equation becomes the retrospective grade.

## The baseline curve

`baseline(n)` = expected market value of the player available at overall pick
`n` under consensus.

Build it from data already in the app:

1. Take the ADP universe for the active bucket. `_adpSyncToValueMode`
   (index.html:21048) already loads the right file per dynasty/redraft/SF and
   populates `ADP_DATA` / `ADP_LOOKUP`.
2. Sort by ADP ascending. Read `getPlayerValue(name)` (index.html:15557) at
   each position to get raw (adp, value) pairs.
3. Smooth. The raw curve is noisy at the top (a handful of players carry huge
   value gaps) and near-flat in the late rounds. A monotone fit — log-linear on
   value vs. pick, or a rolling median over a ~10-pick window — is enough.
   It must be **non-increasing**; a baseline that ticks up would hand out free
   surplus for picking later.
4. Cache per (format, teams, valueSource). Invalidate on the same signals
   `_dvFactorsSig` (index.html:10705) already watches.

**Superflex matters here.** In SF the QB curve is a different shape entirely,
and `_adpSyncToValueMode` already picks the SF ADP file for SF dynasty. The
baseline must be built from the same file the board is showing, or QBs will
look like systematic steals or reaches league-wide.

## Wiring

`_bdTeamAgg` (index.html:14498) already walks every pick with correct
traded-pick attribution (`pk.ownerIdx` credits the drafter, not the original
slot) — that attribution is the fiddly part and it's done. The change is the
accumulator:

```js
// now:  a.sum += g.s; a.n++;           → mean of 0-10 scores
// vos:  a.vos += value(pk.name) - baseline(pk.pickNo);
```

Keep `dvPickScore` as-is. It's a good *per-pick* narrative ("4-pick reach vs
his price") and it feeds the existing hover tooltips. VOS is the team-level
rollup that replaces the mean.

Grade the 12 VOS totals on a z-score across the league. Unlike min-max it
isn't forced to emit an A+ and an F — a league that drafted uniformly well
should show a cluster of B's, which is the true answer.

## Scope boundary

VOS grades **agreement with consensus at draft time**, not truth. If the
manager is right and the market is wrong, VOS punishes them until reality
catches up. Per `project_redraft_projection_backtest`, strategy edges don't
persist year to year — so this ships as a **process** grade and must never be
labeled or sold as a predicted outcome.

## Naming

Three scales in three places, all currently called "grade." Rename so each
says what it measures:

- **Roster** — value held, league-relative (League → Grades)
- **Draft** — VOS, slot-adjusted (board column + cockpit)
- **Lineup** — absolute starter quality (4-factor card)

## Done first

Shipped in 98f9118: `renderGradesView` was seeding its min-max with 0 instead
of the worst team, so "league-relative" meant "your value ÷ the best team's
value" and every team in a dynasty league graded A+/A/A-.
