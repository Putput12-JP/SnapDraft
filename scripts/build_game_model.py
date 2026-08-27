#!/usr/bin/env python3
# ============================================================================
# VAULT · NFL GAME MODEL  →  data/game_model.json
#
# A team power-rating model that produces a "Vault line" for each game: a
# projected spread, total, and win probability. Fit from real game scores
# (nflverse games.csv, 1999-present, which also carries the historical closing
# lines used to validate it).
#
# HONEST FRAMING (measured — see the backtest it prints):
#   The model MATCHES the market to ~0.4 pts on margin and total, but does NOT
#   beat the closing line (ATS ~49%, O/U ~49%, win-prob Brier just behind the
#   market). NFL closing lines are the sharpest forecast there is. So the Vault
#   line is shipped as a market-QUALITY *context* number — a model estimate shown
#   next to the market — NEVER as a +EV edge. Do not label it as one.
#
# MODEL (stable online ratings, updated after each game, mean-reverted each
# season):
#   margin: net rating per team; pred_margin = rate[home] − rate[away] + HFA
#   scoring: off/def points ratings; pred_total = home_pts + away_pts
#   win prob: Φ(pred_margin / sd_margin)
#
# Pure stdlib (json/math/statistics/urllib). No numpy/pandas.
#
# Usage:
#   python3 scripts/build_game_model.py            # fit + backtest + write
#   python3 scripts/build_game_model.py --dry      # fit + backtest, no write
# ============================================================================
import argparse, csv, io, json, math, os, ssl, statistics, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "game_model.json")
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# fitted online-learning rates (flat RMSE plateau across the grid; these sit at
# the minimum). HFA and the sd's are measured from the walk-forward below.
K_MARGIN = 0.065
K_SCORE = 0.045
CARRY = 0.72          # cross-season mean-reversion of ratings
RIDGE = 0.05          # pull scoring ratings toward 0 each update
BASE_PTS = 22.7       # league avg points per team per game
TRAIN_FROM = 2006     # ratings warm up from here
TEST_FROM = 2014      # backtest window (fully warmed ratings)

# nflverse uses current team codes; map any legacy codes the live feed might send.
ALIAS = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS"}


def norm_team(t):
    t = (t or "").upper()
    return ALIAS.get(t, t)


