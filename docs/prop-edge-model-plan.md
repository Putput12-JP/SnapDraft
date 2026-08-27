# Prop edge model — hardening plan

Roadmap for the rest of the MIT-mathematician critique of how Vault measures
edge on player props. #1 (break-even-aware grade) shipped in `f750b1b`. This
covers #2–#5, sequenced by impact-per-unit-effort.

## Where the edge is computed (map)

- **Projection** — `prop-model.js` `projectFrom()`: yards = `shrink(volume) ×
  shrink(efficiency)`; counts/TDs = `shrink(stat)` to a market prior (exp decay
  `half_life`, variance shrink `k_vol`/`k_eff`). Inlined into `index.html`
  (`window.VaultPropModel`, ~L39653) — **any model change lands in BOTH files.**
- **Variance** — `sdAt(m, proj) = sqrt(sd_v0 + sd_v1·proj)` (heteroscedastic,
  linear in mean); Poisson uses `sd = √λ`.
- **Tail prob** — Normal `1 − Φ((L−proj)/sd)` for yards; Poisson tail for counts.
- **Calibration** — isotonic `calibrate(m.calib, raw)`, fit per market.
- **Edge / EV** — `betting-math.js` `findEdge(fairProb, marketProb)` →
  `evPerDollar = fairProb/marketProb − 1`. This is the "Vault edge" column.
- **Grade** — `vaultGrade()` → `padj = 0.5 + (p−0.5)·games/(games+6)`, letter
  from `gradeLetter(padj, betBE)` (break-even-aware, shipped).
- **Params/fit** — `data/prop_model.json`, built by
  `scripts/build_prop_projections.py`; validated by
  `scripts/backtest_prop_model.py` (season holdout).

The core defect the critique found: **Vault edge is model-minus-price and calls
it edge, with no shrink toward the market and no distribution-shape or matchup
correction.** The big displayed edges (+65%, +262%) are mostly model error, not
opportunity. The plan fixes that from cheapest to hardest.

---

## #2 — Opponent + game environment  ·  RE-SCOPED (most of it is already settled)

**Read before doing anything here.** The naive version of this — a per-defense
DvP multiplier on the point projection — was already built and **backtested and
rejected** (commit `2365a5d`; see the prop-projection memory): it does NOT improve
out-of-sample projection RMSE (rush_yd +0.27% best; HURTS rush_att/rec_yd/rec),
because prior-season defense correlation is ≈±0.01 (defenses turn over) and
single-game DvP is swamped by player-game variance. `oppMult`/`envMult` are
no-ops on purpose. **Do not re-run that test.** And env from Vegas total/spread
was never fittable from tape (no historical Vegas lines) — it belongs with the
NFL game model, not here.

