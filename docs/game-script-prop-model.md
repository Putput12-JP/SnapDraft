# Game-script term for the player-prop model

**Status:** Phase 1 BUILT, shipped DORMANT (`active:false`). Pipeline + all three
surfaces wired null-safe; the term does not move any projection until its gate
clears in-season and the flag is flipped. **Phase 2 foundation BUILT** (dormant):
`scripts/build_team_tendencies.py` → `data/team_tendencies.json`, the neutral
per-team fingerprint (pace, PROE, carry/target concentration) the script term will
bend from. Not yet wired into projections — see "Phase 2 progress" below.
**Owner surface:** `VaultPropModel` (`prop-model.js`, inline in `index.html`) +
`matchupAdj` (Edge Board) + `scripts/build_best_bets.mjs` (Best Bets builder).
**Builder:** `scripts/build_game_script.py` → `data/game_script_model.json`.

## What shipped (Phase 1)

- `scripts/build_game_script.py` fits `K_PASS`, `K_RUSH`, `SP_REF` from nflverse
  team game logs (Σ att / Σ car per team-game) joined to `games.csv` pregame
  `spread_line`, per team-season baseline SHARE removed to isolate MIX from the
  total (which `envMult` already carries). Leave-one-season-out holdout in the JSON.
- `scriptMult` wired into `VaultPropModel.fairProbOver` (inline + `prop-model.js`),
  `matchupAdj` (returns `scriptMult` + `spread`, with a `script <team spread> ×m`
  provenance chip), and `build_best_bets.mjs` (which also newly adopts opp + env,
  closing the hero/board divergence). Every reader falls back to `×1` when the file
  is absent OR `active:false`.

## Why it ships dormant

The fit is **directionally right but small**, and its hard gate can't run yet:

- Bucket table (holdout, 2014-2025): favorites ≥9 pass ×0.97 / rush ×1.03;
  moderate dogs pass ×1.01 / rush ×0.98; neutral ≈1.00. The rush effect is the
  clean one; the pass-VOLUME effect is weak and **reverses for extreme dogs**
  (dog ≥9 pass ×0.97) because a big underdog is confounded with getting blown out
  (fewer possessions, garbage time), not throwing more.
- Out-of-sample RMSE lift on the underlying quantity (attempt share) is ~0.1-0.2%
  — near zero, consistent with the market already pricing this well-known mix.
- The spec's hard gate ("don't ship if it doesn't beat the closing line") needs
  settled in-season prop picks to grade via the CLV loop; `bet_results.json` is
  empty at season kickoff, so that gate is currently un-runnable.

Given all three, activating live would violate the gate. It ships built, reviewed
and clamped (±10-12%) but inert, mirroring how the game model shipped as
gated-off context. **Activation = flip `active` to true once the settlement/CLV
loop confirms a real lift on large-spread volume props.**
**Related:** [prop-model.md](prop-model.md),
[prop-edge-model-plan.md](prop-edge-model-plan.md),
[edge-feedback-loop.md](edge-feedback-loop.md), [game-model.md](game-model.md).

## One-line summary

Today the environment adjustment scales **all** of a team's prop markets by one
direction-blind multiplier off implied team total. That is right on *scoring
volume* but wrong on *pass/rush mix*: it drags an underdog's passing props DOWN
when negative game script should push them UP. This task adds a **game-script
term** that skews pass-family vs rush-family volume in opposite directions off
the spread, fit from data, not hand-picked.

## The gap, precisely

`matchupAdj` (`index.html`) currently produces two multipliers on the base
projection:

```
oppMult  = clamp(fpa / leagueAvgFpa, 0.88, 1.15)          // opponent defense (DvP)
teamTotal = total/2 − spread/2                            // implied team total
envMult  = clamp(1 + 0.5·(teamTotal/22.5 − 1), 0.92, 1.10) // scoring environment
proj    *= oppMult · envMult · usageMult                  // prop-model.js:~40527
```

`envMult` is applied identically to `pass_yd`, `rush_yd`, `rec_yd`, `pass_att`,
`rush_att`, `rec`, … So:

