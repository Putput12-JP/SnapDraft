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
    # TD markets — rare counts, so the projection (λ) drives a POISSON tail, not
    # a Normal. Projected like a count; only the distribution/calibration differ.
    "pass_td":  {"kind": "poisson", "stat": "ptds",  "pos": ["QB"]},
    # rush_td: SHIPS RAW (no_calib), same story as the combined-TD markets. The
    # season-holdout first flagged its calibrated tail as non-transferring, but the
    # culprit was the isotonic calibration, not the projection: raw, its favored-
    # side grade clears A/B/C at the bettable 0.5 line even at w=1 (A .85/B .65/
    # C .57), and with the shared 0.85 shrink clears comfortably (A .86/B .72/C .61,
    # monotonic; A-overs realize .72 honest). Validated scratchpad/validate_rush_td.py.
    "rush_td":  {"kind": "poisson", "stat": "rtds",  "pos": ["RB", "QB", "WR"], "no_calib": True},
    # rec_td: SHIPS. Backtest = +8.7% out-of-sample log-loss skill and no
    # overconfident tail (receiving TDs rarely produce a high, non-transferring λ).
    # USAGE-projected: λ = projected targets × projected (rec-TD per target),
    # which beats the raw recency TD rate OOS (~+4% log-loss). Receiving TDs track
    # opportunity; rushing TDs (goal-line) do not, so only rec_td gets vol/eff.
    "rec_td":   {"kind": "poisson", "stat": "rectds", "vol": "tgt", "eff_num": "rectds", "pos": ["WR", "TE", "RB"]},
    # Anytime TD = any non-passing TD; λ = combined rush+rec TD rate, P = 1−e^(−λ).
    # SHIPS RAW (no_calib): the season-holdout showed the CALIBRATION was the
    # problem, not the projection — isotonic PAV overfits the rare-event TD tail,
    # so calibrating DESTROYS an otherwise-clearing grade. With calibration off the
    # grade scoreboard passes out-of-sample (A/B/C clear the 55% break-even,
    # A 0.95 / B 0.79 / C 0.61). See no_calib note below + docs/prop-td-redzone-plan.md.
    "anytime_td": {"kind": "poisson", "stat_sum": ["rtds", "rectds"], "pos": ["RB", "WR", "TE", "QB"], "no_calib": True},
    # Rush + Rec TD O/U — SAME combined-TD λ as anytime_td, TWO-SIDED (0.5/1.5/2.5).
    # Also SHIPS RAW. With the isotonic calib ON its bettable grades collapsed
    # (B 0.54, C 0.34); with it OFF they clear out-of-sample (A 0.95 / B 0.79 /
    # C 0.59). The red-zone/goal-line data pull was spiked and REJECTED (goal-line
    # opportunity adds no OOS lift and worsens the tail — docs/prop-td-redzone-plan.md);
    # dropping the overfit calibration is what actually un-held these markets.
    "rush_rec_td": {"kind": "poisson", "stat_sum": ["rtds", "rectds"], "pos": ["RB", "WR", "TE"], "no_calib": True},
}
IS_COUNT = {"count", "poisson"}      # projected the same way (direct stat, shrunk)
# no_calib: SHIP the raw distribution prob (calib=[] → identity, shrink=1.0). Only
# the rare-event combined-TD markets use it — isotonic PAV overfits their tail so
# badly that calibrating turns a clearing grade into a coin flip. rec_td/pass_td
# keep their calibration (they validated WITH it).
NO_CALIB = {mkt for mkt, spec in MARKETS.items() if spec.get("no_calib")}
# Confidence shrink (temperature toward 0.5) applied to the RAW TD markets instead
# of a fitted one: fit_shrink minimizes log-loss over pooled probs → w≈1, which
# misses the overconfident MID-tail. This w is the value at which the season-
# holdout grade ladder becomes monotonic and A/B/C clear the 55% break-even at the
# BETTABLE 0.5 line, validated per-market (scratchpad/validate_raw_td.py: rush_rec_td
# A .84/B .73/C .62, anytime_td A .85/B .72/C .63). Pure raw (w=1) left C at 0.53.
TD_RAW_SHRINK = 0.85
HOLD = set()                          # all TD markets now ship raw (validated); nothing held


def is_usage(spec):
    """A market projects via volume × efficiency (usage) iff it declares both.
    Yards always; rec_td opts in (targets × TD-rate). Everything else is a direct
    recency-shrunk projection of its own stat."""
    return bool(spec.get("vol") and spec.get("eff_num"))

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


