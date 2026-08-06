#!/usr/bin/env python3
"""
Build PICK-VALUE calibration: is a pick worth more than where the market drafted it?

WHY
---
Suggested Picks' dvPickScore blends ADP + your board rank + Grade Keys quality with
HAND-SET weights (val*1.9, (q-5.6)*0.52, an ~28/35/37 budget). This asks the one
question those weights encode, against real outcomes: does a player's draft-time
tape add predictive power for REALIZED value beyond where the market drafted him
(his reconstructed ADP)? If it doesn't, dvPickScore should lean on ADP + the faller
signal and its 37% grade weight is too high; if it does, the weights should be the
fitted ones, not guesses.

Same discipline as build_grade_calibration.py and the trade-market model: fit,
gate WALK-FORWARD vs a baseline, publish per (position) only on lift, null-fallback
so dvPickScore keeps its current constants until a bucket earns replacement.

DATA
----
  data/redraft_pick_values.json   reconstructed ADP from real Sleeper drafts,
                                   "season|player_id" -> {nm,pos,n,sumov,minov}
                                   (written by build_redraft_strategy.py; needs a
                                   crawl to populate — run that first).
  data/nflverse_stats_<year>.json  prior season = draft-time tape (features);
                                   draft season = realized value (target).

MODEL (per position, walk-forward by season)
  baseline : realized PPG ~ f(adp)                 -- "the market already knows"
  full     : realized PPG ~ f(adp, prior tape)     -- adp + ppg/boom/bust/floor/ceil/games
  A position PUBLISHES only when `full` beats `baseline` out-of-sample. If nothing
  publishes, that is the finding: ADP prices realized value and the pick model
  should trust it (consistent with build_grade_calibration.py's composite-ties-carry
  result).

OUTPUT
  data/pick_value_calibration.json   per-position fitted weights + provenance
                                     (n, oos corr baseline vs full, published), for
                                     wiring dvPickScore's ADP/grade budget.

USAGE
  python3 scripts/build_pick_value.py
  python3 scripts/build_pick_value.py --min-adp-n 5 --ridge 1.0
"""

import argparse
import glob
import json
import math
import os
import re
import statistics as stats

DATA_DIR = "data"
PICKVALS = os.path.join(DATA_DIR, "redraft_pick_values.json")
OUT = os.path.join(DATA_DIR, "pick_value_calibration.json")
POS = ("QB", "RB", "WR", "TE")

# adp = draft price; the tape features are the same six the grade model uses.
TAPE = ["ppg", "boom", "bust", "floor", "ceil", "games"]
BASE_FEATS = ["adp"]
FULL_FEATS = ["adp"] + TAPE

MIN_PUBLISH_N = 60
BEAT_MARGIN = 0.01


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _pctile(sorted_vals, f):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, round(f * (len(sorted_vals) - 1))))
    return sorted_vals[i]


def load_tape(year):
    """normName -> tape dict for one nflverse season (features + realized ppg)."""
    path = os.path.join(DATA_DIR, "nflverse_stats_%d.json" % year)
    if not os.path.exists(path):
        return {}
    raw = json.load(open(path))
    out = {}
    for name, e in raw.items():
        s = e.get("season") or {}
        g = s.get("games") or 0
        if e.get("pos") not in POS:
            continue
        wk = sorted(v for v in (float(w.get("pts", 0)) for w in e.get("weeks", [])) if v == v)
        out[_norm(name)] = {
            "pos": e["pos"],
            "ppg": float(s.get("avg_pts") or 0.0),
            "boom": float(s.get("boom_pct") or 0.0),
            "bust": float(s.get("bust_pct") or 0.0),
            "floor": float(_pctile(wk, 0.20) or 0.0),
            "ceil": float(_pctile(wk, 0.85) or 0.0),
            "games": float(g),
        }
    return out


def build_rows(min_adp_n):
    """(pos, adp, prior_tape_dict, realized_ppg, season) per drafted player-season
    that has a reliable reconstructed ADP AND prior-season tape AND a realized line."""
    pv = json.load(open(PICKVALS)) if os.path.exists(PICKVALS) else {}
    years = sorted(int(re.search(r"(\d{4})", os.path.basename(p)).group(1))
                   for p in glob.glob(os.path.join(DATA_DIR, "nflverse_stats_*.json")))
    tape = {y: load_tape(y) for y in years}
    rows = []
    for key, e in pv.items():
        if e.get("n", 0) < min_adp_n:
            continue
        try:
            sea = int(key.split("|")[0])
        except ValueError:
            continue
        adp = e["sumov"] / e["n"]
        k = _norm(e.get("nm"))
        prior = tape.get(sea - 1, {}).get(k)          # draft-time tape
        realized = tape.get(sea, {}).get(k)           # this-season outcome
        if not prior or not realized:
            continue                                  # rookies / no next line -> can't label here
        rows.append((prior["pos"], adp, prior, realized["ppg"], sea))
    return rows, pv, years


# ---- tiny linear algebra (pure stdlib, mirrors build_grade_calibration.py) ----
def _solve(A, b):
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


