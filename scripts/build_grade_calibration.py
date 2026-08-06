#!/usr/bin/env python3
"""
Build GRADE CALIBRATION from real, completed player seasons.

WHY THIS EXISTS
---------------
Grade Keys (Upside / Floor / Risk / Situational) are hand-authored: the coeffs in
computeFactors() -- 0.46*boom + 0.34*ceil + 0.20*ppg for Upside, the risk
multipliers, the scoreFit tables -- were picked by feel, never fit to outcomes.
Measured on 175k real teams, the four factors do NOT separate draft outcomes and
some durable-factor gaps run BACKWARDS vs playoff rate. So the job here is not a
fancier model on top; it is to learn the weights from what actually happened, and
-- just as important -- to find out whether the features carry any signal at all.

A draft grade is really a PREDICTION of next-season production. So we fit exactly
that: features from season N  ->  fantasy PPG in season N+1, per position.

THE HONEST GATE (this is the whole point)
-----------------------------------------
Before shipping any fitted weights we make them EARN it out-of-sample against two
dumb baselines:
  carry   - predict next year = this year's PPG (the "market already knows" null)
  posmean - predict next year = position mean
A fitted model that cannot beat `carry` on a held-out season is decoration. In
that case the script says so and publishes NOTHING for that position -- the
frontend keeps the current hand-authored constant via null-fallback. Mirrors the
discipline in build_sleeper_trades.py (a thin/bad bucket is worse than none) and
the year-over-year kill-test in backtest_redraft_strategy.py.

DATA
----
  data/nflverse_stats_<year>.json   season.{games,avg_pts,boom_pct,bust_pct} +
                                     per-week pts (-> floor=20th / ceil=85th pctile)
The script globs every stats file present (1999-2025 today => ~8k transitions),
so sample size is not the constraint. The constraint is SIGNAL: last-year PPG is
already a strong predictor of next-year PPG, so a fitted linear grade has to beat
THAT, not beat zero.

KNOWN LIMITATION of targeting mean PPG: it collapses Upside/Floor/Risk toward the
same number. A faithful next iteration fits each factor against its OWN outcome
(Upside -> next-year ceiling weeks, Floor -> floor weeks, Risk -> games missed /
bust rate). See the writeup; this version validates the COMPOSITE only.

OUTPUT
------
  data/grade_calibration.json   per position: standardized ridge weights + the
                                feature means/stds to apply them, plus provenance
                                (n, oos correlation, oos MAE vs baselines,
                                published flag). Shape mirrors
                                season_sim_calibration.json (meta/byPos/fallback).

USAGE
  python3 scripts/build_grade_calibration.py
  python3 scripts/build_grade_calibration.py --min-games 6 --ridge 1.0
"""

import argparse
import glob
import json
import math
import os
import re
import statistics as stats

DATA_DIR = "data"
OUT = os.path.join(DATA_DIR, "grade_calibration.json")
POS = ("QB", "RB", "WR", "TE")

# The features are the SAME quantities computeFactors() reads, so fitted weights
# map straight back onto the grade engine. Keep this list and the frontend in sync.
FEATURES = ["ppg", "boom", "bust", "floor", "ceil", "games"]

MIN_PUBLISH_N = 60          # per-position rows needed before we'll publish weights
BEAT_MARGIN   = 0.01        # fitted OOS corr must beat `carry` by at least this


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _pctile(sorted_vals, f):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, round(f * (len(sorted_vals) - 1))))
    return sorted_vals[i]


def load_season(year, min_games):
    """normName -> {pos, feats..., ppg_next-target-material} for one season file."""
    path = os.path.join(DATA_DIR, "nflverse_stats_%d.json" % year)
    if not os.path.exists(path):
        return {}
    raw = json.load(open(path))
    out = {}
    for name, e in raw.items():
        pos = e.get("pos")
        s = e.get("season") or {}
        g = s.get("games") or 0
        if pos not in POS or g < min_games:
            continue
        wk = sorted(v for v in (float(w.get("pts", 0)) for w in e.get("weeks", []))
                    if v == v)
        out[_norm(name)] = {
            "pos": pos,
            "ppg": float(s.get("avg_pts") or 0.0),
            "boom": float(s.get("boom_pct") or 0.0),
            "bust": float(s.get("bust_pct") or 0.0),
            "floor": float(_pctile(wk, 0.20) or 0.0),
            "ceil": float(_pctile(wk, 0.85) or 0.0),
            "games": float(g),
        }
    return out


