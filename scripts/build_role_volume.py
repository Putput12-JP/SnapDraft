#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
#  VAULT · ROLE-VOLUME PRIOR  →  data/role_volume.json
#
#  Fixes the prop model's biggest blind spot: it is purely PLAYER-AUTOREGRESSIVE,
#  so it projects a player's volume from his OWN past games. When a player's ROLE
#  changes between seasons — a backup promoted to lead back, a WR3 who becomes the
#  WR1 — his own history reflects the OLD role, and the projection is stale. The
#  book already prices the new role, so Vault manufactures a giant phantom edge
#  (e.g. Bhayshul Tuten: model 22.6 rush yds off his 2025 RB4 logs vs a 51.5 line
#  set for his 2026 RB1 role → a fake +63% "edge").
#
#  This MEASURES what each ROLE's volume looks like, so inference can anchor a
#  player's stale history toward the volume his CURRENT depth-chart role warrants
#  (the depth rank comes from the live feed's vegas_depth). We do NOT anchor to
#  the market line — the prior is population tape, so Vault keeps an independent
#  projection that can still find real edges; it just stops betting a 2026 starter
#  is a 2025 backup.
#
#  Method (nflverse weekly stats, many seasons):
#    · Within each team-season-position, rank players by TOTAL of the stat →
#      a within-season "role rank" proxy (rank 1 = the lead back / WR1 / QB1).
#    · Record each ranked player's MEDIAN per-game volume (games with real
#      involvement), bucketed by (stat, pos, rank). Publish the median per bucket.
#    · Anchor as a ROLE-SHIFT MULTIPLIER, not a flat blend toward the prior — a
#      flat blend would drag an established bellcow (own history ~20 car/g) down
#      toward the RB1 median (14), inventing phantom UNDER edges on studs. Instead:
#      read which role a player's OWN history resembles (impliedRank = nearest
#      prior), and scale his volume by prior[currentRank]/prior[impliedRank],
#      dampened by w and capped. This NO-OPS when history already matches the role
#      (impliedRank == currentRank), preserving stars, and only moves a player when
#      his tape reflects a different role than he now holds.
#    · Fit w in [0,1] by WALK-FORWARD: for every player active in back-to-back
#      seasons, predict year-Y per-game volume from his Y-1 history via the
#      multiplier at his year-Y rank; pick the w minimizing out-of-sample MAE.
#      Reported split by rank-changed vs same — the win is largest, and the
#      justification clearest, for players whose role actually moved.
#
#  Vault rule: every constant is MEASURED, not invented. A prior/weight only
#  ships where the sample supports it; thin buckets fall back (inference no-ops).
#
#  Usage:  python3 scripts/build_role_volume.py [--since 2016] [--dry]
# ════════════════════════════════════════════════════════════════════════════
import argparse, json, os, statistics as st
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "role_volume.json")

RANK_CAP = 4          # ranks 4+ collapse into one "deep bench" bucket
MIN_INVOLVE = 1       # min (this stat's touches) for a game to count as "played the role"
MIN_BUCKET = 60       # events before a (stat,pos,rank) median publishes
MIN_PAIRS = 150       # back-to-back pairs before a (stat,pos) blend weight is fit
CLAMP = 3.0           # inference caps the role move to [1/CLAMP, CLAMP]× — bad join can't blow up

# stat → (positions eligible, the "involvement" fields that mark a game as played
# in the role). Rank proxy = within team-season total of `stat`.
#
# QB is DELIBERATELY EXCLUDED. Depth rank cleanly proxies OPPORTUNITY for skill
# players (a WR2 sees more targets than a WR4; a lead back out-carries the RB3),
# so anchoring their volume to their role is sound. But a QB's passing volume is
# PLAY-STYLE, not role: a dual-threat starter (Lamar Jackson, Jayden Daniels)
# throws QB2-level attempts by design, so the anchor reads his own history as
# "backup" and wrongly bumps him to QB1 passing volume (Lamar pass_yd 202 → 276).
# QBs with props are the starter anyway, so there's little upside and real
# downside. Their autoregressive projection already captures true passing volume.
SPECS = {
    "car": (["RB"],             ["car", "tgt"]),   # rushing volume — lead back vs committee
    "tgt": (["WR", "TE", "RB"], ["tgt", "car"]),   # target volume — WR1/2/3, pass-catching back
    "rec": (["WR", "TE", "RB"], ["tgt", "car"]),
}


def num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def load(yr):
    fn = os.path.join(DATA, f"nflverse_stats_{yr}.json")
    if not os.path.exists(fn):
        return None
    with open(fn) as f:
        blob = json.load(f)
    return list(blob.values()) if isinstance(blob, dict) else blob


def per_game(weeks, stat, involve):
    """Median per-game value of `stat` over games where the player had real
    involvement, plus his season total of `stat` (the rank key)."""
    vals, tot = [], 0.0
    for w in weeks:
        s = num(w.get(stat)) or 0.0
        tot += s
        if sum((num(w.get(f)) or 0.0) for f in involve) >= MIN_INVOLVE:
            vals.append(s)
    return (st.median(vals) if vals else None), tot


def season_roles(yr, stat, positions, involve):
    """{name: {'pg': median per-game, 'rank': role rank}} for one season/stat."""
    players = load(yr)
    if not players:
        return {}
    teams = defaultdict(list)
    rec = {}
    for p in players:
        if p.get("pos") not in positions or not p.get("team"):
            continue
        pg, tot = per_game(p.get("weeks") or [], stat, involve)
        if pg is None or tot <= 0:
            continue
        rec[p["name"]] = {"pg": pg, "tot": tot, "pos": p["pos"]}
        teams[(p["team"], p["pos"])].append((tot, p["name"]))
    for key, lst in teams.items():
        lst.sort(reverse=True)
        for i, (_tot, nm) in enumerate(lst, start=1):
            rec[nm]["rank"] = min(i, RANK_CAP)
    return rec


