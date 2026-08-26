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
4. **Distribution → probability**: `Normal(proj, sd)`, `sd = √(v0 + v1·proj)`
   (variance grows with the mean, Poisson-like), with a continuity correction on
   count markets. `P(over) = 1 − Φ((line − proj)/sd)`.
5. **Isotonic calibration** (PAV) maps the model-implied probability to the
   realized hit-rate, so the published fair probability is honest.

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

RMSE improvements are over a trailing 4-game average (the baseline PropSignal also
used). R² is in the same honest range PropSignal reports; TDs are a rare-event
count market (Poisson) and are a deliberate next phase, not shipped here.

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
- **TD / anytime_td** need a Poisson/count layer (phase 2).
- **Live validation**: the banked `data/prop_line_history.json` snapshots will,
  over the season, let us test whether "Vault proj > line" clears the ~52.4%
  break-even and whether Vault's fair prob beats the closing line (CLV). The Vault
  projection stays a labeled signal **alongside** the Sleeper lean until that
  validation lands — it does not become the default projection before it is proven.
