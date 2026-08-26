#!/usr/bin/env python3
# ============================================================================
# VAULT · PROP MODEL BACKTEST
#
# Answers the only question that matters for shipping a market: are the model's
# probabilities honest OUT-OF-SAMPLE? Two parts:
#
#  (A) SEASON-HOLDOUT (runnable now, on nflverse history)
#      For each test season T, fit projection + calibration on seasons < T only,
#      then predict every game in T (projecting from prior games, params frozen
#      from the past) and compare predicted P(over) to what actually happened.
#      Reports reliability (predicted vs realized), log-loss, Brier — and, for
#      the TD markets, the TAIL specifically (does "80%" mean 80% on a season the
#      calibration never saw?). This is the go/no-go for un-holding rush/rec TD.
#
#  (B) CLV (closing-line value) harness — reads the banked snapshots in
#      data/prop_line_history.json. True CLV needs live in-season odds, which
#      only start accruing once books post props, so this reports "no settled
#      data yet" in the offseason and is the go-forward validator.
#
# Pure stdlib. Reuses the fitting code in build_prop_projections.py.
#
# Usage:
#   python3 scripts/backtest_prop_model.py                 # all markets, holdout
#   python3 scripts/backtest_prop_model.py --markets=rush_td,rec_td,anytime_td
#   python3 scripts/backtest_prop_model.py --since=2016 --test-from=2022
# ============================================================================
import argparse, math, os, statistics
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

# import the trainer as a module so we reuse its math exactly
_spec = importlib.util.spec_from_file_location("bpp", os.path.join(HERE, "build_prop_projections.py"))
B = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(B)

GRID = [(hl, kv, ke) for hl in [2.5, 4, 6, 9] for kv in [2, 4, 8]
        for ke in ([6, 12, 24] if False else [0])]   # TD/count use ke=0; yards override below


