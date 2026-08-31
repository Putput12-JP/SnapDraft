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
