# Edge feedback loop — capture → settle → CLV → sharpen

How Vault's player-prop and game-market lines get sharper over the season from
their own track record. This closes the piece `prop-edge-model-plan.md` calls #5
("validate on CLV, not calibration") and wires it into a live loop.

The honest one-line summary: **we bank every line we show, grade it against what
actually happened, and feed that back into the served probabilities — slowly,
weighted by how much evidence we have.**

## The loop

```
   feed (data/lineup-feed.json)
        │  hourly snapshot (retained forever, finished weeks kept)
        ▼
   data/prop_line_history.json     scripts/snapshot-prop-history.mjs
   data/game_line_history.json     scripts/snapshot-game-history.mjs   (+ banks the Vault model line)
        │
        │  daily settle vs nflverse actuals (games.csv + nflverse_stats_<season>.json)
        ▼
   data/bet_results.json           per-pick ledger: side, CLV, outcome     ┐ scripts/settle_bets.py
   data/edge_scoreboard.json       per-market aggregates: CLV, win%, temp   ┘
        │
        │  weekly refit reads the scoreboard back
        ▼
   data/prop_model.json            scripts/build_prop_projections.py → apply_inseason_overlay()
        │
        ▼
   served probabilities (prop-model.js + inline in index.html) — UNCHANGED code, sharper params
```

## Why CLV is the primary signal (and outcomes only confirm)

A single prop is a coin-flip-ish event: a good number can lose and a bad number
can win. **Closing-line value** — did the line move toward us after we flagged
it — accrues on *every* pick, every week, at far lower variance. If our number
is genuinely sharp, the market drifts to meet it, and we see that in weeks, not
seasons. Realized win% is the slower, higher-variance confirmation that the CLV
was real money and not just line-chasing. So the scoreboard leads with CLV and
reports win% beside it. (Per the build decision: CLV-first, outcomes-confirm.)

## Data contracts

### Capture (retained, never dropped — unlike the live board)

- **`prop_line_history.json`** — keyed `season|seasonType|week|pid|market`.
  `seasonType` is in the key so preseason week N and regular-season week N never
  collide into one record. Each record banks `open` (frozen first sight), `cur`,
  and `samples` (appended only on a real move). The **last sample is the
  closing-line proxy** (the game leaves the feed at kickoff, freezing it).
- **`game_line_history.json`** — keyed `season|seasonType|week|AWY@HOM`. Same
  retain-and-bank shape. Each snapshot also banks `vault` = the Vault game
  model's line *as of that snapshot* (spread/total/winHome), so we can grade the
  model as-it-was going into each game (the model refits weekly, so it drifts).
  This is the twin of `line_history.json`, which stays untouched for the live
  board (that one *drops* finished games on purpose).

### Settlement (`scripts/settle_bets.py`)

Rebuilds the whole ledger deterministically each run from the retained history
(no append/merge, no drift). Writes:

- **`bet_results.json`** — one row per settled pick with side, `line_open`,
  `line_close`, `proj`, `actual`, `won_close`/`won_open`, and the three CLV
  measures below.
- **`edge_scoreboard.json`** — per-market and per-grade aggregates for the UI
  *and* the model feedback: `winrate_close`, `clv_beat_rate`, `mean_clv_prob`,
  `mean_clv_line`, `model_logloss` vs `market_logloss`, an in-season
  `reliability` curve, and the two feedback knobs `inseason_temp` and `blend`.

**Actuals join.** `nflverse_stats_<season>.json` is keyed by player *name*, which
the prop records carry, so the join is name-based. We read **only** the
per-season file, never the generic `nflverse_stats.json` alias — the alias holds
the current season and would false-settle (e.g. 2026 props against 2025 actuals)
before the new season's data lands. A game/week with no actual yet simply doesn't
settle (it will next run).

**Preseason is never settled.** Preseason props are skipped: nflverse weekly
stats are regular/postseason only, so a `pre` week-N row would false-match
regular week N.

### CLV, three ways (all signed to *our* side)

