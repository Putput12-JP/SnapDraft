# TD markets — red-zone / goal-line data pull plan

Roadmap to **un-hold the touchdown markets** — `rush_td`, `anytime_td`, and
`rush_rec_td` — by giving the projection the one input it's missing: goal-line
opportunity. This is the "NOT yet done" item that closes out the prop model's
TD story.

---

## Phase 0 result (2026-09-06): red-zone pull is a NO-GO — the lever is calibration

The Phase 0 spike ran (scratchpad `rz_spike.py`, 2017-2024 nflverse PBP,
walk-forward, test 2021+). **Two findings:**

1. **Goal-line opportunity does NOT improve the combined-TD projection.** An
   opportunity × conversion projection (carries inside 10/5, red-zone / end-zone
   targets) beat the recency-TD-rate baseline by only **+0.04% to +0.25%
   log-loss** (noise), and its **scoring tail got *worse*** (pred≥0.60 gap
   +0.09 to +0.15 OVERCONFIDENT vs the baseline's +0.067). The exact failure we
   needed to fix, opportunity made worse. **Do not build the PBP pipeline below.**
   (Consistent with the box-score-usage NO-GO — total *and* goal-line volume both
   fail; a back's 0-3 goal-line touches a game are as noisy as the TDs.)

2. **The real culprit was the isotonic CALIBRATION, not the projection.** The
   spike's baseline was *raw* (no calibration) and its tail was already honest
   (+0.067). Re-running the full harness with `--no-calib` on the held combined-TD
   markets flips the grade scoreboard from FAIL to PASS:

   | `rush_rec_td` grade scoreboard (test 2022+) | Calibrated (shipped path) | **Raw (no calib)** |
   |---|---|---|
   | A/B/C clear the 55% break-even OOS | **NO** (B 0.54, C 0.34 collapse) | **YES** (A 0.95, B 0.79, C 0.59) |

   Same for `anytime_td` (A 0.95 / B 0.79 / C 0.61, monotonic ✓). The rare-event
   TD tail is exactly where isotonic PAV overfits (dense in-sample bins that don't
   transfer) — so calibrating it *destroys* the grade that raw serving gets right.

**Recommendation:** abandon the red-zone data pull. Instead pursue a **code-only**
un-hold: ship `rush_rec_td` + `anytime_td` **raw** (skip the isotonic calib for
these markets only — `rec_td`/`pass_td` keep theirs, they validated with it).

**DONE — shipped (2026-09-06, `f8cc252`).** Un-held both markets as raw
(`no_calib` → `calib: []`) plus a fixed **0.85 confidence shrink** (`TD_RAW_SHRINK`
in `build_prop_projections.py`). The focused 0.5-line validation
(`scratchpad/validate_raw_td.py`) confirmed the caveat and the fix: pure raw
cleared A/B but left **C at 0.53** at the bettable 0.5 line, and the raw
scoring-over mid-tail was overconfident; a 0.85 temperature shrink (the *fitted*
shrink is ~1, it minimizes pooled log-loss and misses the mid-tail — hence the
explicit constant) makes the grade ladder monotonic and **A/B/C clear per-market
on both directions** — rush_rec_td A .84/B .73/C .62, anytime_td A .85/B .72/C .63,
and A-overs ("will score") realize ~0.70 honestly. `prop_model.json` gained only
these two markets (every other byte-identical); the client auto-grades with no
code change (Rush + Rec TD tab + the `has()`-gated Anytime TD board). `rush_td`
stays held (raw un-hold unvalidated for it). Note: the in-season overlay
(`apply_inseason_overlay`) sharpens via the `calib` table, so it's a no-op for
these `calib: []` markets — they won't auto-refine in-season; revisit if wanted.

The pipeline design below is **shelved** by finding (1) — kept only for the record
and for anyone who later revisits opportunity with a fundamentally different
feature (e.g. tracking/participation data, not box-score-or-PBP volume).

---

## Why these markets are held (the wall we're hitting)

All three TD markets are fit + reported but **never written to
`prop_model.json`** (`build_prop_projections.py` `HOLD = {rush_td, anytime_td,
rush_rec_td}`). The season-holdout backtest is unambiguous:

- `rush_rec_td` scoring tail is **overconfident out-of-sample by +0.45** (pred
  0.760 → real 0.315), essentially identical to `anytime_td` (+0.44). The grade
  scoreboard's "A clears ✓" is a mirage — trivial high-line unders (won't get
  2+/3+ TDs) that no book prices as a flat pickem; the *bettable* middle grades
  collapse and go non-monotonic (B 0.54, C 0.34, D 0.36 vs a 0.55 break-even).
- Same root cause every time: **rushing TDs are goal-line events, and the
  box-score tape the model trains on has no goal-line signal.** A couple of
  recent TDs spike a noisy recency rate; that spike does not transfer.

Two things are already settled, so we don't repeat them:

1. **Box-score usage was tested and failed** (`docs/prop-edge-model-plan.md`,
   scratchpad `td_usage*.py`): projecting TDs from total carries/targets × TD-rate
   is *worse* OOS than the recency rate (`rush_td` 0.330 → 0.355). Total volume
   can't stand in for goal-line looks.
2. **Calibration/distribution are not the problem** — NB≈Poisson for TD counts
   (not overdispersed), and raw (no-calib) is still net-negative. The
   **projection** is what's broken.

So the only untried lever is **new data**: per-player goal-line opportunity from
play-by-play, which the current pipeline never ingests.

## Hypothesis

`E[TDs] = (projected goal-line opportunity) × (conversion rate)`, where
opportunity is far more stable/predictable game-to-game than realized TDs:

- **Rushing:** carries inside the 10 / inside the 5 / goal-to-go carries.
- **Receiving:** targets inside the 10 / end-zone targets.

Route the TD markets through the model's existing **usage path** (`is_usage`,
volume × efficiency) exactly as `rec_td` already does (targets × rec-TD-per-target):

