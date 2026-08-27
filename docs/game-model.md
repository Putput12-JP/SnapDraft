# Vault NFL game model

A team power-rating model that produces a **"Vault line"** for each game — a
projected spread, total, and win probability — shown as labeled *context* next to
the market on the Game Markets Edge Board.

- Trainer: [`scripts/build_game_model.py`](../scripts/build_game_model.py) (pure stdlib)
- Data: nflverse `games.csv` (scores + historical closing lines, 1999-present)
- Params: [`data/game_model.json`](../data/game_model.json) (per-team ratings + fitted HFA/sd's)
- Server: `gmPredict()` + `loadGameModel()` in `index.html` (betting module)
- Refit cron: `.github/workflows/update-game-model.yml` (weekly, Wed 15:40 UTC)

## The honest framing — context, not an edge

NFL spreads and totals are the sharpest, most efficient betting markets there are.
The backtest (walk-forward, out-of-sample from 2014, printed by the trainer) is
unambiguous:

| | Model RMSE | Market RMSE | Result |
|---|---|---|---|
| Margin (spread) | 13.21 | 12.87 | ATS 48.4% |
| Total | 13.59 | 13.20 | O/U 48.9% |
| Win prob (Brier) | 0.2215 | 0.2123 | — |

The model **matches the market to ~0.4 points** on both margin and total, but does
**not beat the closing line** (ATS and O/U both below the 52.4% break-even). So the
Vault line is a market-*quality* estimate shown for context and reference — it is
**never** presented as a +EV edge, and the UI styles it in steel/accent (not the
gold that means "value/best price") and labels it "model est." Do not change that.

## The model

Stable online ratings, updated after each game, mean-reverted each new season:

- **Margin**: a net power rating per team. `pred_margin = rate[home] − rate[away] + HFA`.
- **Scoring**: offense/defense points ratings (ridge-pulled to 0 for stability).
  `pred_total = (base + off[home] − def[away] + HFA/2) + (base + off[away] − def[home] − HFA/2)`.
- **Win prob**: `Φ(pred_margin / sd_margin)`.

HFA (mean home margin, last 3 seasons) and the residual sd's are measured from the
walk-forward, not guessed. Learning rates sit on the flat RMSE plateau.

## Gotchas

- **Preseason gate.** The model is fit on regular-season scoring, so its line is
  apples-to-oranges next to a preseason *exhibition* line (starters barely play,
  totals ~35 not ~45). The Vault strip is hidden when `MODEL.season_type` is
  preseason, exactly like Model Lean, and lights up in-season.
- **Offseason regression.** When the last season is complete (Super Bowl played)
  and no next-season games exist yet, the between-season mean-reversion hasn't
  fired, leaving stale full-strength ratings. The trainer applies one carryover in
  that case (`offseason: true` in the output) so an offseason Vault line is a
  next-season-start estimate.
- **Not an edge engine.** It won't beat the close. Its real value is a credible
  context number and a foundation for future context features (e.g. a
  game-environment input, if that ever proves out for props — the prop opponent
  adjustment did not; see [prop-model.md](prop-model.md)).
