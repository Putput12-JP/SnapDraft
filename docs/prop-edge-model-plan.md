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

## #2 — Opponent + game environment  ·  HIGH impact, MED effort  ·  DO FIRST

`fairProbOver` already accepts `oppMult`/`envMult` and defaults them to 1, so
the whole path is stubbed and inert. Props are matchup- and total-dominated; this
is the single largest *known* signal currently ignored, and it's the one the
market prices heavily (so ignoring it makes us disagree with the market in
predictable, wrong ways — the worst kind).

Steps:
1. **Opponent (DvP):** build per-defense multipliers by position × market from
   nflverse (yards/TD allowed vs league baseline, last ~10–17 games, opponent-
   adjusted so we don't double-count schedule). New
   `scripts/build_dvp_multipliers.py` → `data/dvp_multipliers.json`. Load in the
   Edge Board and pass `oppMult` per row from the prop's `opp`.
2. **Environment (total/spread):** map the game's Vegas total + spread (already
   in `vegas_games`) to a volume/scoring multiplier. High total → more plays and
   scoring; big favorite → run-tilt (RB volume up, pass down); big dog → pass
   volume up. Pass `envMult`.
3. **Cap the multipliers** (e.g. 0.85–1.15) so a thin DvP sample can't swing a
   projection wildly — same shrink discipline as everywhere else.

Validate: the projection's out-of-sample MAE and log-loss vs the closing line
must *improve* with the multipliers on. If not, ship them off (the memory's
opponent-adjustment result — "REJECTED, no OOS gain" — was for a different model;
re-test here, don't assume).

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

## #4 — Fix the distributions  ·  MED impact, MED effort

The Normal/Poisson tails are wrong exactly where lines sit.

- **Counts/TDs → Negative Binomial.** TD counts are overdispersed; `sd = √λ`
  understates spread → overconfident tails (the exact failure the backtest caught
  when it pulled anytime-TD). Fit a dispersion `r` per market; tail becomes the
  NB CDF. Should let held-out TD markets (`pass_td`, `rec_td`) re-clear the
  backtest that rush/anytime failed.
- **Yards → log-normal or gamma.** Right-skewed, bust-prone (near-zero games).
  Replace `rawOver` with a log-normal tail (fit σ on log-stat) or gamma. Keep the
  isotonic layer *after* the parametric tail — but refit it, and **guard the
  sparse extreme buckets** (monotone isotonic overfits there; the memory flags
  this). Consider min-count-per-knot or a Beta-binomial smooth.

Validate: per-market reliability curve (predicted vs empirical hit rate) on the
season holdout, bucketed by line location (below/at/above projection). The tails
are the whole game.

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

## Sequence

1. **#5 scoreboard** (log-loss + CLV harness) — cheap, and nothing else can be
   judged without it.
2. **#2 opponent + environment** — biggest signal, immediately testable on #5.
3. **#3 market shrink** — kills the mirage edges; needs #5 to set the blend weight.
4. **#4 distributions** — refits under the new scoreboard; unlocks the held-out
   TD markets.

Everything model-side edits both `prop-model.js` and its inline copy in
`index.html`, and reruns `build_prop_projections.py` → `data/prop_model.json`.