- **Big underdog** → low `teamTotal` → `envMult < 1` → BOTH passing and rushing
  props pulled down. Reality: a trailing team throws MORE (attempts,
  completions, pass yards, WR targets/receptions rise) while rush volume falls.
  The current model gets the sign backwards on the passing side.
- **Big favorite** → high `teamTotal` → `envMult > 1` → everything up. Reality:
  late positive script means MORE rush volume, LESS pass volume in the 4th.

The magnitude channel (how much a team scores) is handled; the **distribution**
channel (how a team accumulates it, given who's ahead) is missing. That
distribution is exactly what "teams playing from behind pass more" means.

Two independent signals are being collapsed into one:

| Signal | Driver | Moves | Status |
|---|---|---|---|
| Scoring environment | implied team total (total + spread) | all markets, same sign | ✅ `envMult` |
| Game script (pass/rush mix) | spread magnitude + sign | pass vs rush, OPPOSITE signs | ❌ this task |

## Design

### 1. Script multiplier

Add a `scriptMult` alongside `envMult`, keyed by **market family** and driven by
the team's pregame spread (favorite = negative). Underdogs skew pass-up /
rush-down; favorites the reverse.

```
sp   = team pregame spread (cons)      // favorite < 0, dog > 0
s    = clamp(sp / SP_REF, −1, 1)       // normalize; SP_REF ≈ a "big" spread, e.g. 10
passScriptMult = clamp(1 + K_PASS · s, 0.90, 1.12)   // dog (s>0) → >1
rushScriptMult = clamp(1 + K_RUSH · (−s), 0.90, 1.12) // dog (s>0) → <1
```

`K_PASS`, `K_RUSH`, `SP_REF` are **fitted** (see §Fitting), not guessed —
consistent with how the trade market and season-sim bands were done
(`trade-market-model.md`, `season-sim-calibration`). Expected sign: `K_PASS>0`,
`K_RUSH>0`; expected magnitude small (a 10-point dog historically ~+8–12% pass
attempts, ~−12–18% rush attempts vs neutral).

### 2. Which markets get which family

The script term moves **volume**, which flows through to yards via the model's
volume×efficiency decomposition (`pass_yd`←att, `rush_yd`←car, `rec_yd`←tgt).

| Family | Markets | Multiplier |
|---|---|---|
| Pass volume | `pass_att`, `pass_cmp`, `pass_yd`, `rec`, `rec_yd`, `pass_td`, `rec_td` | `passScriptMult` |
| Rush volume | `rush_att`, `rush_yd` | `rushScriptMult` |

Notes:
- Receiving markets ride pass volume (a WR's targets rise with team pass
  attempts). But target *share* differs by role — a check-down back gains more
  from negative script than a deep WR. Phase 1 applies the family multiplier
  uniformly; Phase 2 (below) can weight by role/aDOT.
- TD markets follow their family's volume but are efficiency-heavy; apply a
  damped `scriptMult` (e.g. `1 + 0.5·(scriptMult−1)`) so a Poisson tail isn't
  over-moved. Validate before shipping (the TD tail overfit lesson from
  `prop-model.md` applies).
- Apply script to the **volume component only**, never efficiency. Yards/att and
  yards/target should not move with script; volume does. Wire it where `envMult`
  multiplies in, but split by family instead of one scalar.

### 3. Interaction with the total

`envMult` and `scriptMult` are **multiplicative and independent**: a team can be
a big underdog in a high-total game (throws a lot, in a shootout) — pass markets
get `envMult>1 · passScriptMult>1`, rush markets get `envMult>1 ·
rushScriptMult<1`. This is the correct decomposition and the reason a single
multiplier can't capture it.

## Fitting

Fit from real team-games, holdout-validated, never hand-set:

1. **Source:** nflverse team game logs (already pulled for
   `nflverse_stats_<season>.json`) joined to that game's **pregame** spread.
   Pregame is essential — a closing/in-game number leaks the outcome. Bank the
   pregame spread from `data/game_line_history.json` (already snapshotted, see
   `edge-feedback-loop.md`) or the game model's opening line.
2. **Fit:** regress team pass-attempt rate and rush-attempt rate (vs each team's
   own neutral baseline) on pregame spread. Recover `K_PASS`, `K_RUSH`, `SP_REF`
   and the clamp bounds from where the effect flattens.
3. **Output:** a small `data/game_script_model.json` (coeffs + provenance +
   backtest), read like the other fitted models, with a null-safe fallback to
   `scriptMult = 1` when the file is absent (mirror the trade-market getters:
   "not in the model" degrades to the old behavior, costs nothing).
4. **New pipeline script:** `scripts/build_game_script.py` (or `.mjs`), same
   cadence pattern as the other model builders.

## Wiring (three surfaces, one source of truth)

The env logic already diverges between the Edge Board and the Best Bets builder
(the builder applies NO opponent/env today). Ship the script term so all three
read the **same** coefficients:

1. `VaultPropModel.fairProbOver` (`prop-model.js` / inline): accept a
   `scriptMult` (or `spread` + market family, computing it internally) and apply
   to the volume component.
2. `matchupAdj` (Edge Board, `index.html`): return `scriptMult` next to
   `envMult`; thread through the existing `PM.fairProbOver(… )` call. Surface it
   in the provenance line (`… · script <spread> ×<mult>`) next to the existing
   `env` and `opp` chips (`index.html:~42556`).
3. `scripts/build_best_bets.mjs`: **also adopt opp + env + script** so the Best
   Bets hero and the board score identically. This closes the hero/board
   divergence noted during the phantom-edge work
   ([edge-feedback-loop.md] loop context).

## Phasing

- **Phase 1 (this task):** spread-driven family skew, fitted, wired to all three
  surfaces, provenance line, changelog. Null-safe fallback to `×1`.
- **Phase 2 (follow-up, separate task):** role-weighted receiving script (aDOT /
  check-down backs gain more from negative script than deep WRs) and
  **playcaller/coordinator tendencies** — the *baseline* pass/rush mix and
  touch/target concentration a team brings BEFORE script bends it. Phase 1
  captures how the mix bends to the scoreboard (spread); this is the neutral
  anchor it bends from.

  Competitive reference — Statchasers' "Playcaller Blueprint" (Redraft Command,
  inspected 2026-09-03). It fingerprints all 32 **2026 offensive play-callers**
  on 11 seasons of tape and exposes exactly the signal set Phase 2 needs, all as
  **deltas vs NFL median**:
  - **Offensive environment:** plays/game (pace), pass%, run%. (e.g. Mike
    LaFleur ARI: 61 plays/g −2.5, 65% pass +7, 35% run −7.)
  - **Backfield split** (share of non-QB carries): RB1 / RB2 / other. (LaFleur:
    RB1 60% −11%, RB2 27% +12%.)
  - **Target tree** (share of team targets): WR1 / WR2 / WR3 / TE / RB / other.
    (LaFleur: WR1 27%, WR3 11% +7%, TE 12% −17%, RB 20% +12%.)
  - Two-axis archetype map: X = RB1 carry share (Committee ↔ Bellcow), Y = WR1
    target share (Spread ↔ Stars); quadrants Alpha Factory / Stars Only /
    Everybody Eats / Bellcow Country.
  - **Attribution nuance to copy:** the profile is keyed to the actual
    play-caller and the sample where he called plays (LaFleur judged on his
    2021–22 Jets tape, not his Rams years where McVay called it), and mapped to
    2026 roles. A team's baseline should follow the play-caller, and a new
    HC/OC needs his prior-team sample or a positional prior.

  For Vault this is two things: (a) a per-team **neutral pass/rush baseline and
  pace** the Phase-1 `scriptMult` bends from (rather than assuming league-median
  neutral), and (b) **role-share priors** (RB1 carry share, per-role target
  share) that make the receiving-script skew role-aware. All of it is derivable
  from nflverse play-by-play (pass/rush by play-caller, PROE, pace, target/carry
  shares), which the current per-player weekly pipeline does not yet ingest —
  standing up that ingest is the bulk of the Phase-2 work.