def implied_rank(pv, ranks):
    """Which role rank does this per-game level most resemble? (nearest prior)."""
    return min(ranks, key=lambda r: abs(ranks[r] - pv))


def shift_mult(pv, cur_rank, ranks, w, clamp=CLAMP):
    """Role-shift multiplier applied to a player's own volume. No-op when his
    history already matches his current role."""
    ir = implied_rank(pv, ranks)
    raw = ranks[str(cur_rank)] / ranks[ir] if ranks.get(ir) else 1.0
    m = 1.0 + w * (raw - 1.0)
    return max(1.0 / clamp, min(clamp, m))


def fit_weight(pairs, prior_pos):
    """w in [0,1] minimizing OOS MAE of  own · shift_mult(own, rank, w)  vs actual.
    pairs = [(actual, own_history, cur_rank), ...]; prior_pos = {rank_str: prior}."""
    best_w, best_mae = 0.0, 1e18
    w = 0.0
    while w <= 1.0 + 1e-9:
        mae = st.fmean(abs(a - own * shift_mult(own, rk, prior_pos, w)) for a, own, rk in pairs)
        if mae < best_mae:
            best_w, best_mae = w, mae
        w += 0.05
    return round(best_w, 2), round(best_mae, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2016)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    years = list(range(args.since, 2026))
    priors = {}      # stat → pos → {rank: median per-game}
    weights = {}     # "stat|pos" → {w, mae, mae_own, n, changed}

    for stat, (positions, involve) in SPECS.items():
        # ── priors: median per-game by (pos, rank) over all seasons ──────────
        bucket = defaultdict(list)   # (pos, rank) → [per-game, ...]
        idx_by_year = {}
        for yr in years:
            idx = season_roles(yr, stat, positions, involve)
            idx_by_year[yr] = idx
            for r in idx.values():
                bucket[(r["pos"], r["rank"])].append(r["pg"])
        priors[stat] = {}
        for (pos, rank), vals in bucket.items():
            if len(vals) < MIN_BUCKET:
                continue
            priors[stat].setdefault(pos, {})[str(rank)] = round(st.median(vals), 3)
        # keep rank keys monotone-sane: no upstream rank cheaper than a deeper one
        for pos, ranks in priors[stat].items():
            prev = None
            for r in sorted(ranks, key=int):
                if prev is not None and ranks[r] > prev:
                    ranks[r] = round(prev, 3)     # enforce non-increasing with depth
                prev = ranks[r]

        # ── blend weight: walk-forward, per position ─────────────────────────
        by_pos_pairs = defaultdict(list)
        by_pos_changed = defaultdict(list)
        for yr in years:
            if yr - 1 not in idx_by_year:
                continue
            prev, cur = idx_by_year[yr - 1], idx_by_year[yr]
            for nm, c in cur.items():
                p = prev.get(nm)
                if not p or "rank" not in p or "rank" not in c:
                    continue
                pos = c["pos"]
                if priors[stat].get(pos, {}).get(str(c["rank"])) is None:
                    continue
                pair = (c["pg"], p["pg"], c["rank"])   # actual, own-history, cur rank
                by_pos_pairs[pos].append(pair)
                if c["rank"] != p["rank"]:
                    by_pos_changed[pos].append(pair)
        for pos, pairs in by_pos_pairs.items():
            if len(pairs) < MIN_PAIRS:
                continue
            w, mae = fit_weight(pairs, priors[stat][pos])
            mae_own = round(st.fmean(abs(a - own) for a, own, _ in pairs), 3)
            ch = by_pos_changed[pos]
            wc = fit_weight(ch, priors[stat][pos]) if len(ch) >= 40 else (None, None)
            weights[f"{stat}|{pos}"] = {
                "w": w, "mae": mae, "mae_own": mae_own, "n": len(pairs),
                "n_changed": len(ch), "w_changed": wc[0], "mae_changed": wc[1],
            }

    model = {
        "priors": priors, "weights": weights,
        "meta": {"since": args.since, "rank_cap": RANK_CAP, "clamp": CLAMP,
                 "min_bucket": MIN_BUCKET, "min_pairs": MIN_PAIRS},
    }

    # ── report ───────────────────────────────────────────────────────────────
    for stat in SPECS:
        for pos in sorted(priors.get(stat, {})):
            ranks = priors[stat][pos]
            wk = weights.get(f"{stat}|{pos}")
            line = "  ".join(f"r{r}={ranks[r]:.1f}" for r in sorted(ranks, key=int))
            wtxt = ""
            if wk:
                wtxt = (f" | w={wk['w']} (MAE {wk['mae']} vs own {wk['mae_own']}, "
                        f"n={wk['n']})"
                        + (f" | changed w={wk['w_changed']} MAE {wk['mae_changed']} "
                           f"n={wk['n_changed']}" if wk['w_changed'] is not None else ""))
            print(f"[role-vol] {stat:4s} {pos:3s} {line}{wtxt}")

    if args.dry:
        print("[role-vol] --dry: not written")
        return
    with open(OUT, "w") as f:
        json.dump(model, f)
    print(f"[role-vol] wrote {OUT}")


if __name__ == "__main__":
    main()