def collect_sum_series(rows, keys):
    """Per-game SUM of several stat keys (e.g. rush+rec TDs → anytime). A game
    counts if at least one key is present; missing keys contribute 0."""
    out = []
    for r in rows:
        vals = [num(r[1].get(k)) for k in keys]
        if all(v is None for v in vals):
            out.append(None)
        else:
            out.append(sum(v or 0 for v in vals))
    return out


def market_series(rows, spec):
    """The direct-projection series for a count/poisson market (stat or stat_sum)."""
    return collect_sum_series(rows, spec["stat_sum"]) if spec.get("stat_sum") else collect_series(rows, spec["stat"])


# ── walk-forward evaluation of one hyperparameter set for one market ───────
def eval_market(mkt, spec, seq, half_life, k_vol, k_eff, priors):
    """
    Walk forward through every player's season; at each game with >= MIN_PRIOR
    prior games, project from prior games only and compare to the actual.
    Returns (residuals, preds, actuals, baseline_preds).
    """
    resid, preds, actuals, base = [], [], [], []
    for key, rows in seq.items():
        pos = key[1]
        if pos not in spec["pos"]:
            continue
        if not is_usage(spec):
            series = market_series(rows, spec)
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


def pois_cdf(lam, k):
    """P(X <= k) for Poisson(lam), k integer >= 0."""
    if lam <= 0:
        return 1.0
    term = math.exp(-lam)
    acc = term
    for i in range(1, k + 1):
        term *= lam / i
        acc += term
    return min(acc, 1.0)


def pois_over(lam, line):
    """P(X >= ceil(line)) for a .5 line = 1 - P(X <= floor(line))."""
    k = math.floor(line)
    return max(0.0, 1 - pois_cdf(lam, k))


# ── #4 alt distributions (chosen per market by a build-time bake-off) ────────
def nb_over(mean, line, r):
    """P(X >= ceil(line)) for a Negative Binomial with the given mean and
    dispersion r (var = mean + mean²/r; large r ⇒ Poisson). Overdispersion
    fattens the tail — the right shape for receptions / rush attempts."""
    if mean <= 0:
        return 0.0
    m = math.ceil(line)
    if m <= 0:
        return 1.0
    p = r / (r + mean)
    term = p ** r
    cdf = term
    for k in range(1, m):
        term *= (k - 1 + r) / k * (1 - p)
        cdf += term
    return max(0.0, 1.0 - min(cdf, 1.0))


def fit_nb_r(means, actuals):
    """MLE of the shared dispersion r given per-game means."""
    pairs = [(m, k) for m, k in zip(means, actuals) if m and m > 0 and k is not None]
    if len(pairs) < 300:
        return 1e6
    def nll(r):
        s = 0.0
        for mean, k in pairs:
            p = r / (r + mean)
            s -= (math.lgamma(k + r) - math.lgamma(r) - math.lgamma(k + 1)
                  + r * math.log(p) + (k * math.log(1 - p) if k > 0 else 0.0))
        return s
    best = (1e6, 1e18); r = 0.3
    while r <= 300:
        v = nll(r)
        if v < best[1]:
            best = (r, v)
        r *= 1.25
    return round(best[0], 3)


def lognorm_over(proj, sd, line):
    """P(Y > line) with Y log-normal (mean=proj, sd=sd) — right-skewed, ≥0."""
    if proj <= 0:
        return 0.0
    if line <= 0:
        return 1.0
    s2 = math.log(1 + (sd * sd) / (proj * proj))
    if s2 <= 0:
        return 1.0 if proj > line else 0.0
    return 1 - phi_cdf((math.log(line) - (math.log(proj) - s2 / 2)) / math.sqrt(s2))


def prob_fn_for(entry):
    """Return a (proj, line) -> raw P(over) closure for a market's chosen dist."""
    d = entry["dist"]
    if d == "poisson":
        return lambda proj, line: pois_over(proj, line)
    if d == "nbinom":
        r = entry["nb_r"]
        return lambda proj, line: nb_over(proj, line, r)
    if d == "lognormal":
        v0, v1 = entry["sd_v0"], entry["sd_v1"]
        return lambda proj, line: lognorm_over(proj, sd_at(v0, v1, proj), line)
    v0, v1, count = entry["sd_v0"], entry["sd_v1"], entry.get("count", False)
    return lambda proj, line: raw_prob_over(proj, sd_at(v0, v1, proj), line, count)


