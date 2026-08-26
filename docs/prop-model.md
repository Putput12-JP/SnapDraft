# Vault player-prop projection model

Vault's **own** player-prop projection, fit from real nflverse game logs. It
replaces "re-serve Sleeper's number" with a measured, per-market model whose
**calibrated fair probability** feeds the Betting Edge Board — so the board can
show a genuine Vault-derived edge, not just a de-vig of the book's own price.

- Trainer: [`scripts/build_prop_projections.py`](../scripts/build_prop_projections.py) (pure stdlib)
- Params: [`data/prop_model.json`](../data/prop_model.json) (~3.7 KB)
- Server: `window.VaultPropModel` — [`prop-model.js`](../prop-model.js), inlined in `index.html`
- Refit cron: `.github/workflows/update-prop-projections.yml` (weekly, Wed 15:20 UTC)

## Why this shape

Two reference builds informed it:

- **PropSignal** (seidcubro) — the right *structure*: per-market regression on
  nflverse features, honest time-split R² (0.37–0.73), and the note that TDs need
  a count model. Its Python/sklearn/Postgres stack does not fit Vault.
- **edge-nfl** (LeSingh1) — the right *serving pattern*: recency-weighted mean+sd
  → distribution → P(over) → isotonic calibration, shipped as a small params file
  + JS inference. (Its "94.7% accuracy on synthesized lines" headline is a
  meaningless metric; we do not evaluate that way.)

We take PropSignal's per-market structure and edge-nfl's calibrated,
params-in-JSON serving, implemented **stdlib-native** to match Vault's
dependency-light crons.

## The model

For each market, the point projection decomposes the way real prop models do —
**volume × efficiency** — then a distribution around it yields `P(over line)`:

1. **Volume** (targets / carries / attempts): exponentially recency-weighted
   rolling mean, empirical-Bayes shrunk toward the league prior when the sample
   is thin. Usage is the stable, predictive signal.
2. **Efficiency** (yds/target, yds/carry, yds/attempt): recency-weighted but
   **shrunk harder** toward the position/league mean — efficiency is noisy.
3. `proj = weightedVolume × shrunkEfficiency` (count markets project the stat
   directly).
4. **Distribution → probability**:
   - yards / volume counts: `Normal(proj, sd)`, `sd = √(v0 + v1·proj)` (variance
     grows with the mean, Poisson-like), continuity-corrected on counts.
     `P(over) = 1 − Φ((line − proj)/sd)`.
   - TDs: `Poisson(λ = proj)` tail, `P(over k.5) = 1 − PoissonCDF(k, λ)`.
5. **Isotonic calibration** (PAV) maps the model-implied probability to the
   realized hit-rate, so the published fair probability is honest. Each bin's
   empirical rate is **shrunk toward its raw midpoint by a pseudo-count** before
   PAV, so a sparse tail bin can't overfit a handful of coin-flips into a
   confident (and dangerous) edge.

**Every constant is fitted, not invented** (Vault rule). The recency half-life,
the shrinkage strengths, the per-market `sd`, and the isotonic maps are all chosen
by minimizing **out-of-sample** error on a walk-forward split — at each game a
player's projection uses only prior games, then is scored against the actual.

## Markets and measured accuracy (walk-forward, since 2016)

| Market   | n      | RMSE vs naive-4gm | R²    |
|----------|--------|-------------------|-------|
| pass_yd  | 4,070  | −5.9%             | 0.14  |
| pass_att | 3,300+ | −6.8%             | 0.18  |
| pass_cmp | 3,300+ | −6.6%             | 0.20  |
| rush_yd  | 13,178 | −2.0%             | 0.36  |
| rush_att | 10,700+| ~flat             | 0.52  |
| rec      | 31,163 | −4.3%             | 0.34  |
| rec_yd   | 9,954  | −3.9%             | 0.33  |
| pass_td  | 4,112  | −7.1% (Poisson)   | 0.08  |
| anytime_td | 13,530 | −4.8% (Poisson) | 0.22  |

RMSE improvements are over a trailing 4-game average (the baseline PropSignal also
used). R² is in the same honest range PropSignal reports; TDs are rare-event
counts so their R² is low, but the Poisson projection still beats the baseline and
the value is the calibrated `P(over)`.

**Anytime TD** is Vault-only by nature. Books/feed carry only the "Yes" price, so
the de-vig Edge Board can't grade it — it never even appeared before. `λ` is the
combined rush+rec TD rate; `P(anytime) = 1 − e^(−λ)`, calibrated. It gets its own
isolated board (`renderAnytimeBoard`) that ranks real "Yes" prices by Vault edge =
`P(TD)` vs the book's implied prob. Well-calibrated for ~91% of players; the elite
red-zone tail (λ≳0.9) reads aggressively high (same TD-persistence as rush_td), so
the board is labeled a lean, not a lock, pending CLV validation.

**`rush_td` / `rec_td` are fit but HELD** (not written to the model). Their
calibration shows strong TD-scoring *persistence* — recency-weighted goal-line
backs clear the over 75–90% in dense, real out-of-sample bins, well above the
memoryless Poisson. That may be a genuine soft-market edge or overfitting; either
way, shipping 0.85+ rush-TD probabilities would flag enormous edges against books
that are very sharp on TD props. They stay held until the banked
`prop_line_history.json` snapshots let us check that tail against real closing
prices.

The bigger value is not the point RMSE — it is the **calibrated distribution**.
A trailing mean gives you a number; this gives you an honest `P(over)`, which is
what an edge calculation needs, and it catches de-vig traps (a book's two-way can
imply a "+EV under" on a stale low line the player clears every week).

## Serving and inference

`VaultPropModel.fairProbOver(name, market, line, opts)` reads the player's game
logs through `VaultPropHistory` (no new network cost), computes the projection and
`P(over)` **client-side** from the params, and returns `{proj, sd, fairProb,
over, under, raw}`. The Edge Board turns that into a "Vault edge" via the existing
`VaultBettingMath.findEdge(fairProb, bestPriceProb)`. Every getter returns `null`
until `prop_model.json` lands, so a cold cache falls back to the Sleeper number.

The JS math mirrors the Python exactly (verified: Ja'Marr Chase rec_yd → proj
81.40, sd 51.36 in both).

## Known limits / next phases

- **Opponent (DvP) and game-environment (Vegas total)** adjustments are supported
  as inference-time multipliers (`opts.oppMult`, `opts.envMult`) but are **not yet
  applied** — the historical weekly rows carry no opponent, so their elasticities
  aren't fit from tape. Applied conservatively at inference is the next step.
- **pass_td / anytime_td** ship (Poisson). `rush_td` / `rec_td` are fit but HELD
  (see above). anytime_td's elite tail needs CLV validation before it's more than
  a labeled lean.
- **Live validation**: the banked `data/prop_line_history.json` snapshots will,
  over the season, let us test whether "Vault proj > line" clears the ~52.4%
  break-even and whether Vault's fair prob beats the closing line (CLV). The Vault
  projection stays a labeled signal **alongside** the Sleeper lean until that
  validation lands — it does not become the default projection before it is proven.