- `clv_line` — points the line moved our way (over: `close − open`; under:
  `open − close`). Positive = we got the better number. The signal for flat
  pickem lines.
- `clv_prob` — vig-free probability move from the two-way American prices
  (`devig(over, under)` at open vs close). Positive = the market came to agree
  with us. The book-agnostic signal; ≈0 on flat pickem.
- `clv_price` — decimal-odds edge on our side vs the close.
- `beat_close` — favorable line move, or (line flat) favorable price/prob move.

## The live-adjust mechanism (and why it can't run away)

`build_prop_projections.py` → `apply_inseason_overlay(model)` reads
`edge_scoreboard.json` and, per market, composes this season's **measured
miscalibration** onto the shipped `calib` table:

```
t      = edge_scoreboard.markets[mk].inseason_temp.t   # residual temperature on served probs; t<1 ⇒ still overconfident
n      = its sample size
w      = n / (n + K)          # K = 300
factor = 1 + w·(t − 1)        # bounded via t∈[0.6,1.4]
calib_y' = sigmoid(factor · logit(calib_y))   # re-monotonized
```

Three properties make "adjust live" safe:

1. **No serving-code change.** The correction is baked into the `calib` table
   the JS already serves. Nothing in `prop-model.js` / `index.html` changes.
2. **Sample-shrunk hard.** With `K = 300`, Week 1–3 (small `n`) barely move the
   table; influence grows only as the season's evidence does. At `n = 30`,
   `w ≈ 0.09`; at `n = 600`, `w ≈ 0.67`.
3. **Re-derived from tape each build + bounded `t`.** The calib is refit from
   history every run and the overlay reapplied fresh, so it converges rather than
   compounding without bound. Offseason / no scoreboard / thin sample ⇒ `w ≈ 0`
   ⇒ exact no-op.

CLV-first shows up here too: `inseason_temp` is fit on the model-vs-outcome
reliability, but CLV is what tells us *early* (before enough outcomes accrue for
a stable `t`) whether the number is sharp, so the scoreboard is readable and
trustworthy weeks before the overlay meaningfully engages.

## The second lever: market blend (#3), the runtime one

The calibration overlay bends a market's probabilities in aggregate. The **market
blend** does something the overlay can't: on a *specific priced line*, it pulls
the model's `P(over)` toward that line's **vig-free market price**, because on a
real two-way market the price is itself sharp information.

Unlike the overlay, this can't be fully baked into `prop_model.json` — the market
price is a *runtime* value known only when the board renders a live line. So it's
split:

- **Build time.** `build_prop_projections.py` publishes a per-market `blend_w`
  from `edge_scoreboard.markets[mk].blend.w_measured` (the grid-searched weight
  on the model that minimized blended log-loss vs settled outcomes), shrunk the
  same way: `w = w_prior·(K/(K+n)) + w_measured·(n/(K+n))`, **`w_prior = 1.0`**
  (pure model, no blend) until evidence. So a market with no in-season data (or
  the whole offseason) publishes no meaningful `blend_w` and nothing blends.
- **Serve time.** `blendToward(pModel, pMarket, w)` in `prop-model.js` (and its
  inline copy in `index.html`) blends in logit space:
  `p* = sigmoid(w·logit(pModel) + (1−w)·logit(pMarket))`. It is called from the
  Edge Board consumers (`ebFillVaultCol`, `ebFillVault`) with the de-vigged
  market `P(over)` (`fe.sides.over.fairProb`). `w ≥ 1` or no market price ⇒ pure
  model, so it is a no-op today and only priced two-way rows in-season ever move.

Two deliberate exclusions: **flat pickem lines** (Underdog/PrizePicks) can't be
de-vigged, so `marketProbOver` is null and they stay pure-model — the existing
shrink-toward-0.5 temperature already is their "market blend." **One-sided
markets** (anytime-TD "Yes" only) have no vig-free price to blend toward, so they
stay pure-model too. Standalone projection surfaces (a player card with no market
shown) also keep the raw model on purpose; the blend belongs only where we
display an edge *vs* the market.