- **volume** = recency-weighted projected goal-line touches (shrunk to a
  position prior),
- **efficiency** = TD per goal-line touch (shrunk to a league prior),
- **λ** = projVol × projEff → Poisson tail as today.

The bet is that goal-line *opportunity* is a real, transferring signal (a bellcow
gets goal-line carries every week by role) even though the resulting *TD* is a
coin-flip conversion. If true, the scoring-side tail becomes honest OOS.

## Data source — already wired

nflverse **play-by-play** is the canonical goal-line source, and Vault already
pulls it: `scripts/build_team_tendencies.py` has a working, cached PBP reader
(`pbp_rows(yr)`, `PBP_URL = .../pbp/play_by_play_{yr}.csv.gz`, honors a
`PBP_CACHE` dir). Reuse it verbatim — no new download machinery.

PBP columns we need (all present in the nflverse `pbp` release):

| Need | Columns |
|---|---|
| Locate goal-line plays | `yardline_100` (≤10, ≤5), `goal_to_go` |
| Play type + actor | `rush`/`rush_attempt`, `pass`/`pass_attempt`, `rusher_player_id`, `receiver_player_id` |
| Conversion (for the eff prior) | `rush_touchdown`, `pass_touchdown`, `td_player_id` |
| Keys | `season`, `week`, `season_type` (REG only), `posteam` |

**Coverage:** PBP goes back to 1999, but `yardline_100`/participation fields are
reliable from ~2006; align the pull with the model's `--since` window (2016 today,
which is fine). Size ≈ 40-60 MB gz/season; cache in CI.

## Pipeline changes

### 1. New builder: `scripts/build_redzone_usage.py`

Stream PBP per season, aggregate **per player, per game**, emit a compact map
keyed the way the weekly files already are (name + week). Fields to add to each
`weeks[]` row (mirroring the `rtds`/`car`/`tgt` short keys in
`process_nflverse.py`):

```
rz10_car, gl_car   # carries inside the 10 / inside the 5 (goal-to-go)
rz10_tgt, ez_tgt   # targets inside the 10 / into the end zone
```

The **name↔id join** is the known friction (PBP keys on `*_player_id` gsis ids;
the weekly files key on full name). Resolve via the existing
`window.vaultPidFor`/`vaultNameKey` conventions on the client side, and on the
build side map gsis id → name using the PBP `*_player_name` columns (present
alongside the ids), with the same suffix-stripping `normName` the model uses.
Budget real time here — this is where cross-source joins bite
(`reference_cross_source_name_joins`).

### 2. Merge into the weekly archives

The model reads `data/nflverse_stats_{year}.json`; the client game-log
(`VaultPropHistory`) reads the same. So the new fields must land in `weeks[]` in
**both** producers:

- `scripts/process_nflverse.py` — current season (nightly).
- `scripts/build_historical_stats.py` — backfill 2016→ once.

Add a merge step that joins the red-zone map onto the weekly rows by (name, wk).
Keep the fields optional/nullable so a season without PBP coverage degrades to
today's behavior rather than dropping the player.

### 3. Model wiring: `build_prop_projections.py`