## Phase 2 progress (built)

The ingest is stood up. `scripts/build_team_tendencies.py` streams 11 seasons of
nflverse play-by-play → `data/team_tendencies.json`:

- **Per team-season** (`by_season`): pace (plays/g), pass%, PROE (mean `pass_oe`
  on neutral-WP plays), RB1/RB2 carry share (QB runs stripped via the team's
  primary passer id), and top-1/2/3 receiver target concentration — the two
  archetype axes (Committee vs Bellcow, Spread vs Stars) plus the environment.
- **Current baseline** (`current`): a recency-weighted (halflife 1.5s), mean-
  reverted delta-vs-league-median over the last 3 seasons, with a **coaching-
  change reset** — a team whose head coach changed has its old-staff tape
  down-weighted (the 2026 hires Vrabel / Coen / Carroll / Moore / Johnson all
  flag `coach_changed`). Validated against known identities (BAL run-lean PROE
  -4.3, CIN pass-happy +3.8, PHI/Saquon bellcow rb1 68.9%).

Ships **dormant** (`active:false`) — data only, wired into nothing yet.

**Wiring the baseline anchor into projections — tested, NO-GO.**

`scripts/backtest_env_shift.py` built and validated the change-only env-shift (the
correct, non-double-counting design: shift a player's volume by the pace×mix
difference between the env his logs reflect and his current team's env, damped +
clamped, no-op when nothing changed). Season-holdout, 2016-2025, with a
**leakage-free** projected team env (production can't know this season's pace/mix
pregame):

