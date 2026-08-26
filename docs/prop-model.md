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
| rec_td   | 11,422 | −7.0% (Poisson)   | 0.06  |

RMSE improvements are over a trailing 4-game average (the baseline PropSignal also
used). R² is in the same honest range PropSignal reports.

## Backtest — what actually validated (this is the important part)

`scripts/backtest_prop_model.py` runs a **season-holdout**: for each test season T
it fits projection + calibration on seasons < T only, then predicts every game in
T and compares predicted `P(over)` to what actually happened — the honest
out-of-sample test the in-sample walk-forward can't give you.

It caught a real trap. The in-sample isotonic calibration made the **rare-event TD
tails look great** (dense bins where high-λ scorers hit 75-90%), but that signal
**does not transfer across seasons**: out-of-sample, games the model called 60-90%
actually hit 20-50%. A couple of recent TDs spike a noisy projection that reverts
the next week. This is the same in-sample-metric trap as edge-nfl's "94.7%."

Verdict, by market (held-out log-loss skill vs base rate; TD tail predicted→real):

| Market | Skill | Tail | Status |
|---|---|---|---|
| pass_td | **+6.6%** | 0.755 → 0.724 ✓ | ships (high base rate, well-behaved) |
| rec_td  | **+8.7%** | no aggressive tail | ships |
| rush_td | −17.5% | 0.81 → 0.39 ✗ | **held** |
| anytime_td | −19.2% | 0.77 → 0.33 ✗ | **held** |

So the honest cut: **pass_td and rec_td ship; rush_td and anytime_td are held.**
`anytime_td` (briefly shipped) is pulled — its board shows an honest "back in the
lab" state. The rare-event TD projection can reliably say who *won't* score, not
who will; fixing it needs a usage-based projection (red-zone looks, snaps), not the
raw recent-TD rate. The go-forward CLV harness (reads `data/prop_line_history.json`)
will confirm against real closing prices once in-season odds accrue.

**`rush_td` / `anytime_td` are HELD** (fit + reported, not written to the model) —
the backtest above proved their tails don't hold up out-of-sample. Re-enable each
only when a reworked (usage-based) projection clears the season-holdout.

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
- **pass_td / rec_td** ship (Poisson, validated). `rush_td` / `anytime_td` are
  HELD (failed the season-holdout) and need a usage-based rework before returning.
- **Live validation**: the banked `data/prop_line_history.json` snapshots will,
  over the season, let us test whether "Vault proj > line" clears the ~52.4%
  break-even and whether Vault's fair prob beats the closing line (CLV). The Vault
  projection stays a labeled signal **alongside** the Sleeper lean until that
  validation lands — it does not become the default projection before it is proven.