def fit_calibration_poisson(preds, actuals, bins=20):
    """Isotonic calibration for a Poisson market over the real TD lines (0.5/1.5/2.5)."""
    pairs = []
    for lam, actual in zip(preds, actuals):
        for line in (0.5, 1.5, 2.5):
            p = pois_over(lam, line)
            pairs.append((p, 1.0 if actual >= line else 0.0))
    return _pav_bins(pairs, bins)


def _pav_bins(pairs, bins, pseudo=50):
    """
    Bin (raw_p, hit) pairs, shrink each bin's empirical hit-rate toward the bin's
    raw midpoint by `pseudo` pseudo-observations, then enforce monotonicity (PAV).
    The shrink keeps sparse bins (e.g. the high-probability tail of a rare TD
    market, where only a few elite games land) near the raw probability instead
    of overfitting to a handful of coin-flips.
    """
    if not pairs:
        return []
    acc = [[0.0, 0.0] for _ in range(bins)]
    for p, hit in pairs:
        b = min(bins - 1, int(p * bins))
        acc[b][0] += hit; acc[b][1] += 1
    pts = []
    for b in range(bins):
        if acc[b][1] > 0:
            mid = (b + 0.5) / bins
            rate = (acc[b][0] + pseudo * mid) / (acc[b][1] + pseudo)   # shrink → diagonal
            pts.append([mid, rate, acc[b][1]])
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
    return _pav_bins(pairs, bins)


def _lines_for(kind, proj, grid=(0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5)):
    if kind == "poisson":
        return [0.5, 1.5, 2.5]
    if kind == "count":
        return [round(proj * g * 2) / 2 for g in grid]
    return [proj * g for g in grid]


def fit_calibration_fn(preds, actuals, prob_fn, kind, bins=20):
    """Isotonic calibration for ANY distribution: build (raw_p, hit) pairs from
    the given prob_fn over realistic lines, then PAV-shrink."""
    pairs = []
    for proj, actual in zip(preds, actuals):
        for line in _lines_for(kind, proj):
            pairs.append((prob_fn(proj, line), 1.0 if actual >= line else 0.0))
    return _pav_bins(pairs, bins)


def _dist_logloss(preds, actuals, prob_fn, kind):
    """Raw (pre-calibration) log-loss over the standard bet lines — the bake-off
    metric for choosing a market's distribution by shape fit."""
    s, n = 0.0, 0
    for proj, actual in zip(preds, actuals):
        for line in _lines_for(kind, proj, grid=(0.85, 1.0, 1.15)):
            p = min(max(prob_fn(proj, line), 1e-6), 1 - 1e-6)
            h = 1.0 if actual >= line else 0.0
            s += -(h * math.log(p) + (1 - h) * math.log(1 - p)); n += 1
    return s / n if n else 1e9


def choose_dist(spec, preds, actuals):
    """Pick the distribution that fits this market's tape best OUT-OF-SAMPLE
    (walk-forward raw log-loss). Candidates by kind: yards → Normal|log-normal,
    count → Normal|NBinom, TD/poisson → Poisson|NBinom. Returns (name, extra)."""
    kind = spec["kind"]
    if kind == "yards":
        v0, v1 = fit_sd(preds, actuals)
        cands = [("normal", {"sd_v0": v0, "sd_v1": v1, "count": False}),
                 ("lognormal", {"sd_v0": v0, "sd_v1": v1})]
    elif kind == "count":
        v0, v1 = fit_sd(preds, actuals)
        cands = [("normal", {"sd_v0": v0, "sd_v1": v1, "count": True}),
                 ("nbinom", {"nb_r": fit_nb_r(preds, actuals)})]
    else:
        cands = [("poisson", {}), ("nbinom", {"nb_r": fit_nb_r(preds, actuals)})]
    best = None
    for name, extra in cands:
        ll = _dist_logloss(preds, actuals, prob_fn_for({"dist": name, **extra}), kind)
        if best is None or ll < best[2] - 1e-4:   # tie → first candidate (the incumbent)
            best = (name, extra, ll)
    return best[0], best[1]


def r2(preds, actuals):
    if len(actuals) < 2:
        return None
    mu = statistics.fmean(actuals)
    sst = sum((a - mu) ** 2 for a in actuals)
    sse = sum((a - p) ** 2 for a, p in zip(actuals, preds))
    return 1 - sse / sst if sst > 0 else None


