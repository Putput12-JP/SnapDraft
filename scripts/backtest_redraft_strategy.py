#!/usr/bin/env python3
"""
Backtest: does past strategy performance predict future strategy performance?

This exists to kill a bad idea cheaply. The obvious 2026 projection model is
"rank the strategies on history and recommend the winner." Before building that,
this measures whether strategy edges persist AT ALL. If they don't, no amount of
simulation on top of an unstable signal is worth writing.

Four tests, cheapest and most damning first:

  1. SPLIT-HALF RELIABILITY (the noise floor)
     Randomly halve a single season's teams, compute every strategy's lift in each
     half, correlate. This is the same season measured twice, so any disagreement
     is pure noise. It sets the CEILING on how well anything could predict a future
     season — you cannot predict next year better than one year predicts itself.

  2. YEAR-OVER-YEAR PERSISTENCE
     Correlate each strategy's lift in season N against season N+1. Compare against
     the ceiling from test 1. Gap = how much is genuine year-specific change.

  3. OUT-OF-SAMPLE PREDICTION CONTEST
     For each test season, predict every strategy's lift from prior seasons only:
        zero    - predict 0 (the null: "every strategy is average")
        carry   - predict the pooled prior lift
        shrunk  - predict prior lift x 0.5
        durable - predict prior lift only when its sign was consistent, else 0
     Scored by mean absolute error. **If `zero` wins, extrapolation adds nothing**
     and the projection model must not be built on archetype carry-over.

  4. DECISION TEST
     The practical version: follow each model's top pick into the test season and
     see what lift you actually realised. A model can have decent MAE and still
     pick badly.

USAGE
  python3 scripts/backtest_redraft_strategy.py
  python3 scripts/backtest_redraft_strategy.py --scoring ppr --format 1qb
  python3 scripts/backtest_redraft_strategy.py --trials 400
"""

import argparse
import gzip
import json
import os
import random
import statistics as stats

DATA_DIR = "data"
CORPUS = "redraft_strategy_corpus.json.gz"   # gzipped by build_redraft_strategy.py
MIN_GROUP = 40          # a strategy needs this many teams in a season to be scored
MIN_SEASON = 250        # a season needs this many teams to take part


# ---- strategy membership (mirrors build_redraft_strategy.py) -------------
def core_of(t):
    rb, wr = t.get("rb15"), t.get("wr15")
    if rb is None or wr is None:
        return None
    if rb >= 3:
        return "Robust RB"
    if rb == 0:
        return "Zero RB"
    if wr >= 3:
        return "WR Heavy"
    return "Hero RB" if rb == 1 else "Balanced"

def opening2(seq):
    if not seq:
        return None
    p = seq.split("-")
    if len(p) < 2 or p[0] not in ("RB", "WR") or p[1] not in ("RB", "WR"):
        return None
    return f"{p[0]}/{p[1]}"

def memberships(t):
    """Every strategy label this team belongs to, across all three layers."""
    out = []
    c = core_of(t)
    if c:
        out.append(c)
    qb, te = t.get("qb1"), t.get("te1")
    if qb:
        if 1 <= qb <= 4:
            out.append("Elite QB")
        if qb >= 8:
            out.append("Late QB")
    if te:
        if 1 <= te <= 2:
            out.append("Elite TE")
        if te >= 8:
            out.append("Late TE")
    o = opening2(t.get("seq"))
    if o:
        out.append(o)
    return out

ALL_STRATS = ["Robust RB", "Hero RB", "Zero RB", "WR Heavy", "Balanced",
              "Elite QB", "Late QB", "Elite TE", "Late TE",
              "RB/RB", "RB/WR", "WR/RB", "WR/WR"]


# ---- lift ---------------------------------------------------------------
def lifts(teams, min_group=MIN_GROUP):
    """{strategy: playoff-rate lift vs this pool's own baseline}."""
    n = len(teams)
    if not n:
        return {}
    base = sum(t["po"] for t in teams) / n
    buckets = {}
    for t in teams:
        for s in memberships(t):
            b = buckets.setdefault(s, [0, 0])
            b[0] += 1
            b[1] += t["po"]
    return {s: (v[1] / v[0]) - base for s, v in buckets.items() if v[0] >= min_group}


def pearson(pairs):
    if len(pairs) < 3:
        return None
    xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    num = sum((x - mx) * (y - my) for x, y in pairs)
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return num / (dx * dy) if dx and dy else None