def ridge_fit(feats, ys, lam):
    d = len(feats[0])
    cols = list(zip(*feats))
    mu = [stats.fmean(c) for c in cols]
    sd = [stats.pstdev(c) or 1.0 for c in cols]
    ybar = stats.fmean(ys)
    Xs = [[(row[j] - mu[j]) / sd[j] for j in range(d)] for row in feats]
    yc = [y - ybar for y in ys]
    XtX = [[sum(Xs[k][i] * Xs[k][j] for k in range(len(Xs))) for j in range(d)] for i in range(d)]
    for i in range(d):
        XtX[i][i] += lam
    Xty = [sum(Xs[k][i] * yc[k] for k in range(len(Xs))) for i in range(d)]
    w = _solve(XtX, Xty)
    return w, ybar, mu, sd


def predict(w, bias, mu, sd, row):
    return sum((row[j] - mu[j]) / sd[j] * w[j] for j in range(len(row))) + bias


def corr(a, b):
    if len(a) < 3 or stats.pstdev(a) == 0 or stats.pstdev(b) == 0:
        return 0.0
    ma, mb = stats.fmean(a), stats.fmean(b)
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (da * db) if da and db else 0.0


def _mae(p, a):
    return stats.fmean(abs(x - y) for x, y in zip(p, a))


def featvec(names, adp, prior):
    return [(-adp if n == "adp" else prior[n]) for n in names]   # -adp: earlier pick = higher value


def evaluate(rows_pos, names, lam):
    """Walk-forward by season: score season S training only on S'<S. Pooled OOS."""
    data = [(featvec(names, adp, prior), y, sea) for _, adp, prior, y, sea in rows_pos]
    years = sorted({d[2] for d in data})
    pred_all, y_all = [], []
    for ty in years:
        tr = [d for d in data if d[2] < ty]
        te = [d for d in data if d[2] == ty]
        if len(tr) < max(20, 3 * len(names)) or len(te) < 5:
            continue
        w, b, mu, sd = ridge_fit([f for f, _, _ in tr], [y for _, y, _ in tr], lam)
        for f, y, _ in te:
            pred_all.append(predict(w, b, mu, sd, f))
            y_all.append(y)
    w, b, mu, sd = ridge_fit([f for f, _, _ in data], [y for _, y, _ in data], lam)
    return {
        "oos_n": len(y_all),
        "oos_corr": round(corr(pred_all, y_all), 3) if y_all else 0.0,
        "oos_mae": round(_mae(pred_all, y_all), 3) if y_all else 0.0,
        "weights": {names[i]: round(w[i], 4) for i in range(len(names))},
        "bias": round(b, 3),
        "mean": {names[i]: round(mu[i], 3) for i in range(len(names))},
        "std": {names[i]: round(sd[i], 3) for i in range(len(names))},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-adp-n", type=int, default=5,
                    help="min leagues a player must appear in for a reliable ADP")
    ap.add_argument("--ridge", type=float, default=1.0)
    args = ap.parse_args()

    rows, pv, years = build_rows(args.min_adp_n)
    if not pv:
        raise SystemExit(
            "data/redraft_pick_values.json is empty/missing. Run the crawler first to "
            "reconstruct ADP:\n    python3 scripts/build_redraft_strategy.py --league-budget 200")
    seasons = sorted({r[4] for r in rows})
    print("Pick-value calibration  |  %d labeled player-seasons (min ADP n=%d)  |  seasons %s\n"
          % (len(rows), args.min_adp_n, seasons))
    print("%-4s %6s %9s %9s   %8s %8s   %s"
          % ("pos", "n", "corr_adp", "corr_full", "mae_adp", "mae_full", "verdict"))

    by_pos, published = {}, 0
    for pos in POS:
        rp = [r for r in rows if r[0] == pos]
        if len(rp) < 20:
            print("%-4s %6d   (too few labeled rows)" % (pos, len(rp)))
            continue
        base = evaluate(rp, BASE_FEATS, args.ridge)
        full = evaluate(rp, FULL_FEATS, args.ridge)
        beats = (full["oos_corr"] >= base["oos_corr"] + BEAT_MARGIN
                 and full["oos_n"] >= MIN_PUBLISH_N)
        if beats:
            published += 1
        verdict = ("PUBLISH (tape adds signal)" if beats else
                   "thin" if full["oos_n"] < MIN_PUBLISH_N else
                   "ADP already prices it")
        by_pos[pos] = {"n": len(rp), "baseline": base, "full": full, "published": bool(beats)}
        print("%-4s %6d %9.3f %9.3f   %8.3f %8.3f   %s"
              % (pos, len(rp), base["oos_corr"], full["oos_corr"],
                 base["oos_mae"], full["oos_mae"], verdict))

    out = {
        "meta": {
            "labeled_rows": len(rows), "seasons": seasons, "min_adp_n": args.min_adp_n,
            "adp_source": "reconstructed from real Sleeper redraft drafts (redraft_pick_values.json)",
            "target": "realized next-season PPG (nflverse avg_pts)",
            "note": ("Per position, does draft-time tape beat reconstructed-ADP alone at "
                     "predicting realized PPG, walk-forward. Published only on OOS lift; "
                     "else dvPickScore keeps its hand-set ADP/grade budget (null-fallback)."),
        },
        "byPos": by_pos,
        "fallback": None,
    }
    json.dump(out, open(OUT, "w"), indent=2)
    print("\nwrote %s  (%d positions published)" % (OUT, published))
    if not published and rows:
        print("Nothing published: reconstructed ADP already prices realized value; the pick "
              "model should lean on ADP + the faller signal, not add grade weight for VALUE. "
              "(Grade Keys still earn their place for the risk/upside PROFILE, per "
              "build_grade_calibration.py.)")


if __name__ == "__main__":
    main()
