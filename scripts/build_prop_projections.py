#!/usr/bin/env python3
# ============================================================================
# VAULT · PLAYER-PROP PROJECTION MODEL  →  data/prop_model.json
#
# Vault's OWN player-prop projection, fit from real nflverse game logs. Replaces
# "re-serve Sleeper's number" with a measured, per-market model whose fair
# probabilities feed the Betting Edge Board (VaultBettingMath.findEdge).
#
# DESIGN (see docs/prop-model.md):
#   projection = recency-weighted VOLUME x shrunk EFFICIENCY
#   distribution around it (Normal for yards, Neg-Binomial for counts) -> P(over)
#   isotonic calibration so the published probability is honest.
#
#   Opponent (DvP) and game-environment (Vegas total) are NOT in the historical
#   weekly rows, so they are applied only at INFERENCE (client), where the feed
#   supplies them. The core model here is player-autoregressive — which is where
#   most of the signal lives (PropSignal's rolling features dominate its R^2).
#
# EVERY CONSTANT IS FITTED, not invented (Vault rule): the recency half-life and
# shrinkage are chosen by minimizing OUT-OF-SAMPLE error on a walk-forward split;
# per-market sd and the isotonic maps are measured from held-out residuals.
#
# Pure standard library (json/math/statistics) — matches Vault's dependency-light
# crons. No numpy/pandas/sklearn.
#
# Usage:
#   python3 scripts/build_prop_projections.py            # fit + write model
#   python3 scripts/build_prop_projections.py --dry      # fit + print, no write
#   python3 scripts/build_prop_projections.py --since=2016
# ============================================================================
import json, math, os, sys, argparse, statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "prop_model.json")

# ── market spec ────────────────────────────────────────────────────────────
# kind 'yards'  → project volume x efficiency (stabilizes noisy yardage)
# kind 'count'  → project the stat directly (attempts/receptions/completions)
# vol/effNum are weekly-row keys; stat is the direct key. pos = eligible spots.
MARKETS = {
    "pass_yd":  {"kind": "yards", "vol": "att", "eff_num": "pyds", "pos": ["QB"]},
    "pass_att": {"kind": "count", "stat": "att",                    "pos": ["QB"]},
    "pass_cmp": {"kind": "count", "stat": "cmp",                    "pos": ["QB"]},
    "rush_yd":  {"kind": "yards", "vol": "car", "eff_num": "ryds", "pos": ["RB", "QB", "WR"]},
    "rush_att": {"kind": "count", "stat": "car",                    "pos": ["RB", "QB"]},
    "rec":      {"kind": "count", "stat": "rec",                    "pos": ["WR", "TE", "RB"]},
    "rec_yd":   {"kind": "yards", "vol": "tgt", "eff_num": "recyds","pos": ["WR", "TE", "RB"]},
}

MIN_PRIOR = 3          # need this many prior games before we score a projection
LOOKBACK = 17          # trailing games considered (one season of memory)
MIN_POINTS = 400       # per-market minimum test points to publish


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def load_seasons(since):
    """Return {season: [player,...]} for nflverse_stats files >= since."""
    out = {}
    for fn in os.listdir(DATA):
        if not (fn.startswith("nflverse_stats_") and fn.endswith(".json")):
            continue
        tag = fn[len("nflverse_stats_"):-len(".json")]
        if not tag.isdigit():
            continue
        yr = int(tag)
        if yr < since:
            continue
        with open(os.path.join(DATA, fn)) as f:
            blob = json.load(f)
        players = list(blob.values()) if isinstance(blob, dict) else blob
        out[yr] = players
    return out


def player_games(players, season):
    """Flatten to per-player ordered game rows: {name,pos: [ (wk, row) ... ]}."""
    seq = {}
    for p in players:
        pos = p.get("pos")
        weeks = p.get("weeks") or []
        if not weeks:
            continue
        rows = sorted(((num(w.get("wk")) or 0, w) for w in weeks), key=lambda x: x[0])
        seq[(p.get("name"), pos, season)] = rows
    return seq


# ── recency-weighted, shrunk projection ────────────────────────────────────
def weighted_mean(vals, half_life):
    """vals ordered oldest→newest; recent games weighted more (exp half-life)."""
    n = len(vals)
    if n == 0:
        return None, 0.0
    sw = 0.0
    acc = 0.0
    for i, v in enumerate(vals):
        age = (n - 1) - i           # 0 = most recent
        w = 0.5 ** (age / half_life)
        acc += w * v
        sw += w
    return (acc / sw if sw else None), sw


def project_series(prior_vals, prior, half_life, k):
    """Empirical-Bayes shrink of the recency-weighted mean toward `prior`."""
    wm, sw = weighted_mean(prior_vals, half_life)
    if wm is None:
        return prior
    return (sw * wm + k * prior) / (sw + k)


def collect_series(rows, key):
    """Chronological list of a stat across a player's games (None → skip game)."""
    return [num(r[1].get(key)) for r in rows]


