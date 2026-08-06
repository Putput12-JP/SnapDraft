#!/usr/bin/env python3
"""Fit the Season Sim team-strength band from real Sleeper season outcomes.

The Season Sim (index.html `_ssLoad`/`_ssSim`) models each team's weekly score as
a Gaussian(mean, sigma). Team means used to be spread across a hand-picked band
SCORE_FLOOR=88 .. SCORE_CEIL=122 with sigma floored at 14. Scored against ~130k
real Sleeper seasons in data/redraft_strategy_corpus.json, that spread-to-sigma
ratio (34/14 = 2.43) was ~2.5x too WIDE: the sim funnelled both playoff berths and
titles far too hard toward the top scorers (e.g. a mid-pack team's real title odds
~6-8% showed as ~2-5%; a top team's ~24% showed as ~32%).

What actually generalises year to year is VARIANCE, not roster-construction edges
(those don't persist — see docs/redraft-strategy findings). So we do NOT build a
"championship DNA" strength score. We calibrate the one lever that controls the
luck/skill balance: the spread-to-sigma ratio, expressed as the fitted band.

Method
------
The corpus is season-aggregate (no weekly box scores), so we fit against the shape
of the observed points-percentile (`ppct`) -> playoff-rate (`po`) curve, which is a
pure signature of the spread:sigma ratio. Crucially the fit is SCALE-FREE (curves
normalised by their mean before RMSE): the winners_bracket parsing bug dilutes
SF/half playoff labels by dropping whole leagues to all-po=0, which scales the
curve down uniformly but preserves its shape — scale-free matching cancels it.

Midpoint stays 105 (= (88+122)/2, unchanged so it still blends with real histMean)
and sigma stays 14; only the spread is fitted, per (format x size).

Output: data/season_sim_calibration.json, consumed by window.VaultSeasonSimCal.
Every bucket degrades to the file's [88,122] fallback, so a cold cache costs nothing.

Usage:  python3 scripts/build_season_sim_calibration.py
"""
import json, os, random, math, gzip
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(ROOT, 'data', 'redraft_strategy_corpus.json.gz')   # gzipped
OUT = os.path.join(ROOT, 'data', 'season_sim_calibration.json')

MID = 105.0      # band midpoint, fixed (only the spread is calibrated)
SIGMA = 14.0     # weekly scoring sigma, matches the sim's floor
REG = 14         # regular-season weeks (Sleeper default)
MIN_BUCKET = 3000  # teams required to publish a per-(fmt,size) override

FMTS = ['1qb', 'sf']
SIZES = [8, 10, 12, 14, 16]


def real_po_curve(teams, pred):
    dec = defaultdict(lambda: [0, 0])
    n = 0
    for t in teams:
        if not pred(t):
            continue
        d = min(9, int((t['ppct'] or 0) * 10))
        dec[d][0] += t['po']; dec[d][1] += 1; n += 1
    curve = [dec[d][0] / dec[d][1] if dec[d][1] else 0.0 for d in range(10)]
    return curve, n


def po_n_for_size(teams, size):
    # structural playoff count, estimated from the CLEAN 1qb bucket of that size
    s = [t['po'] for t in teams if t['fmt'] == '1qb' and t['tm'] == size]
    if not s:
        return 6
    return max(2, min(size - 2, round(sum(s) / len(s) * size)))


def sim_po_curve(spread, size, po_n, ns=4000, seed=11):
    r = random.Random(seed)
    floor = MID - spread / 2; ceil = MID + spread / 2
    means = [floor + (1 - i / (size - 1)) * (ceil - floor) for i in range(size)]
    ids = list(range(size)); dec = defaultdict(lambda: [0, 0])
    for _ in range(ns):
        pf = [0.0] * size; wins = [0] * size
        for _w in range(REG):
            o = ids[:]; r.shuffle(o)
            for k in range(0, size, 2):
                a, b = o[k], o[k + 1]
                sa = r.gauss(means[a], SIGMA); sb = r.gauss(means[b], SIGMA)
                pf[a] += sa; pf[b] += sb
                if sa >= sb: wins[a] += 1
                else: wins[b] += 1
        rank = sorted(ids, key=lambda i: pf[i])
        ppct = {rid: idx / (size - 1) for idx, rid in enumerate(rank)}
        cut = set(sorted(ids, key=lambda i: (wins[i], pf[i]), reverse=True)[:po_n])
        for rid in ids:
            d = min(9, int(ppct[rid] * 10))
            dec[d][0] += 1 if rid in cut else 0; dec[d][1] += 1
    return [dec[d][0] / dec[d][1] if dec[d][1] else 0.0 for d in range(10)]