## Injury teammate-cascade (measured, forward-validated)

The #1 reason a projection is "way too high" or "way too low" is that the model
doesn't know a role changed. The cascade handles the biggest, most predictable
role change: **a higher-usage teammate is Out, so this player's volume jumps.**

- **Measured, not guessed** (`scripts/build_usage_cascade.py` →
  `data/usage_cascade.json`). From many seasons of nflverse weekly stats: rank a
  team's players by baseline volume (targets for WR/TE, carries for RB); a player
  is "absent" a week if he has a season role but no row that week; compare each
  remaining player's volume in absent-teammate weeks to his normal baseline.
  Publish the **median multiplier** per (group × depth-rank × how-many-higher-out),
  only where ≥ `MIN_EVENTS` support it. Findings: **RB2 with the starter out ≈
  ×2.3 carries** (the handcuff), WR2 ≈ ×1.1 / WR3 ≈ ×1.25 (targets scatter), and
  the deep bench correctly gets **×1.0** — the measurement isn't "everyone up when
  anyone's out," which is exactly why it's trustworthy.
- **Served** as a capped, shrunk volume multiplier: `fairProbOver`'s `usageMult`
  (alongside `oppMult`/`envMult`) scales the projection. Serving ranks a team's
  players by projected volume (the same signal the pipeline ranked on), counts
  higher-ranked players who are Out (same injury source as the board's badge),
  and looks up the measured median — shrunk toward 1 (`CASCADE_SHRINK`) and capped
  (`CASCADE_CAP`) for single-game noise. No injuries / no data / deep bench → no-op.
- **It talks to the plausibility layer.** A cascade-boosted projection is *supposed*
  to disagree with a market line that hasn't caught up, so `edgeCaution` suppresses
  the "implausible" flag when a cascade explains the gap and the board shows the
  edge **green with a ▲** naming who's out, instead of amber "check this."
- **Validated forward on CLV**, like everything else here: these picks settle
  through the same loop, so `edge_scoreboard` will show whether the bump actually
  beats the close. If it doesn't hold up, it comes out — same discipline as the
  rejected opponent/DvP adjustment.

## The game model: measured, deliberately not auto-tuned

`edge_scoreboard.games` grades the Vault game line forward — does our
spread/total side beat the *closing* market number (ATS / O/U), and what's its
CLV. This is new: the game model was only ever backtested on historical tape;
now its forward record accrues.

We do **not** auto-tune the game model toward the close. It already matches the
market to ~0.4 pts and does not beat it (see `docs/game-model.md`); it is shown
as *context, not edge*. Chasing an already-efficient market on a few weeks of
data would overfit it. Its normal sharpening is the existing weekly online-rating
refit (`update-game-model.yml`) as real games accrue. The scoreboard's job here
is to *watch* it, not to move it — the same discipline as the rejected opponent
adjustment in `prop-model.md`.

## Cron cadence

| Workflow | When | Does |
|---|---|---|
| `update-prop-history` | hourly `:27` | bank prop snapshots |
| `update-line-history` | hourly `:47` | bank live board **+ game settlement log** |
| `update-nflverse` | daily 06:00 | refresh weekly actuals |
| `update-bet-settlement` | daily 06:40 | settle → `bet_results` + `edge_scoreboard` |
| `update-prop-projections` | weekly Wed 15:20 | refit + apply in-season overlay |

Ordering holds: actuals (06:00) → settle (06:40) → the Wed refit reads the
freshest scoreboard.

## Verifying

- `python3 scripts/settle_bets.py --dry` — settle without writing; prints
  per-market win% / CLV-beat and the settled/unsettled/unmatched counts. A high
  `unmatched_names` means the name join is failing (suffix spelling, a new
  player) — investigate before trusting the numbers.
- The overlay is unit-tested for monotonicity, sample-shrink, and no-op
  (scratch `test_settle.py`); the settlement math (join, side, outcome, all
  three CLV measures, preseason skip) is tested against real 2024 actuals.