# ── #3 market shrink: temperature scaling toward 0.5 (pickem/market prior) ──
def _logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6); return math.log(p / (1 - p))


def _sig(x):
    return 1 / (1 + math.exp(-max(-60, min(60, x))))


def shrink_prob(p, w):
    return _sig(w * _logit(p))


def apply_calib(calib, p):
    """Piecewise-linear isotonic apply (mirror of the JS calibrate())."""
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


def fit_temperature(pairs):
    """w minimizing log-loss of shrink_prob(p, w); w<1 ⇒ probs too extreme."""
    if len(pairs) < 300:
        return 1.0
    def ll(w):
        s = 0.0
        for p, h in pairs:
            q = min(max(shrink_prob(p, w), 1e-6), 1 - 1e-6)
            s += -(h * math.log(q) + (1 - h) * math.log(1 - q))
        return s / len(pairs)
    lo, hi = 0.2, 1.8
    for _ in range(40):
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if ll(m1) < ll(m2):
            hi = m2
        else:
            lo = m1
    return round((lo + hi) / 2, 3)


def fit_shrink(spec, preds, actuals, entry):
    """Fit the market-shrink temperature on the walk-forward calibrated probs of
    the market's CHOSEN distribution. w≈1 = already calibrated; w<1 = overconfident."""
    pf, calib = prob_fn_for(entry), entry["calib"]
    pairs = []
    for proj, act in zip(preds, actuals):
        for line in _lines_for(spec["kind"], proj, grid=(0.85, 1.0, 1.15)):
            p = min(max(apply_calib(calib, pf(proj, line)), 0.01), 0.99)
            pairs.append((p, 1.0 if act >= line else 0.0))
    return fit_temperature(pairs)


def compute_priors(seq):
    """Per-market league prior (mean per game) for volume, efficiency, direct."""
    pri = {}
    for mkt, spec in MARKETS.items():
        if not is_usage(spec):
            vals = []
            for key, rows in seq.items():
                if key[1] not in spec["pos"]:
                    continue
                vals += [v for v in market_series(rows, spec) if v is not None]
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