def calibrate(calib, p):
    """Piecewise-linear interpolation on isotonic calibration points (mirror JS)."""
    if not calib:
        return p
    if p <= calib[0][0]:
        return calib[0][1]
    if p >= calib[-1][0]:
        return calib[-1][1]
    for i in range(len(calib) - 1):
        x0, y0 = calib[i]; x1, y1 = calib[i + 1]
        if x0 <= p <= x1:
            t = 0 if x1 == x0 else (p - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return p


POIS_K = None   # optional override of the shrink strength for poisson markets


def fit_market(mkt, spec, train_seq, priors):
    """Fit projection hyperparams + distribution + calibration on train_seq only."""
    kvs = [POIS_K] if (spec["kind"] == "poisson" and POIS_K) else [2, 4, 8]
    grid = ([(hl, kv, ke) for hl in [2.5, 4, 6, 9] for kv in kvs
             for ke in ([6, 12, 24] if spec["kind"] == "yards" else [0])])
    best = None
    for hl, kv, ke in grid:
        resid, preds, actuals, base = B.eval_market(mkt, spec, train_seq, hl, kv, ke, priors)
        if len(preds) < 300:
            continue
        rm = B.rmse(resid)
        if best is None or rm < best["rmse"]:
            best = {"hl": hl, "kv": kv, "ke": ke, "rmse": rm, "preds": preds, "actuals": actuals}
    if not best:
        return None
    if spec["kind"] == "poisson":
        calib = B.fit_calibration_poisson(best["preds"], best["actuals"])
        params = {"dist": "poisson", "hl": best["hl"], "kv": best["kv"], "ke": best["ke"], "calib": calib}
    else:
        count = spec["kind"] == "count"
        v0, v1 = B.fit_sd(best["preds"], best["actuals"])
        calib = B.fit_calibration(best["preds"], best["actuals"], v0, v1, count)
        params = {"dist": "normal", "count": count, "v0": v0, "v1": v1,
                  "hl": best["hl"], "kv": best["kv"], "ke": best["ke"], "calib": calib}
    return params


def project(prior_vals, prior, hl, k):
    return B.project_series(prior_vals, prior, hl, k)


def holdout(markets, since, test_from, use_calib=True):
    seasons = B.load_seasons(since)
    years = sorted(seasons)
    test_years = [y for y in years if y >= test_from and (y - 1) in seasons]

    # collect out-of-sample (pred, hit) pairs per market across all test seasons
    pooled = {mk: [] for mk in markets}
    lines_for = lambda spec: [0.5] if spec["kind"] == "poisson" else None

    for T in test_years:
        train_seq = {}
        for y in years:
            if y < T:
                train_seq.update(B.player_games(seasons[y], y))
        priors = B.compute_priors(train_seq)

        for mk in markets:
            spec = B.MARKETS[mk]
            params = fit_market(mk, spec, train_seq, priors)
            if not params:
                continue
            hl, kv, ke = params["hl"], params["kv"], params["ke"]

            # build per-player [T-1, T] chronological games; score only season-T games
            prevp = B.player_games(seasons[T - 1], T - 1)
            curp = B.player_games(seasons[T], T)
            # index prev by (name,pos)
            prev_by = {}
            for (nm, pos, _), rows in prevp.items():
                prev_by[(nm, pos)] = rows
            for (nm, pos, _), cur_rows in curp.items():
                if pos not in spec["pos"]:
                    continue
                hist = list(prev_by.get((nm, pos), []))          # prior-season tail
                # chronological season-T games
                if spec["kind"] in B.IS_COUNT:
                    prior_vals = [v for v in (
                        B.market_series(hist, spec)) if v is not None]
                    cur_series = B.market_series(cur_rows, spec)
                    for i in range(len(cur_series)):
                        if cur_series[i] is None:
                            continue
                        pv = prior_vals + [v for v in cur_series[:i] if v is not None]
                        if len(pv) < B.MIN_PRIOR:
                            continue
                        lam = project(pv, priors[mk], hl, kv)
                        actual = cur_series[i]
                        if params["dist"] == "poisson":
                            for line in lines_for(spec):
                                raw = B.pois_over(lam, line)
                                p = raw if not use_calib else calibrate(params["calib"], raw)
                                p = max(0.01, min(0.99, p))
                                pooled[mk].append((p, 1.0 if actual >= line else 0.0))
                        else:
                            sd = B.sd_at(params["v0"], params["v1"], lam)
                            for g in (0.85, 1.0, 1.15):
                                line = round(lam * g * 2) / 2 if params["count"] else lam * g
                                raw = B.raw_prob_over(lam, sd, line, params["count"])
                                p = raw if not use_calib else calibrate(params["calib"], raw)
                                p = max(0.01, min(0.99, p))
                                pooled[mk].append((p, 1.0 if actual >= line else 0.0))
    return pooled


def reliability(pairs, edges=(0.0, 0.2, 0.35, 0.5, 0.6, 0.7, 0.8, 1.01)):
    rows = []
    for lo, hi in zip(edges, edges[1:]):
        sub = [(p, h) for p, h in pairs if lo <= p < hi]
        if not sub:
            continue
        pred = statistics.fmean(p for p, _ in sub)
        real = statistics.fmean(h for _, h in sub)
        rows.append((lo, hi, len(sub), pred, real))
    return rows


def metrics(pairs):
    if not pairs:
        return None
    n = len(pairs)
    brier = statistics.fmean((p - h) ** 2 for p, h in pairs)
    ll = statistics.fmean(-(h * math.log(p) + (1 - h) * math.log(1 - p)) for p, h in pairs)
    base = statistics.fmean(h for _, h in pairs)
    ll_base = -(base * math.log(base) + (1 - base) * math.log(1 - base)) if 0 < base < 1 else 0
    return {"n": n, "brier": brier, "logloss": ll, "logloss_base": ll_base, "base_rate": base}


def clv_harness():
    import json
    path = os.path.join(DATA, "prop_line_history.json")
    try:
        blob = json.load(open(path))
    except Exception:
        print("[clv] no prop_line_history.json yet — nothing to grade.")
        return
    props = blob.get("props", {})
    settled = [r for r in props.values() if r.get("open") and r.get("cur")
               and r["open"].get("bestOver") is not None]
    print(f"[clv] {len(props)} props banked; true CLV needs settled in-season closing "
          f"lines vs game outcomes — {len(settled)} have an open+cur snapshot so far. "
          f"Run again once in-season odds accrue.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2016)
    ap.add_argument("--test-from", type=int, default=2022)
    ap.add_argument("--markets", default="pass_td,rush_td,rec_td,anytime_td")
    ap.add_argument("--no-calib", action="store_true", help="use raw distribution prob (skip isotonic) — tests whether calibration helps or overfits")
    ap.add_argument("--pois-k", type=int, default=0, help="override shrink strength for poisson markets")
    args = ap.parse_args()
    if args.pois_k:
        globals()["POIS_K"] = args.pois_k
    markets = [m.strip() for m in args.markets.split(",") if m.strip() in B.MARKETS]

    print(f"[backtest] season-holdout · train<T, test T in [{args.test_from}..] · markets: {', '.join(markets)}"
          f"{' · RAW (no calibration)' if args.no_calib else ''}\n")
    pooled = holdout(markets, args.since, args.test_from, use_calib=not args.no_calib)

    verdict = {}
    for mk in markets:
        pairs = pooled[mk]
        m = metrics(pairs)
        if not m:
            print(f"── {mk}: no out-of-sample points"); continue
        skill = (m["logloss_base"] - m["logloss"]) / m["logloss_base"] * 100 if m["logloss_base"] else 0
        print(f"── {mk}  (held-out n={m['n']}, base rate {m['base_rate']:.3f})")
        print(f"   Brier {m['brier']:.4f} · log-loss {m['logloss']:.4f} vs base {m['logloss_base']:.4f} ({skill:+.1f}% skill)")
        print(f"   reliability (predicted → realized, out-of-sample):")
        tail = [(pred, real, n) for lo, hi, n, pred, real in reliability(pairs) if pred >= 0.6]
        for lo, hi, n, pred, real in reliability(pairs):
            flag = "  ← TAIL" if pred >= 0.6 else ""
            print(f"     [{lo:.2f},{hi:.2f})  n={n:5d}  pred {pred:.3f} → real {real:.3f}{flag}")
        # verdict: is the aggressive tail (pred>=0.6) honest out-of-sample?
        if tail:
            tn = sum(n for _, _, n in tail)
            tpred = sum(pred * n for pred, _, n in tail) / tn
            treal = sum(real * n for _, real, n in tail) / tn
            gap = tpred - treal
            ok = abs(gap) <= 0.07               # within 7 pts = trustworthy
            verdict[mk] = (ok, tpred, treal, gap, tn)
            print(f"   TAIL verdict: predicted {tpred:.3f} vs realized {treal:.3f} "
                  f"(gap {gap:+.3f}, n={tn}) → {'HONEST ✓' if ok else 'OVERCONFIDENT ✗'}")
        else:
            verdict[mk] = (None, None, None, None, 0)
            print("   TAIL verdict: no held-out predictions ≥0.60 — no aggressive tail to worry about")
        print()

    print("── CLV (go-forward) ─────────────────────────────────────────────")
    clv_harness()

    print("\n── UN-HOLD DECISION ─────────────────────────────────────────────")
    for mk in ("rush_td", "rec_td"):
        if mk not in verdict:
            continue
        ok, tpred, treal, gap, tn = verdict[mk]
        if ok is None:
            print(f"  {mk}: no aggressive tail out-of-sample → safe to un-hold")
        elif ok:
            print(f"  {mk}: tail HONEST out-of-sample (pred {tpred:.3f} ≈ real {treal:.3f}) → un-hold")
        else:
            print(f"  {mk}: tail OVERCONFIDENT (pred {tpred:.3f} >> real {treal:.3f}) → KEEP HELD")


if __name__ == "__main__":
    main()
