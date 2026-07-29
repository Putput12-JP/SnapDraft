# Vault Fantasy — nflverse data

This directory is populated automatically by GitHub Actions daily at 6am UTC.

Files:
- nflverse_stats.json    — player season stats + weekly breakdown
- nflverse_snaps.json    — weekly snap count percentages
- nflverse_injuries.json — latest injury status
- nflverse_meta.json     — last updated timestamp

Served via GitHub Pages:
https://putput12-jp.github.io/Vault-Fantasy/data/nflverse_stats.json

## Trade market (real Sleeper trades)

Built by `scripts/build_sleeper_trades.py`, refreshed every 6 hours. Methodology and
findings: `docs/trade-market-model.md`.

Served (small, read by the Trade Engines):
- `trade_market.json`  — fitted values, pick prices, fairness bands, acceptance CDFs,
                         package-shape frequencies, positional + weekly trade flow
- `trade_comps.json`   — real packages each player was actually traded for

Bookkeeping (not read by the app):
- `sleeper_trade_state.json`   — which leagues have been pulled, and which are blacklisted
- `sleeper_trade_corpus.json`  — the trade corpus itself, keyed by league, recency-windowed