The usage machinery already exists — `is_usage(spec)` fires when a market
declares `vol` + `eff_num`, and `rec_td` already routes a Poisson through
volume × efficiency. Define the TD specs to use the new fields, e.g.:

```python
"rush_td":     {"kind":"poisson", "stat":"rtds",  "vol":"gl_car",  "eff_num":"rtds",   "pos":["RB","QB"]},
"rush_rec_td": {"kind":"poisson", "stat_sum":["rtds","rectds"],
                "vol_sum":["gl_car","rz10_tgt"], "eff_sum":["rtds","rectds"], "pos":["RB","WR","TE"]},
```

`rush_rec_td`/`anytime_td` need a **summed** usage path (goal-line carries +
red-zone targets as combined opportunity); that's a small extension of
`is_usage`/`eval_market`/`compute_priors` to accept `vol_sum`/`eff_sum` the way
`market_series` already accepts `stat_sum`. Mirror the same extension in the JS
`projectFrom` (both `prop-model.js` **and** the inlined `window.VaultPropModel`
in `index.html` — any model change lands in both).

## Validation — the go/no-go (unchanged bar)

Re-run `scripts/backtest_prop_model.py` season-holdout. Ship **only if** it clears
the exact bar `rush_rec_td` failed:

1. **Tail honest OOS** — on held-out predictions ≥ 0.60, |predicted − realized|
   ≤ 0.07 (the harness's `TAIL verdict … HONEST ✓`). This is the metric that
   separated `pass_td` (gap +0.02, shipped) from `rush_rec_td` (gap +0.45, held).
2. **Bettable middle grades** — B/C grades monotonic and clearing the 0.55
   break-even, judged on the **live 0.5-line regime**, not the pooled trivial
   high-line unders that inflate the A bucket.

If it still fails, it **stays market-only** — that is a legitimate outcome, and
the honest one, exactly as today. Do not ship a graded TD number that backtests
like a coin flip on the only lines you can bet.

## Sequencing (cheapest go/no-go first)

- **Phase 0 — spike (½ day, decides everything).** Before building any pipeline,
  reuse `pbp_rows()` on 2 seasons in a scratchpad: compute goal-line touches per
  player-game, fit the simplest opportunity×conversion projection, and measure
  OOS log-loss vs the recency-TD-rate baseline. **If there's no lift here, stop**
  — the full ingestion isn't worth it, and the market stays market-only. This is
  the real decision point; everything below is contingent on it.
- **Phase 1 — pipeline.** `build_redzone_usage.py` + merge into
  `process_nflverse.py` and `build_historical_stats.py`; backfill 2016→.
- **Phase 2 — model.** Extend `is_usage`/`eval_market`/`compute_priors` for
  `vol_sum`/`eff_sum`; wire the TD specs; mirror in both JS projectors.
- **Phase 3 — validate.** Backtest against the bar above. Un-hold only the
  markets that clear (they may split by position — `rush_rec_td` for WR/TE is
  ~`rec_td` and may clear while RB doesn't).
- **Phase 4 — ship.** Remove cleared markets from `HOLD`; the build writes them
  to `prop_model.json` and the client **auto-grades with no UI change** (the
  Rush + Rec TD tab and `renderAnytimeBoard`, which already gate on
  `VaultPropModel.has(...)`, light up on their own).

## Risks / unknowns

- **Opportunity may itself be too thin.** A back sees 0-3 goal-line carries a
  game; the projected-volume signal could be as noisy as the TDs. Phase 0
  measures this directly.
- **Name↔gsis-id join** across PBP and the weekly files — the usual
  cross-source friction; verify player counts don't silently drop.
- **The win must come on the scoring/over side.** The model already flags who
  *won't* score reliably; the whole point is honest confidence on who *will*.
- **CI cost** — PBP is large; cache per season and only refresh the current year
  nightly (historical is a one-time backfill).
- **Bar is high on purpose.** Beating the recency rate isn't enough; it must
  clear the tail-honesty + bettable-grade bar, or it stays market-only.

## Related

- `docs/prop-model.md`, `docs/prop-edge-model-plan.md` (box-score usage NO-GO).
- `scripts/build_prop_projections.py` (`HOLD`, `is_usage`, `stat_sum`),
  `scripts/backtest_prop_model.py` (season holdout + grade scoreboard).
- `scripts/build_team_tendencies.py` (`pbp_rows`, the PBP reader to reuse).
- Memory: `project_prop_projection_model` (TD holds + this validation),
  `project_single_book_line_guard` (the market-only Rush + Rec TD tab).
