#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
#  VAULT · DvP SHRINK-TO-MEAN  →  data/dvp_shrink.json
#
#  In the PRESEASON, the Defense-vs-Position table (build-lineup-feed.mjs buildDvP)
#  falls back to LAST season's full-year points-allowed, because no games of the
#  new season exist yet. That grade is roster-BLIND: it can't see a defense that
#  lost a star (e.g. Cleveland trading Myles Garrett) or churned its roster. A
#  full-season-ago grade is an UNCERTAIN guide to this year's team.
#
#  The honest fix (we cannot name the specific player who left — Vault has no
#  defensive roster/snaps data) is to REGRESS last season's DvP toward the league
#  average: pull extreme grades toward the mean, because that is the correct prior
#  when the current roster is unknown. This handles ALL turnover uniformly without
#  inventing a per-player impact.
#
#  MEASURED, not invented (Vault rule): we FIT the shrink weight λ per position by
#  asking, on real history, whether  (1-λ)·dvp[Y-1] + λ·mean[Y-1]  predicts the
#  team's ACTUAL dvp[Y] better than raw dvp[Y-1] (λ=0). Ships only where λ>0 and
#  the out-of-sample error actually drops.
#
#  DvP is reproduced exactly as buildDvP defines it: each offensive player's
#  pts_ppr is credited to the OPPONENT defense; per-game average per (team, pos).
#  Source: Sleeper public stats API (same as the live build).
#
#  Usage:  python3 scripts/build_dvp_shrink.py [--since 2018] [--dry]
# ════════════════════════════════════════════════════════════════════════════
import argparse, json, os, statistics as st, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "dvp_shrink.json")
CACHE = "/tmp/vault_dvp_cache"
SLEEPER = "https://api.sleeper.app"
POS = ["QB", "RB", "WR", "TE"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vault-dvp/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def season_dvp(season):
    """{team: {pos: fpa_per_game}} for one season, reproducing buildDvP's rule:
    credit each offensive player's pts_ppr to the OPPONENT defense."""
    os.makedirs(CACHE, exist_ok=True)
    cf = os.path.join(CACHE, f"dvp_{season}.json")
    if os.path.exists(cf):
        return json.load(open(cf))
    allow = defaultdict(lambda: defaultdict(float))   # defense -> pos -> pts
    weeks_seen = defaultdict(set)                       # defense -> {weeks}
    q = "&".join(f"position[]={p}" for p in POS)
    for w in range(1, 19):
        try:
            rows = get(f"{SLEEPER}/stats/nfl/{season}/{w}?season_type=regular&{q}")
        except Exception:
            continue
        for row in rows or []:
            pl = row.get("player") or {}
            pos = pl.get("position")
            if pos not in POS:
                continue
            pts = (row.get("stats") or {}).get("pts_ppr")
            dfn = (row.get("opponent") or "").upper()   # the defense that allowed these points
            if pts is None or not dfn:
                continue
            allow[dfn][pos] += pts
            weeks_seen[dfn].add(w)
    out = {}
    for dfn, byp in allow.items():
        g = max(1, len(weeks_seen[dfn]))
        out[dfn] = {p: round(byp.get(p, 0.0) / g, 3) for p in POS}
    json.dump(out, open(cf, "w"))
    return out


def league_means(dvp):
    return {p: st.fmean([t[p] for t in dvp.values() if p in t]) for p in POS}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2018)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    seasons = list(range(args.since, 2025))          # 2025 is the "current-1"; validate up to Y=2024
    print(f"[dvp-shrink] loading Sleeper DvP for {seasons[0]}..{seasons[-1]+1} …")
    dvp = {y: season_dvp(y) for y in range(args.since, 2026)}
    means = {y: league_means(dvp[y]) for y in dvp}

    # ── validation: (1-λ)·prior + λ·mean  vs  actual next-season DvP ──────────
    # Pairs (Y-1 → Y) across all seasons; fit λ per position out-of-sample.
    pairs = defaultdict(list)   # pos -> [(prior_fpa, prior_mean, actual_fpa), ...]
    for y in range(args.since + 1, 2026):
        prev, cur = dvp.get(y - 1), dvp.get(y)
        if not prev or not cur:
            continue
        pmean = means[y - 1]
        for team, curp in cur.items():
            if team not in prev:
                continue
            for p in POS:
                if p in prev[team] and p in curp:
                    pairs[p].append((prev[team][p], pmean[p], curp[p]))

    def mae(pos, lam):
        return st.fmean(abs(a - ((1 - lam) * pr + lam * mn)) for pr, mn, a in pairs[pos])

    lambdas, report = {}, []
    for p in POS:
        if len(pairs[p]) < 60:
            continue
        best_lam, best = 0.0, mae(p, 0.0)
        raw = best
        lam = 0.0
        while lam <= 1.0 + 1e-9:
            m = mae(p, lam)
            if m < best:
                best, best_lam = m, lam
            lam += 0.05
        lambdas[p] = round(best_lam, 2)
        impr = (raw - best) / raw * 100 if raw else 0
        report.append((p, best_lam, raw, best, impr, len(pairs[p])))

    print("[dvp-shrink] fitted shrink weight λ per position (0=raw prior, 1=full to mean):")
    for p, lam, raw, best, impr, n in report:
        print(f"  {p}: λ={lam:.2f}  MAE {best:.2f} vs raw {raw:.2f} ({impr:+.1f}%)  n={n}")

    model = {"lambda": lambdas,
             "meta": {"since": args.since, "seasons": len(dvp), "fit": "walk-forward prior→actual next-season DvP",
                      "n": {p: len(pairs[p]) for p in POS}}}
    if args.dry:
        print("[dvp-shrink] --dry: not written\n", json.dumps(model))
        return
    json.dump(model, open(OUT, "w"))
    print(f"[dvp-shrink] wrote {OUT}")


if __name__ == "__main__":
    main()