What's actually left that isn't settled:
1. **Env via the game model, forward-only.** Once the NFL game-rating model
   produces per-game implied totals/spreads, pass a capped `envMult` (high total
   → more volume/scoring) and validate on **forward CLV**, not historical RMSE
   (which can't see Vegas). This is the only honest path for environment.
2. **DvP only at the extremes, on probability not the point.** The rejected test
   moved the point projection. A narrower bet: a tiny tilt to the tail
   probability for the few defenses that are outliers on the current season to
   date, applied to P(over) not `proj`. Low expected value given the ±0.01 base
   correlation; only worth it if #5's scoreboard shows a matchup-conditioned edge.

Net: **#2 is mostly closed.** The real levers are #3 and #4. Reprioritize.

---

## #3 — Shrink the model toward the market  ·  HIGH impact, MED effort

Report edge only after blending the model with the market prior, weighted by
each side's out-of-sample precision. This is what kills the +262% mirages.

- **Priced books:** prior = the vig-free market prob (already computed as
  `dv.over.fairProb` in `rowFairEV`). Posterior in logit space:
  `logit(p*) = w·logit(p_model) + (1−w)·logit(p_market)`, with `w` set from the
  *measured* ratio of model vs market log-loss (a global constant to start; per-
  market later). Report edge from `p*`, not `p_model`.
- **Pickem (Underdog/PrizePicks):** the "market" is the posted line ≈ 50%, which
  is ~what the grade's shrink-toward-0.5 already does — so for the user's actual
  use case this is mostly done. The win here is (a) making the shrink target
  explicit (the line's implied prob, not a hardcoded 0.5) and (b) applying the
  same blend to the **Vault edge %** column so its headline numbers stop being
  absurd.
- Keep `games/(games+K)` sample shrink *and* the market blend — they answer
  different questions (how sure are we of our own number vs how much should our
  number move the market's).

Validate: after shrink, no single-line edge should exceed a sane cap
(≈ ±15–20% EV at a real book) unless it's a genuine stale line; log the tail.

---

## #3 — Shrink the model toward the market  ·  DONE (temperature form)

Shipped as **per-market temperature scaling** toward 0.5 (the pickem/market-neutral
prior). `build_prop_projections.py` fits a `shrink` w per market on the walk-forward
calibrated probs (`fit_shrink`), writes it into `prop_model.json`; the JS serving
applies `over = shrinkProb(calibrate(...), w)` in `prop-model.js` + the inline copy.
`backtest_prop_model.py` validates it with 2-fold CV on the season-holdout.

**Findings:** the **yards markets are already well-calibrated** (w≈1.0, ~0% CV gain) —
they need no shrink, and get none. The overconfident markets are **count/TD**: `rec`
(w≈0.70, the #5 trap), and the already-held `rush_td`/`anytime_td`. After shrink the
pooled A-grade goes from pred .752/real .714 to pred .734/real .737 — essentially
calibrated. Live check: a rec over-prob of 0.415 → 0.440 (pulled toward the coin-flip).

**Caveats / follow-on:**
- The shipped w is fit on the build's walk-forward (mild leakage → conservative,
  under-shrinks vs the season-holdout's w=0.55 for rec). Safe direction. If we want
  the fuller correction, fit w via a proper holdout in the build.
- This is shrink toward 0.5, which equals the market only for FLAT pickem lines. True
  shrink toward a priced book's de-vig prob still needs in-season odds (with CLV) —
  deferred. For the Texas/Underdog use case, 0.5 IS the market, so this is the right form.

## #4 — Fix the distributions  ·  DONE (per-market bake-off)

Shipped as an automatic **per-market distribution bake-off** in the build
(`choose_dist`): each market picks Normal / log-normal / Poisson / Negative-Binomial
by out-of-sample raw log-loss, then calibration + shrink fit under the winner.
`prob_fn_for` dispatches; JS serving (`prop-model.js` + inline) mirrors it with
`nbOver`/`lognormOver`, reading `m.dist`. The season-holdout uses the same
selection, so the grade scoreboard reflects it.

**What won (measured, not assumed):** pass_yd/pass_att/pass_cmp → Normal (passing is
symmetric; alts lost); rush_yd/rec_yd → log-normal (right-skewed); rec/rush_att →
Negative-Binomial (overdispersed, r≈10.7/4.4); all TD markets → Poisson.

**Key findings:**
- NB-for-TDs was WRONG — TD counts aren't overdispersed (NB fit r≈240 ≈ Poisson).
  The held TD markets' overconfidence is projection-side, so #4 does NOT un-hold
  them. Confirmed the memory.
- **`rec` #5 trap fixed:** A-grades 0.538 (< 55% BE) → **0.659** OOS.
- **A-grade calibration pred .752/real .714 → pred .856/real .856 — perfect.**
- **#3 shrink is now ~a no-op** (all w≈1.0, rec 0.94 vs 0.55): the right distribution
  is the real fix; temperature was the crude patch. Kept as a harmless safety net.

Follow-on (not blocking): gamma as a third yards candidate; per-line-location
reliability.

---

## Usage-based TD projection  ·  INVESTIGATED → NO-GO for the held markets

Hypothesis: project TDs from stable usage (carries/targets × TD-rate-per-use),
like the yards markets, instead of the noisy recency TD rate — to un-hold
rush_td / anytime_td. **Measured (walk-forward OOS log-loss, since 2016;
scratch scripts in /scratchpad td_usage*.py):**

| market | direct (current) | usage | verdict |
|---|---|---|---|
| rush_td | 0.330 | 0.355 (carries×rate) | usage WORSE |
| anytime_td | 0.394 | 0.394 (rush-direct + rec-usage) | tie |
| rec_td | 0.262 | **0.251** (targets×rate) | usage better (+4%) |

- **rush_td / anytime_td can't be usage-fixed with our data.** Rush TDs are
  goal-line events; nflverse weekly rows have `car`/`tgt`/`ays`/`wopr` but **no
  red-zone / goal-line splits**, and total carries don't predict goal-line looks.
  Heavier regression of the raw TD rate also loses (kv 2→4→8 = 0.330→0.345→0.367),
  so the current projection is already optimal. **They stay HELD.** This is the
  same class of measured no-go as the rejected opponent adjustment.
- **Air yards / wopr as the receiving volume was WORSE than raw targets** (0.268
  vs 0.251) — targets is the right usage signal for rec TDs.
- **rec_td usage projection — SHIPPED.** Routed rec_td through volume×efficiency
  (targets × rec-TD-per-target) via `is_usage(spec)` (build eval_market +
  compute_priors, JS `projectFrom`, both mirrored). Season-holdout log-loss skill
  jumped **+8.7% → +19.1%**; the bake-off re-picked NBinom (r≈1.8) under the new
  projection; A-grades pred .939/real .946. JS==Python exact (proj 0.32023 on a
  synthetic input). rush_td/anytime_td deliberately do NOT get usage (goal-line).

The genuine remaining lever for the held TD markets is **red-zone / goal-line
data** (a new nflverse pull: rushes inside the 5/10, end-zone targets), not a
reshuffle of box-score totals. That's the only thing that would move them.

---

## #5 — Validate on CLV / log-loss, not calibration  ·  foundational  ·  IN PROGRESS

**Shipped** (in `scripts/backtest_prop_model.py`):
- Season-holdout now covers **yards markets too** (pass_yd/rush_yd/rec_yd were
  silently skipped before — only count/poisson ran).
- **Grade scoreboard**: buckets every out-of-sample pick by the Vault grade it
  would have earned (favored side, confidence-shrunk by the player's game count,
  scored vs a `--be` break-even), then reports REALIZED win% per grade, edge vs
  break-even, per-leg ROI, monotonicity, and per-market A-grade clearance.
  `python3 scripts/backtest_prop_model.py [--be=0.55]`.

**Findings (2016→ holdout, 3-pick 55% BE):**
- Grades are **monotonic** (A 71% > B 61% > C 60% > D 57% > F 52% realized) and
  **A/B/C clear break-even** pooled — an A-grade pick returns ~+29% per leg.
- Model is mildly **overconfident** (A predicted 75.2% → realized 71.1%, ~4pts),
  consistent across ranges — the isotonic layer isn't fully honest in the middle.
- **`rec` (receptions) A-grades are a TRAP**: realized 53.8% < 55% break-even.
  The receptions grade overstates confidence at the top. (Fix belongs to #4 —
  the count distribution/calibration; #5's job was to surface it, done.)
- TD-market grades clear because the grade takes the FAVORED side, which for TDs
  is usually the well-calibrated "under/no-TD" — legitimate for pickem.

**Still to build (needs in-season data):**
- **CLV harness**: `clv_harness()` is a stub. Extend
  `scripts/snapshot-prop-history.mjs` to log per graded pick (side, line-at-grade,
  closing line, result), then settle vs nflverse actuals and score whether we beat
  the close. Untestable in the offseason (0 settled games); wire it now, it accrues
  through the season.
- **Multi-leg ROI sim**: current per-leg ROI assumes independent legs at fair
  pickem odds. A true entry sim must group correlated same-game legs — optimistic
  until then.

Original scope:

Calibration-on-average proves almost nothing (a model can be calibrated and have
zero discrimination). Stand up the honest scoreboard first — it's the gate every
change above is measured against.

- **Log-loss / Brier vs the closing line** on a season holdout, per market. This
  is the discrimination test. Add to `backtest_prop_model.py`.
- **CLV harness:** snapshot our graded picks at post time and the *closing*
  number, then score whether we beat the close. We already snapshot lines
  (`scripts/snapshot-prop-history.mjs`, `data/prop_line_history.json`) — extend
  it to log (pick, side, line-at-grade, closing-line, result) so CLV accrues
  automatically through the season.
- **Per-entry ROI sim for pickem:** simulate the actual entry payouts (the
  `BE_PRESETS` multipliers) over graded picks to report realized ROI by grade —
  the real-money proof that an "A" beats a "C".

Gate: no model change (#2–#4) ships to the board unless it improves OOS log-loss
*and* CLV. Until CLV exists, every grade is a hypothesis and the UI should keep
saying so.

---

## Sequence (revised after #5 findings)

1. **#5 scoreboard** — grade scoreboard + yards holdout DONE (5a5ab64). CLV
   outcome-settling still pending in-season data.
2. **#3 market shrink** — now the highest-value lever: blend model toward the
   market prior so the +65%/+262% mirages collapse. Uses #5 to set the weight.
3. **#4 distributions** — neg-binomial TDs, log-normal yards, and specifically
   fix the **`rec` grade trap** #5 surfaced (receptions A-grades realize 53.8% <
   55%). Refit + re-score against the scoreboard.
4. **#2 environment** — forward-only, via the NFL game model, validated on CLV.
   Opponent-DvP on the projection is already rejected; don't redo it.

Everything model-side edits both `prop-model.js` and its inline copy in
`index.html`, and reruns `build_prop_projections.py` → `data/prop_model.json`.