def transitions(years, min_games):
    """List of (pos, feat-vector, this_season_dict, next_season_dict, target_year)
    for every N -> N+1 pair. target_year = N+1 drives the walk-forward split."""
    seasons = {y: load_season(y, min_games) for y in years}
    rows = []
    for y in years[:-1]:
        a, b = seasons.get(y, {}), seasons.get(y + 1, {})
        for key, fa in a.items():
            fb = b.get(key)
            if not fb:
                continue  # left the league / no next-season data -> no label
            rows.append((fa["pos"], [fa[f] for f in FEATURES], fa, fb, y + 1))
    return rows


# Each grade FACTOR is validated against its OWN outcome, not mean PPG. `target`
# and `carry` name the season-dict field to predict and the naive carry-baseline
# for it. `higher_is` is just documentation of the factor's direction.
FACTOR_TARGETS = [
    ("composite (ppg)", "ppg",   "ppg",   "better"),   # headline, for reference
    ("Upside->ceiling", "ceil",  "ceil",  "better"),
    ("Floor->floor",    "floor", "floor", "better"),
    ("Risk->durability","games", "games", "more games = safer"),
    ("Risk->volatility","bust",  "bust",  "lower = safer"),
]


def factor_rows(rows, field):
    """(pos, feat, target_next[field], carry_this[field], target_year) per factor."""
    return [(pos, feat, nxt[field], cur[field], yr)
            for pos, feat, cur, nxt, yr in rows]


def _solve(A, b):
    """Gaussian elimination with partial pivoting for a small dense system."""
    n = len(A)
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            continue
        M[col], M[piv] = M[piv], M[col]
        pv = M[col][col]
        M[col] = [v / pv for v in M[col]]
        for r in range(n):
            if r != col and M[r][col]:
                f = M[r][col]
                M[r] = [M[r][k] - f * M[col][k] for k in range(n + 1)]
    return [M[i][n] for i in range(n)]


def ridge_fit(rows, lam):
    """Closed-form standardized ridge on a list of (feat-list, target). Returns
    (w, bias, mu, sd) where prediction = ((x-mu)/sd) . w + bias."""
    d = len(FEATURES)
    cols = list(zip(*[r[0] for r in rows]))            # per-feature columns
    mu = [stats.fmean(c) for c in cols]
    sd = [stats.pstdev(c) or 1.0 for c in cols]
    ys = [r[1] for r in rows]
    ybar = stats.fmean(ys)
    Xs = [[(r[0][j] - mu[j]) / sd[j] for j in range(d)] for r in rows]
    yc = [y - ybar for y in ys]
    # Normal equations: (XᵀX + λI) w = Xᵀ yc
    XtX = [[sum(Xs[k][i] * Xs[k][j] for k in range(len(Xs))) for j in range(d)]
           for i in range(d)]
    for i in range(d):
        XtX[i][i] += lam
    Xty = [sum(Xs[k][i] * yc[k] for k in range(len(Xs))) for i in range(d)]
    w = _solve(XtX, Xty)
    return w, ybar, mu, sd


def predict(w, bias, mu, sd, feat):
    d = len(FEATURES)
    return sum((feat[j] - mu[j]) / sd[j] * w[j] for j in range(d)) + bias


def corr(a, b):
    if len(a) < 3 or stats.pstdev(a) == 0 or stats.pstdev(b) == 0:
        return 0.0
    ma, mb = stats.fmean(a), stats.fmean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (da * db) if da and db else 0.0


def _mae(pred, actual):
    return stats.fmean(abs(p - a) for p, a in zip(pred, actual))


MIN_TRAIN = 120         # rows of prior history needed before a season is testable