| group | baseline MAPE | shift lift |
|---|---|---|
| ALL | 43.8% | **+0.2%** |
| CHANGED (new team / new HC) | 51.5% | +0.4% |
| STABLE | 38.8% | +0.2% |
| CHANGED · pass-family | 48.8% | +1.0% (best case) |
| CHANGED · rush-family | 59.7% | **−1.1% (hurts)** |

Verdict: essentially zero, and it actively hurts traded RBs (their carries hinge on
the job battle, not team rush volume). The reason is that the prop model is
autoregressive on own logs, and `role_volume`/`roleShift` already re-estimates a
moved player's ROLE — the part that actually matters — so the team-env layer is
redundant on top. **Not wired.** The tendencies ship as the Blueprint research
surface (real standalone value); they are not a projection multiplier. Kept as a
documented gate, like `backtest_prop_model.py`'s TD-tail finding.
2. **Role-aware receiving script** — weight Phase-1's `scriptMult` by the player's
   role and his team's target concentration (a check-down back gains more from
   negative script than a deep WR).
3. **Validation** — same gate as Phase 1: no settled in-season prop picks yet, and
   the market prices known pace/pass tendencies, so this is holdout- and
   CLV-gated before it can move a live projection.

**Follow-ups the file itself flags:** a gsis-id to position join for a WR/TE/RB
target split, and a curated play-caller-name map (OC + prior-team sample) for true
caller attribution rather than the team / head-coach proxy used here.

## Validation (gate before shipping)

- Backtest on a **season holdout**, not in-sample — the `prop-model.md` TD-tail
  overfit is the cautionary tale.
- Grade via the settlement/CLV loop (`edge-feedback-loop.md`): does adding the
  script term improve realized win% / CLV on volume props, especially on
  large-spread games? Bucket settled picks by spread and check the lift is where
  the theory predicts (dogs' pass overs, favorites' rush overs).
- Guardrail: the term must not *increase* miscalibration on neutral-spread
  games (|spread| small → `scriptMult ≈ 1`, so it shouldn't).

## Risks / non-goals

- **Double-counting with the total.** A book's pass/rush line already partly
  prices script. The term is fit against *actuals*, not against book lines, so it
  measures the real script effect; if the market already fully prices it, the
  fitted lift over book lines will be ~0 and the CLV gate will say so. Don't ship
  if it doesn't beat the line.
- **Clamp discipline.** Keep `scriptMult` bounded (±10–12%) like `envMult`; an
  unclamped script term on a blowout spread could re-introduce the exact
  projection-vs-line blowouts the phantom-edge gate now flags.
- **Non-goal:** in-game / live script. This is pregame only.
- **Non-goal:** replacing `envMult`. Script is additive/multiplicative *on top*
  of the scoring-environment term, not a substitute.