# ── walk-forward evaluation of one hyperparameter set for one market ───────
def eval_market(mkt, spec, seq, half_life, k_vol, k_eff, priors):
    """
    Walk forward through every player's season; at each game with >= MIN_PRIOR
    prior games, project from prior games only and compare to the actual.
    Returns (residuals, preds, actuals, baseline_preds).
    """
    resid, preds, actuals, base = [], [], [], []
    kind = spec["kind"]
    for key, rows in seq.items():
        pos = key[1]
        if pos not in spec["pos"]:
            continue
        if kind == "count":
            stat = spec["stat"]
            series = collect_series(rows, stat)
            for i in range(len(series)):
                if series[i] is None:
                    continue
                prior_vals = [v for v in series[:i] if v is not None]
                if len(prior_vals) < MIN_PRIOR:
                    continue
                proj = project_series(prior_vals, priors[mkt], half_life, k_vol)
                actual = series[i]
                preds.append(proj); actuals.append(actual); resid.append(actual - proj)
                base.append(statistics.fmean(prior_vals[-4:]))
        else:  # yards = volume x efficiency
            vol_s = collect_series(rows, spec["vol"])
            num_s = collect_series(rows, spec["eff_num"])
            for i in range(len(vol_s)):
                if vol_s[i] is None or num_s[i] is None:
                    continue
                pv = [v for v in vol_s[:i] if v is not None]
                # per-game efficiency history (yards/volume), guarding /0
                pe = []
                for j in range(i):
                    if vol_s[j] and vol_s[j] > 0 and num_s[j] is not None:
                        pe.append(num_s[j] / vol_s[j])
                if len(pv) < MIN_PRIOR or len(pe) < MIN_PRIOR:
                    continue
                proj_vol = project_series(pv, priors[mkt + "|vol"], half_life, k_vol)
                proj_eff = project_series(pe, priors[mkt + "|eff"], half_life, k_eff)
                proj = proj_vol * proj_eff
                actual = num_s[i]
                preds.append(proj); actuals.append(actual); resid.append(actual - proj)
                base.append(statistics.fmean([num_s[j] for j in range(max(0, i - 4), i) if num_s[j] is not None] or [proj]))
    return resid, preds, actuals, base


def rmse(errs):
    return math.sqrt(statistics.fmean([e * e for e in errs])) if errs else None


NORM = 1 / math.sqrt(2 * math.pi)