def evaluate_pos(rows_pos, lam):
    """WALK-FORWARD by target season: to score season S, train ONLY on rows whose
    target_year < S, then predict S. No row from the test year is ever in training,
    so a player's adjacent seasons can't leak across the split. Predictions are
    pooled across all testable seasons, then scored once.
    rows_pos: list of (pos, feat, target, carry, year)."""
    data = [(r[1], r[2], r[3], r[4]) for r in rows_pos]   # (feat, target, carry, year)
    n = len(data)
    years = sorted({d[3] for d in data})

    pred_all, y_all, carry_all, tested_years = [], [], [], []
    for ty in years:
        tr = [d for d in data if d[3] < ty]
        te = [d for d in data if d[3] == ty]
        if len(tr) < MIN_TRAIN or len(te) < 5:
            continue
        w, b, mu, sd = ridge_fit([(f, t) for f, t, _, _ in tr], lam)
        for f, t, c, _ in te:
            pred_all.append(predict(w, b, mu, sd, f))
            y_all.append(t)
            carry_all.append(c)
        tested_years.append(ty)

    w, b, mu, sd = ridge_fit([(f, t) for f, t, _, _ in data], lam)  # final: ALL rows
    r3 = lambda v: round(v, 3)
    return {
        "n": n,
        "oos_n": len(y_all),
        "tested_seasons": [tested_years[0], tested_years[-1]] if tested_years else [],
        "oos_corr_fit": r3(corr(pred_all, y_all)) if y_all else 0.0,
        "oos_corr_carry": r3(corr(carry_all, y_all)) if y_all else 0.0,
        "oos_mae_fit": r3(_mae(pred_all, y_all)) if y_all else 0.0,
        "oos_mae_carry": r3(_mae(carry_all, y_all)) if y_all else 0.0,
        "weights": {FEATURES[i]: round(w[i], 4) for i in range(len(FEATURES))},
        "bias": round(b, 3),
        "mean": {FEATURES[i]: round(mu[i], 3) for i in range(len(FEATURES))},
        "std": {FEATURES[i]: round(sd[i], 3) for i in range(len(FEATURES))},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-games", type=int, default=4)
    ap.add_argument("--ridge", type=float, default=1.0)
    args = ap.parse_args()

    files = sorted(int(re.search(r"(\d{4})", os.path.basename(p)).group(1))
                   for p in glob.glob(os.path.join(DATA_DIR, "nflverse_stats_*.json")))
    if len(files) < 2:
        raise SystemExit("need >=2 nflverse_stats_<year>.json files, found %d" % len(files))

    rows = transitions(files, args.min_games)
    print("Grade calibration  |  seasons %d-%d  |  %d transition rows\n"
          % (files[0], files[-1], len(rows)))

    by_factor = {}
    published_total = 0
    for label, field, carry_field, direction in FACTOR_TARGETS:
        frows = factor_rows(rows, field)
        print("── %-18s (target: next-yr %s | %s)" % (label, field, direction))
        print("   %-4s %6s %9s %10s %8s %8s   %s" %
              ("pos", "n", "corr_fit", "corr_carry", "mae_fit", "mae_car", "verdict"))
        by_pos = {}
        for pos in POS:
            rp = [r for r in frows if r[0] == pos]
            if len(rp) < 8:
                print("   %-4s %6d   (too few rows)" % (pos, len(rp)))
                continue
            m = evaluate_pos(rp, args.ridge)
            beats = (m["oos_corr_fit"] >= m["oos_corr_carry"] + BEAT_MARGIN
                     and m["n"] >= MIN_PUBLISH_N)
            m["published"] = bool(beats)
            by_pos[pos] = m
            if beats:
                published_total += 1
            verdict = ("PUBLISH" if beats else
                       "thin" if m["n"] < MIN_PUBLISH_N else
                       "no lift vs carry")
            print("   %-4s %6d %9.3f %10.3f %8.3f %8.3f   %s" %
                  (pos, m["n"], m["oos_corr_fit"], m["oos_corr_carry"],
                   m["oos_mae_fit"], m["oos_mae_carry"], verdict))
        by_factor[field] = {"label": label, "target": field, "carry": carry_field,
                            "direction": direction, "byPos": by_pos}
        print()

    out = {
        "meta": {
            "built_from": ["nflverse_stats_%d.json" % y for y in files],
            "transitions": len(files) - 1,
            "features": FEATURES,
            "ridge": args.ridge,
            "min_games": args.min_games,
            "note": ("Each grade FACTOR fitted against its OWN next-season outcome "
                     "(Upside->ceiling weeks, Floor->floor weeks, Risk->games & bust), "
                     "not mean PPG. A (factor,position) publishes only when its fitted "
                     "OOS ranking beats the naive carry baseline. Unpublished -> "
                     "frontend keeps the hand-authored constant (null-fallback)."),
        },
        "byFactor": by_factor,
        # Getter returns null for any (factor,pos) absent or unpublished; caller
        # keeps its current constant. Never emit 0 -- "not modeled" != "measured 0".
        "fallback": None,
    }
    json.dump(out, open(OUT, "w"), indent=2)
    print("wrote %s  (%d (factor,position) cells published)" % (OUT, published_total))
    if not published_total:
        print("Nothing published: for every factor, the features don't out-RANK the "
              "naive carry of that same stat. That is the real finding -- the factors "
              "are re-encoding last year's version of themselves, not adding signal.")


if __name__ == "__main__":
    main()