# ---- tests --------------------------------------------------------------
def spearman_brown(r_half):
    """Split-half r understates the full sample's reliability — it is measured on
    half the teams. Spearman-Brown steps it back up to full length."""
    return (2 * r_half) / (1 + r_half) if r_half is not None and r_half > -1 else None

def disattenuate(r_obs, rel_x, rel_y):
    """Correlation between two noisy measurements is dragged toward zero by their
    own error. Dividing by sqrt(rel_x * rel_y) recovers the correlation between the
    underlying TRUE season effects — the quantity a projection model would predict.
    """
    # A negative split-half r means the season does not even agree with itself;
    # reliability is then undefined (and sqrt of a negative product goes complex),
    # so refuse to "correct" rather than invent a number.
    if r_obs is None or not rel_x or not rel_y or rel_x <= 0 or rel_y <= 0:
        return None
    denom = (rel_x * rel_y) ** 0.5
    return r_obs / denom if denom else None


def test_split_half(by_season, trials, log):
    log("\n1 · SPLIT-HALF RELIABILITY  (the noise floor)")
    log("   One season measured twice. This is the ceiling on any prediction.")
    rng = random.Random(7)
    overall = []
    rels = {}
    for sea in sorted(by_season):
        teams = by_season[sea]
        if len(teams) < MIN_SEASON:
            continue
        rs = []
        for _ in range(trials):
            shuffled = teams[:]
            rng.shuffle(shuffled)
            h = len(shuffled) // 2
            a, b = lifts(shuffled[:h], MIN_GROUP // 2), lifts(shuffled[h:], MIN_GROUP // 2)
            common = [(a[s], b[s]) for s in a if s in b]
            r = pearson(common)
            if r is not None:
                rs.append(r)
        if rs:
            med = stats.median(rs)
            rel = spearman_brown(med)
            rels[sea] = rel
            overall.append(med)
            log(f"   {sea}: split-half r = {med:+.2f}  →  full-season reliability {rel:.2f}"
                f"   (n={len(teams):,} teams)")
    if overall:
        log(f"   → a season measured twice agrees at r {stats.median(overall):+.2f};")
        log("     anything below that in test 2 is real year-to-year change, not noise.")
    return (stats.median(overall) if overall else None), rels


def test_persistence(by_season, rels, log):
    log("\n2 · YEAR-OVER-YEAR PERSISTENCE")
    log("   Does a strategy's edge in one season carry to the next?")
    seasons = sorted(s for s in by_season if len(by_season[s]) >= MIN_SEASON)
    results = []
    for i in range(len(seasons) - 1):
        s0, s1 = seasons[i], seasons[i + 1]
        a, b = lifts(by_season[s0]), lifts(by_season[s1])
        common = [(a[s], b[s]) for s in a if s in b]
        r = pearson(common)
        true_r = disattenuate(r, rels.get(s0), rels.get(s1))
        results.append((r, true_r))
        rtxt = f"{r:+.2f}" if r is not None else "n/a"
        ttxt = f"{true_r:+.2f}" if true_r is not None else "n/a"
        log(f"   {s0} → {s1}: observed r = {rtxt}   →   disattenuated r = {ttxt}"
            f"   ({len(common)} strategies)")
        for s in sorted(a, key=lambda x: -abs(a.get(x, 0))):
            if s in b:
                log(f"        {s:10} {a[s]*100:+6.1f}pp → {b[s]*100:+6.1f}pp")
    return results


def test_contest(by_season, log):
    log("\n3 · OUT-OF-SAMPLE PREDICTION CONTEST  (mean absolute error, pp)")
    seasons = sorted(s for s in by_season if len(by_season[s]) >= MIN_SEASON)
    models = ["zero", "carry", "shrunk", "durable"]
    errs = {m: [] for m in models}
    picks = {m: [] for m in models}

    for i in range(1, len(seasons)):
        test = seasons[i]
        train = seasons[:i]
        actual = lifts(by_season[test])
        per_season_train = [lifts(by_season[s]) for s in train]
        pooled = lifts([t for s in train for t in by_season[s]])

        preds = {}
        for s in actual:
            prior = [d[s] for d in per_season_train if s in d]
            p_carry = pooled.get(s, 0.0)
            signs = {1 if v > 0 else -1 for v in prior} if prior else set()
            preds[s] = {
                "zero": 0.0,
                "carry": p_carry,
                "shrunk": p_carry * 0.5,
                "durable": p_carry if len(signs) == 1 else 0.0,
            }
        log(f"\n   train {'+'.join(train)} → test {test}  ({len(actual)} strategies)")
        for m in models:
            e = [abs(preds[s][m] - actual[s]) for s in actual]
            mae = sum(e) / len(e) * 100
            errs[m].append(mae)
            best = max(actual, key=lambda s: preds[s][m]) if actual else None
            realized = actual.get(best, 0) * 100 if best else 0
            picks[m].append((best, realized))
            log(f"     {m:8} MAE {mae:5.2f}pp   picked {best or '—':10} → actually {realized:+5.1f}pp")

    log("\n   ── averaged over folds ──")
    ranked = sorted(models, key=lambda m: sum(errs[m]) / len(errs[m]))
    for m in ranked:
        log(f"     {m:8} MAE {sum(errs[m])/len(errs[m]):5.2f}pp")
    return ranked[0], {m: sum(errs[m]) / len(errs[m]) for m in models}, picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scoring", default="ppr")
    ap.add_argument("--format", dest="fmt", default=None,
                    help="1qb | sf | omit to pool both")
    ap.add_argument("--trials", type=int, default=200)
    args = ap.parse_args()

    def log(m):
        print(m, flush=True)

    path = os.path.join(DATA_DIR, CORPUS)
    if not os.path.exists(path) and path.endswith(".gz") and os.path.exists(path[:-3]):
        path = path[:-3]                 # pre-gzip corpus, if present
    if not os.path.exists(path):
        log(f"no corpus at {path} — run build_redraft_strategy.py first")
        return
    with (gzip.open(path, "rt") if path.endswith(".gz") else open(path)) as f:
        teams = json.load(f)["teams"]

    sel = [t for t in teams if t.get("sc") == args.scoring
           and (args.fmt is None or t.get("fmt") == args.fmt)
           and core_of(t) is not None]
    by_season = {}
    for t in sel:
        by_season.setdefault(t["sea"], []).append(t)

    log("=" * 68)
    log("REDRAFT STRATEGY — PREDICTIVE BACKTEST")
    log(f"scoring={args.scoring} format={args.fmt or 'pooled'} · {len(sel):,} teams")
    log("seasons: " + ", ".join(f"{s} ({len(v):,})" for s, v in sorted(by_season.items())))
    log("=" * 68)

    ceiling, rels = test_split_half(by_season, args.trials, log)
    persistence = test_persistence(by_season, rels, log)
    winner, maes, picks = test_contest(by_season, log)

    log("\n" + "=" * 68)
    log("VERDICT")
    log("=" * 68)
    if ceiling is not None:
        log(f"Noise ceiling (same season, split in half):  r {ceiling:+.2f}")
    obs = [a for a, _ in persistence if a is not None]
    tru = [b for _, b in persistence if b is not None]
    if obs:
        log(f"Year-over-year persistence (observed):       r {stats.median(obs):+.2f}")
    if tru:
        log(f"Year-over-year persistence (disattenuated):  r {stats.median(tru):+.2f}")
        log(f"   best-measured pair (2024→2025):           r {tru[-1]:+.2f}")
    log(f"Best out-of-sample model: {winner}  (MAE {maes[winner]:.2f}pp vs zero {maes['zero']:.2f}pp)")

    # Robustness guards — a headline winner from 2 folds means nothing on its own.
    weak = [s for s, r in rels.items() if r is not None and r < 0.5]
    if weak:
        log(f"\n⚠  Unreliable training seasons (self-agreement < 0.5): {', '.join(sorted(weak))}")
        log("   Folds trained on these cannot be trusted; the effective fold count is lower")
        log("   than it looks.")
    if maes[winner] > maes["zero"] * 0.85:
        log("\n⚠  The winning model beats the null by less than 15%. With this few folds")
        log("   that gap is not distinguishable from chance.")
    if winner == "zero":
        log("\n→ Extrapolating past strategy edges BEATS NOTHING. A projection model")
        log("  built on carrying archetype rates forward should NOT be built.")
        log("  Any 2026 model has to project VALUE VS ADP, not strategy win rates.")
    else:
        log(f"\n→ '{winner}' beats the null. A projection model has something to stand on,")
        log("  but only with the shrinkage/stability guard that made it win.")

    log("\nCaveat: seasons available = %d, so folds = %d. Thin by construction —"
        % (len(by_season), max(0, len(by_season) - 1)))
    log("treat this as a go/no-go signal, not a tuned result.")


if __name__ == "__main__":
    main()