# ── in-season live recalibration (the "gets sharper over time" loop) ─────────
def apply_inseason_overlay(model):
    """Compose this season's MEASURED miscalibration onto each market's shipped
    calib table, so served probabilities sharpen week over week from real
    settled outcomes — with NO serving-JS change (it's baked into calib).

    scripts/settle_bets.py grades the banked snapshots vs nflverse actuals and
    writes data/edge_scoreboard.json, whose per-market `inseason_temp.t` is the
    residual temperature on the served probs (t<1 ⇒ still overconfident this
    season). We apply a SAMPLE-SHRUNK version: factor = 1 + w·(t−1) with
    w = n/(n+K), K large, so Weeks 1–3 (small n) barely move and confidence
    grows only as the season's evidence does. Bounded + re-derived from tape
    each build, so it converges and can't run away. Offseason / no scoreboard /
    thin sample ⇒ w≈0 ⇒ no-op. See docs/edge-feedback-loop.md."""
    try:
        sb = json.load(open(os.path.join(DATA, "edge_scoreboard.json")))
    except Exception:
        return
    mks = sb.get("markets", {})
    applied, blended = [], []
    for mkt, entry in model.get("markets", {}).items():
        sbm = mks.get(mkt) or {}

        # (a) calibration overlay — bend the served calib toward this season's
        # measured miscalibration (temperature), sample-shrunk.
        it = sbm.get("inseason_temp") or {}
        t, n = it.get("t"), it.get("n") or 0
        K = it.get("k_shrink", 300)
        if t is not None and n > 0 and entry.get("calib"):
            t = max(0.6, min(1.4, t))                 # bound a noisy estimate
            w = n / (n + K)
            factor = 1.0 + w * (t - 1.0)
            if abs(factor - 1.0) >= 1e-4:
                new, prev = [], 0.0
                for x, y in entry["calib"]:
                    yv = _sig(factor * _logit(y))
                    yv = max(prev, min(1.0, yv))       # keep isotonic (monotone non-decreasing)
                    new.append([round(x, 4), round(yv, 4)]); prev = yv
                entry["calib"] = new
                entry["inseason"] = {"t": round(t, 3), "n": n, "w": round(w, 4), "factor": round(factor, 4)}
                applied.append(f"{mkt}(t={t:.2f},n={n},w={w:.2f})")

        # (b) market-blend weight (#3) — published for the serving code to blend
        # the model's P(over) toward the vig-free market where the loop MEASURES
        # the market is sharper. w_prior = 1.0 (pure model, no blend) until
        # evidence, shrunk the same way; the JS defaults to 1.0 when absent, so
        # this is a no-op offseason and only priced two-way rows ever use it.
        bl = sbm.get("blend") or {}
        wm, nb, Kb = bl.get("w_measured"), bl.get("n") or 0, (bl.get("k_shrink") or 300)
        if wm is not None and nb > 0:
            wb = nb / (nb + Kb)
            entry["blend_w"] = round(1.0 * (1 - wb) + float(wm) * wb, 4)
            blended.append(f"{mkt}(w={entry['blend_w']},n={nb})")

    print(f"[prop-model] in-season overlay applied: {', '.join(applied)}" if applied
          else "[prop-model] in-season overlay: no eligible market yet (offseason or thin sample) — no-op")
    if blended:
        print(f"[prop-model] market-blend weights published: {', '.join(blended)}")


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
        # fit the distribution + isotonic calibration at the winning params
        entry = {
            "kind": spec["kind"], "pos": spec["pos"],
            # weekly-row field names so the JS inference stays data-driven
            "vol": spec.get("vol"), "eff_num": spec.get("eff_num"),
            "stat": spec.get("stat"), "stat_sum": spec.get("stat_sum"),
            "half_life": best["hl"], "k_vol": best["k_vol"], "k_eff": best["k_eff"],
            "prior": {k: round(priors[k], 4) for k in priors if k == mkt or k.startswith(mkt + "|")},
            "rmse": round(best["rmse"], 3), "r2": round(best["r2"], 4), "n": best["n"],
            "base_rmse": round(best["base_rmse"], 3),
        }
        # #4: pick the distribution that fits this market's tape best out-of-
        # sample (bake-off), fit its params, then calibrate + shrink under it.
        dist, extra = choose_dist(spec, best["preds"], best["actuals"])
        entry["dist"] = dist; entry.update(extra)
        if spec.get("no_calib"):
            # Ship the raw distribution prob: isotonic PAV overfits this market's
            # rare-event tail so badly that calibrating turns a clearing grade into
            # a coin flip. Empty calib → JS identity. A fixed w<1 shrink (not the
            # log-loss fit, which misses the mid-tail) then makes the OOS grade
            # ladder monotonic and A/B/C clear at the bettable 0.5 line.
            entry["calib"] = []
            entry["shrink"] = TD_RAW_SHRINK
        else:
            entry["calib"] = fit_calibration_fn(best["preds"], best["actuals"], prob_fn_for(entry), spec["kind"])
            # #3 market shrink: pull overconfident probs toward the market/coin-flip.
            entry["shrink"] = fit_shrink(spec, best["preds"], best["actuals"], entry)
        dist_desc = {"poisson": f"λ̄={statistics.fmean(best['preds']):.2f} poisson",
                     "nbinom": f"nbinom r={entry.get('nb_r')}",
                     "lognormal": f"log-normal sd²={entry.get('sd_v0',0):.1f}+{entry.get('sd_v1',0):.3f}·μ",
                     "normal": f"normal sd²={entry.get('sd_v0',0):.1f}+{entry.get('sd_v1',0):.3f}·μ"}[dist]
        calib = entry["calib"]
        lift = (best["base_rmse"] - best["rmse"]) / best["base_rmse"] * 100 if best["base_rmse"] else 0
        held = " [HELD]" if mkt in HOLD else (" [RAW — no calib]" if spec.get("no_calib") else "")
        print(f"[prop-model] {mkt:9s} n={best['n']:6d} hl={best['hl']} kv={best['k_vol']} ke={best['k_eff']} "
              f"| RMSE {best['rmse']:.2f} vs base {best['base_rmse']:.2f} ({lift:+.1f}%) | R2 {best['r2']:.3f} "
              f"| {dist_desc} | calib {len(calib)}pt | shrink {entry['shrink']}{held}")
        if mkt in HOLD:
            continue                      # fit + reported above, but not shipped
        model["markets"][mkt] = entry

    # Live recalibration: sharpen served probs from this season's settled outcomes.
    apply_inseason_overlay(model)

    if args.dry:
        print("[prop-model] --dry: not written")
        return
    with open(OUT, "w") as f:
        json.dump(model, f)
    print(f"[prop-model] wrote {OUT}")


if __name__ == "__main__":
    main()