def _norm(c):
    m = sum(c) / len(c)
    return [x / m for x in c] if m > 0 else c


def shape_rmse(a, b):
    a, b = _norm(a), _norm(b)
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)) / len(a))


def fit_spread(real_curve, size, po_n):
    best = None
    for sp in range(6, 44, 4):
        e = shape_rmse(sim_po_curve(sp, size, po_n), real_curve)
        if best is None or e < best[1]:
            best = (sp, e)
    lo = max(4, best[0] - 4); hi = best[0] + 4
    for i in range(int(lo * 2), int(hi * 2) + 1):
        sp = i * 0.5
        e = shape_rmse(sim_po_curve(sp, size, po_n), real_curve)
        if e < best[1]:
            best = (sp, e)
    return best


def band_from_spread(sp):
    return round(MID - sp / 2, 1), round(MID + sp / 2, 1)


def main():
    cpath = CORPUS if os.path.exists(CORPUS) else CORPUS[:-3]   # pre-gzip fallback
    with (gzip.open(cpath, 'rt') if cpath.endswith('.gz') else open(cpath)) as _f:
        teams = json.load(_f)['teams']
    out = {
        'meta': {
            'source': 'redraft_strategy_corpus.json',
            'n_total': len(teams),
            'method': 'scale-free shape fit of ppct->playoff curve; midpoint=105 fixed, sigma=14',
            'fixed': {'midpoint': MID, 'sigma': SIGMA, 'reg_weeks': REG},
        },
        'sigma': SIGMA,
        'fallback': {'floor': 88, 'ceil': 122},
        'byFormat': {}, 'byBucket': {},
    }
    print(f'{"bucket":<12}{"n":>7}{"po_n":>5}{"spread":>8}{"band":>13}{"ratio":>7}{"rmse":>8}')

    # per-format pooled (fallback when a size bucket is too thin)
    for fmt in FMTS:
        curve, n = real_po_curve(teams, lambda t, f=fmt: t['fmt'] == f)
        po_n = po_n_for_size(teams, 12)
        sp, e = fit_spread(curve, 12, po_n)
        fl, ce = band_from_spread(sp)
        out['byFormat'][fmt] = {'floor': fl, 'ceil': ce, 'n': n}
        print(f'{fmt+" (all)":<12}{n:>7}{po_n:>5}{sp:>8.1f}{f"{fl}-{ce}":>13}{sp/SIGMA:>7.2f}{e:>8.3f}')

    # per (fmt, size)
    for fmt in FMTS:
        for size in SIZES:
            curve, n = real_po_curve(teams, lambda t, f=fmt, s=size: t['fmt'] == f and t['tm'] == s)
            if n < MIN_BUCKET:
                continue
            po_n = po_n_for_size(teams, size)
            sp, e = fit_spread(curve, size, po_n)
            fl, ce = band_from_spread(sp)
            out['byBucket'][f'{fmt}_{size}'] = {'floor': fl, 'ceil': ce, 'n': n, 'po_n': po_n}
            print(f'{fmt+"_"+str(size):<12}{n:>7}{po_n:>5}{sp:>8.1f}{f"{fl}-{ce}":>13}{sp/SIGMA:>7.2f}{e:>8.3f}')

    json.dump(out, open(OUT, 'w'), indent=2)
    print(f'\nOld hand-picked band 88-122 -> spread 34, ratio {34/SIGMA:.2f}')
    print(f'wrote {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