def fetch_games():
    """games.csv → list of completed-game dicts. requests in CI, urllib locally."""
    text = None
    try:
        import requests
        text = requests.get(GAMES_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=90).text
    except Exception:
        import urllib.request
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(GAMES_URL, headers={"User-Agent": "Mozilla/5.0"})
        text = urllib.request.urlopen(req, timeout=90, context=ctx).read().decode("utf-8", "replace")

    def f(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    out = []
    for r in csv.DictReader(io.StringIO(text)):
        hs, as_ = f(r["home_score"]), f(r["away_score"])
        season = int(r["season"]) if r.get("season", "").isdigit() else None
        if season is None or season < TRAIN_FROM:
            continue
        wk = int(r["week"]) if r.get("week", "").isdigit() else 99
        rec = {"season": season, "week": wk, "ht": norm_team(r["home_team"]), "at": norm_team(r["away_team"]),
               "hs": hs, "as_": as_, "spread": f(r.get("spread_line")), "total_line": f(r.get("total_line")),
               "played": hs is not None and as_ is not None}
        out.append(rec)
    out.sort(key=lambda g: (g["season"], g["week"]))
    return out


def run(games, collect_from=None):
    """
    Walk the games in order, predicting each BEFORE updating (so predictions are
    out-of-sample), mean-reverting ratings each new season. Returns final ratings
    and the list of prediction records from `collect_from` onward.
    """
    rate = defaultdict(float)                 # net margin rating
    off = defaultdict(float); dff = defaultdict(float)  # scoring ratings (pts vs avg)
    cur = None
    preds = []
    for g in games:
        if g["season"] != cur:
            if cur is not None:
                for t in rate: rate[t] *= CARRY
                for t in off: off[t] *= CARRY; dff[t] *= CARRY
            cur = g["season"]
        pm = rate[g["ht"]] - rate[g["at"]] + HFA
        ph = BASE_PTS + off[g["ht"]] - dff[g["at"]] + HFA / 2
        pa = BASE_PTS + off[g["at"]] - dff[g["ht"]] - HFA / 2
        pt = ph + pa
        if not g["played"]:
            continue
        if collect_from is not None and g["season"] >= collect_from:
            preds.append({"pm": pm, "pt": pt, "result": g["hs"] - g["as_"], "total": g["hs"] + g["as_"],
                          "spread": g["spread"], "total_line": g["total_line"],
                          "home_win": 1 if g["hs"] > g["as_"] else 0})
        # updates
        em = (g["hs"] - g["as_"]) - pm
        rate[g["ht"]] += K_MARGIN * em; rate[g["at"]] -= K_MARGIN * em
        eh = g["hs"] - ph; ea = g["as_"] - pa
        off[g["ht"]] += K_SCORE * (eh - RIDGE * off[g["ht"]]); dff[g["at"]] -= K_SCORE * (eh - RIDGE * dff[g["at"]])
        off[g["at"]] += K_SCORE * (ea - RIDGE * off[g["at"]]); dff[g["ht"]] -= K_SCORE * (ea - RIDGE * dff[g["ht"]])
    return rate, off, dff, preds


HFA = 1.6   # provisional; re-fit from data below


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def backtest(games):
    """Walk-forward metrics from TEST_FROM: model vs the market's closing line."""
    _, _, _, preds = run(games, collect_from=TEST_FROM)
    rt = lambda a: math.sqrt(statistics.fmean(a))
    mp = [p for p in preds if p["spread"] is not None]
    tp = [p for p in preds if p["total_line"] is not None]
    m = {
        "n": len(preds),
        "margin_rmse": round(rt([(p["pm"] - p["result"]) ** 2 for p in preds]), 3),
        "market_margin_rmse": round(rt([(p["spread"] - p["result"]) ** 2 for p in mp]), 3),
        "ats_pct": round(statistics.fmean([(1 if p["result"] > p["spread"] else 0) if p["pm"] > p["spread"]
                          else (1 if p["result"] < p["spread"] else 0) for p in mp]) * 100, 1),
        "total_rmse": round(rt([(p["pt"] - p["total"]) ** 2 for p in tp]), 3),
        "market_total_rmse": round(rt([(p["total_line"] - p["total"]) ** 2 for p in tp]), 3),
        "ou_pct": round(statistics.fmean([(1 if p["total"] > p["total_line"] else 0) if p["pt"] > p["total_line"]
                         else (1 if p["total"] < p["total_line"] else 0) for p in tp]) * 100, 1),
        "brier": round(statistics.fmean([(phi(p["pm"] / SD_MARGIN) - p["home_win"]) ** 2 for p in preds]), 4),
        "market_brier": round(statistics.fmean([(phi(p["spread"] / SD_MARGIN) - p["home_win"]) ** 2 for p in mp]), 4),
    }
    return m


SD_MARGIN = 13.2   # provisional; re-fit below
SD_TOTAL = 13.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    global HFA, SD_MARGIN, SD_TOTAL

    print("[game-model] fetching nflverse games.csv …")
    games = fetch_games()
    played = [g for g in games if g["played"]]
    print(f"[game-model] {len(played)} completed games {games[0]['season']}–{played[-1]['season']}")

    # fit HFA = mean home margin over the last 3 completed seasons
    last3 = sorted({g["season"] for g in played})[-3:]
    HFA = round(statistics.fmean([g["hs"] - g["as_"] for g in played if g["season"] in last3]), 3)

    # fit the residual sd's from the walk-forward, then recompute metrics with them
    _, _, _, preds = run(games, collect_from=TEST_FROM)
    SD_MARGIN = round(statistics.pstdev([p["pm"] - p["result"] for p in preds]), 3)
    SD_TOTAL = round(statistics.pstdev([p["pt"] - p["total"] for p in preds]), 3)

    m = backtest(games)
    print(f"[game-model] HFA {HFA} · sd_margin {SD_MARGIN} · sd_total {SD_TOTAL}")
    print(f"[game-model] BACKTEST (n={m['n']}, out-of-sample from {TEST_FROM}):")
    print(f"   margin RMSE {m['margin_rmse']} vs market {m['market_margin_rmse']}  · ATS {m['ats_pct']}%")
    print(f"   total  RMSE {m['total_rmse']} vs market {m['market_total_rmse']}  · O/U {m['ou_pct']}%")
    print(f"   win-prob Brier {m['brier']} vs market {m['market_brier']}")
    print(f"   → matches the market, does NOT beat the close (context line, not an edge)")

    # final ratings from ALL completed games (current strength)
    rate, off, dff, _ = run(games)
    through = max((g["season"], g["week"]) for g in played)
    # If the latest season is fully complete (Super Bowl played, week >= 22) and no
    # next-season games exist yet, the between-season mean-reversion hasn't fired —
    # apply it once so an offseason "Vault line" is a next-season-start estimate,
    # not a stale end-of-season rating.
    latest = through[0]
    season_done = max((g["week"] for g in played if g["season"] == latest), default=0) >= 22
    offseason = season_done and not any(g["season"] > latest for g in played)
    if offseason:
        for t in rate: rate[t] *= CARRY
        for t in off: off[t] *= CARRY; dff[t] *= CARRY
    teams = {t: {"rate": round(rate[t], 3), "off": round(off[t], 3), "def": round(dff[t], 3)}
             for t in sorted(set(list(rate) + list(off)))}

    model = {
        "generated": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "through_season": through[0], "through_week": through[1], "offseason": offseason,
        "base_pts": BASE_PTS, "hfa": HFA, "sd_margin": SD_MARGIN, "sd_total": SD_TOTAL,
        "params": {"k_margin": K_MARGIN, "k_score": K_SCORE, "carry": CARRY, "ridge": RIDGE},
        "teams": teams, "backtest": m,
        "note": "Context line only — matches the market, does not beat the close. Never present as +EV.",
    }
    if args.dry:
        print("[game-model] --dry: not written")
        return
    with open(OUT, "w") as f:
        json.dump(model, f)
    print(f"[game-model] wrote {OUT} · {len(teams)} teams")


if __name__ == "__main__":
    main()