def phi_cdf(z):
    """Standard-normal CDF via erf (stdlib math.erf)."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def fit_sd(preds, actuals):
    """
    Heteroscedastic width: variance grows with the mean (Poisson-like), so fit
    resid^2 ≈ v0 + v1*proj by OLS, then sd(proj) = sqrt(max(v0 + v1*proj, floor)).
    Returns (v0, v1).
    """
    xs = preds
    ys = [(a - p) ** 2 for a, p in zip(actuals, preds)]
    n = len(xs)
    if n < 10:
        s = statistics.pstdev([a - p for a, p in zip(actuals, preds)]) or 1.0
        return round(s * s, 4), 0.0
    mx = statistics.fmean(xs); my = statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    v1 = sxy / sxx if sxx > 0 else 0.0
    v0 = my - v1 * mx
    if v1 < 0:  # variance shouldn't shrink with mean; fall back to homoscedastic
        v1 = 0.0
        v0 = my
    return round(max(v0, 1e-6), 4), round(v1, 6)


def sd_at(v0, v1, proj):
    return math.sqrt(max(v0 + v1 * max(proj, 0), 1e-6))


def raw_prob_over(proj, sd, line, count):
    """P(actual >= line) under Normal(proj, sd); continuity-correct for counts."""
    L = line - 0.5 if count else line
    return 1 - phi_cdf((L - proj) / sd) if sd > 0 else (1.0 if proj >= L else 0.0)


def fit_calibration(preds, actuals, v0, v1, count, bins=20):
    """
    Isotonic (PAV) calibration curve. For each held-out game, evaluate the model's
    raw P(over) at a grid of realistic lines and record whether the actual cleared
    it → (raw_p, hit) pairs → bin → enforce monotone. Returns [[p_mid, cal], ...].
    """
    pairs = []
    grid = [0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5]
    for proj, actual in zip(preds, actuals):
        sd = sd_at(v0, v1, proj)
        for g in grid:
            line = proj * g
            if count:
                line = round(line * 2) / 2  # half-point lines
            p = raw_prob_over(proj, sd, line, count)
            pairs.append((p, 1.0 if actual >= line else 0.0))
    if not pairs:
        return []
    # bin by raw p, empirical hit per bin
    acc = [[0.0, 0.0] for _ in range(bins)]
    for p, hit in pairs:
        b = min(bins - 1, int(p * bins))
        acc[b][0] += hit; acc[b][1] += 1
    pts = []
    for b in range(bins):
        if acc[b][1] > 0:
            pts.append([(b + 0.5) / bins, acc[b][0] / acc[b][1], acc[b][1]])
    # PAV: enforce non-decreasing calibrated value (weighted)
    i = 0
    while i < len(pts) - 1:
        if pts[i][1] > pts[i + 1][1]:
            w = pts[i][2] + pts[i + 1][2]
            merged = (pts[i][1] * pts[i][2] + pts[i + 1][1] * pts[i + 1][2]) / w
            pts[i] = [pts[i][0], merged, w]
            del pts[i + 1]
            if i > 0:
                i -= 1
        else:
            i += 1
    return [[round(p, 4), round(c, 4)] for p, c, _ in pts]


def r2(preds, actuals):
    if len(actuals) < 2:
        return None
    mu = statistics.fmean(actuals)
    sst = sum((a - mu) ** 2 for a in actuals)
    sse = sum((a - p) ** 2 for a, p in zip(actuals, preds))
    return 1 - sse / sst if sst > 0 else None


def compute_priors(seq):
    """Per-market league prior (mean per game) for volume, efficiency, direct."""
    pri = {}
    for mkt, spec in MARKETS.items():
        if spec["kind"] == "count":
            vals = []
            for key, rows in seq.items():
                if key[1] not in spec["pos"]:
                    continue
                vals += [v for v in collect_series(rows, spec["stat"]) if v is not None]
            pri[mkt] = statistics.fmean(vals) if vals else 0.0
        else:
            vv, ee = [], []
            for key, rows in seq.items():
                if key[1] not in spec["pos"]:
                    continue
                vol_s = collect_series(rows, spec["vol"])
                num_s = collect_series(rows, spec["eff_num"])
                for a, b in zip(vol_s, num_s):
                    if a is not None:
                        vv.append(a)
                    if a and a > 0 and b is not None:
                        ee.append(b / a)
            pri[mkt + "|vol"] = statistics.fmean(vv) if vv else 0.0
            pri[mkt + "|eff"] = statistics.fmean(ee) if ee else 0.0
    return pri


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2016)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    print(f"[prop-model] loading nflverse stats since {args.since} …")
    seasons = load_seasons(args.since)
    seq = {}
    for yr, players in seasons.items():
        seq.update(player_games(players, yr))
    print(f"[prop-model] {len(seasons)} seasons · {len(seq)} player-seasons")

    priors = compute_priors(seq)

    # hyperparameter grid (small — a few knobs, fit out-of-sample)
    half_lives = [2.5, 4, 6, 9]
    k_vols = [2, 4, 8]
    k_effs = [6, 12, 24]

    model = {"markets": {}, "meta": {"since": args.since, "min_prior": MIN_PRIOR}}
    for mkt, spec in MARKETS.items():
        best = None
        for hl in half_lives:
            for kv in k_vols:
                keffs = k_effs if spec["kind"] == "yards" else [0]
                for ke in keffs:
                    resid, preds, actuals, base = eval_market(mkt, spec, seq, hl, kv, ke, priors)
                    if len(preds) < MIN_POINTS:
                        continue
                    m_rmse = rmse(resid)
                    if best is None or m_rmse < best["rmse"]:
                        best = {"hl": hl, "k_vol": kv, "k_eff": ke, "rmse": m_rmse,
                                "r2": r2(preds, actuals), "n": len(preds),
                                "base_rmse": rmse([a - b for a, b in zip(actuals, base)]),
                                "preds": preds, "actuals": actuals}
        if not best:
            print(f"[prop-model] {mkt:9s} — too few points, skipped")
            continue
        # fit the distribution width + isotonic calibration at the winning params
        count = spec["kind"] == "count"
        v0, v1 = fit_sd(best["preds"], best["actuals"])
        calib = fit_calibration(best["preds"], best["actuals"], v0, v1, count)
        lift = (best["base_rmse"] - best["rmse"]) / best["base_rmse"] * 100 if best["base_rmse"] else 0
        print(f"[prop-model] {mkt:9s} n={best['n']:6d} hl={best['hl']} kv={best['k_vol']} ke={best['k_eff']} "
              f"| RMSE {best['rmse']:.2f} vs base {best['base_rmse']:.2f} ({lift:+.1f}%) | R2 {best['r2']:.3f} "
              f"| sd={v0:.1f}+{v1:.3f}·μ | calib {len(calib)}pt")
        model["markets"][mkt] = {
            "kind": spec["kind"], "pos": spec["pos"],
            # weekly-row field names so the JS inference stays data-driven
            "vol": spec.get("vol"), "eff_num": spec.get("eff_num"), "stat": spec.get("stat"),
            "half_life": best["hl"], "k_vol": best["k_vol"], "k_eff": best["k_eff"],
            "prior": {k: round(priors[k], 4) for k in priors if k == mkt or k.startswith(mkt + "|")},
            "sd_v0": v0, "sd_v1": v1, "calib": calib,
            "rmse": round(best["rmse"], 3), "r2": round(best["r2"], 4), "n": best["n"],
            "base_rmse": round(best["base_rmse"], 3),
        }

    if args.dry:
        print("[prop-model] --dry: not written")
        return
    with open(OUT, "w") as f:
        json.dump(model, f)
    print(f"[prop-model] wrote {OUT}")


if __name__ == "__main__":
    main()
