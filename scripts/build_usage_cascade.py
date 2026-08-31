#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
#  VAULT · USAGE CASCADE  →  data/usage_cascade.json
#
#  MEASURES (does not invent) how a player's own volume changes when higher-
#  usage teammates at his position are absent — the "next man up" bump. This is
#  the injury teammate-cascade: WR1 out ⇒ the other WRs see more targets.
#
#  Method (from nflverse weekly stats, many seasons):
#    · Group each team-season's players by position; rank by baseline volume
#      (targets for WR/TE receiving, carries for RB rushing).
#    · A player is ABSENT in week W if he has ≥ MIN_PRESENT games that season but
#      no row in W (and the team played W). That's our inactive proxy — nflverse
#      weekly rows exist only for players who played.
#    · BASELINE volume for player p = median of his volume in weeks where NO
#      higher-ranked teammate was absent (his "normal" role).
#    · For weeks where h ≥ 1 higher-ranked teammates were absent, record the
#      multiplier vol_p(W) / baseline_p, bucketed by (group, p's rank, h).
#    · Publish the MEDIAN multiplier per bucket (robust to blowup games) with its
#      event count and IQR, only where enough events support it.
#
#  Nothing ships to serving unless the medians are clean and monotone — a plausible
#  adjustment that doesn't hold up is a no-go (cf. the rejected opponent/DvP).
#
#  Usage:  python3 scripts/build_usage_cascade.py [--since 2014] [--dry]
# ════════════════════════════════════════════════════════════════════════════
import argparse, json, os, statistics as st
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "usage_cascade.json")

MIN_PRESENT = 6        # games a player needs that season to count as a real roster piece (so an absence is meaningful)
MIN_BASELINE = 3       # baseline weeks required to trust his normal volume
MIN_STARTER_VOL = {"rec": 4.0, "rush": 8.0}   # a "higher-ranked teammate" only counts if his baseline volume is real
MIN_EVENTS = 40        # events required before a bucket publishes a multiplier
GROUPS = {             # group → (positions, volume field)
    "rec": ({"WR", "TE"}, "tgt"),
    "rush": ({"RB"}, "car"),
}


def load(season):
    path = os.path.join(DATA, f"nflverse_stats_{season}.json")
    if not os.path.exists(path):
        return None
    try:
        return json.load(open(path))
    except Exception:
        return None


def measure(seasons):
    # events[(group, rank_bucket, h_bucket)] = list of multipliers
    events = defaultdict(list)
    baseline_n = defaultdict(int)

    for season in seasons:
        blob = load(season)
        if not blob:
            continue
        for group, (positions, vol) in GROUPS.items():
            # team → list of (name, {wk: vol}) for players at these positions
            by_team = defaultdict(list)
            for name, rec in blob.items():
                if not isinstance(rec, dict) or rec.get("pos") not in positions:
                    continue
                team = rec.get("team")
                wkvol = {}
                for row in rec.get("weeks", []) or []:
                    wk = row.get("wk"); v = row.get(vol)
                    if wk is not None and isinstance(v, (int, float)):
                        wkvol[int(wk)] = float(v)
                if len(wkvol) >= MIN_PRESENT and team:
                    by_team[team].append((name, wkvol))

            for team, players in by_team.items():
                if len(players) < 2:
                    continue
                team_weeks = set()
                for _, wv in players:
                    team_weeks |= set(wv.keys())
                # rank players by total volume (proxy for depth-chart order)
                players.sort(key=lambda pw: -sum(pw[1].values()))
                totals = [sum(wv.values()) / max(len(wv), 1) for _, wv in players]

                for k, (name, wv) in enumerate(players):        # k = 0-based rank
                    present = set(wv.keys())
                    # for each week, how many HIGHER-ranked real teammates were absent?
                    normal, bumped = [], defaultdict(list)
                    for w in present:
                        h = 0
                        for j in range(k):
                            jn, jwv = players[j]
                            if totals[j] < MIN_STARTER_VOL[group]:
                                continue                        # not a real starter; ignore
                            if w not in jwv:                    # present in season, absent this week
                                h += 1
                        if h == 0:
                            normal.append(wv[w])
                        else:
                            bumped[h].append(wv[w])
                    if len(normal) < MIN_BASELINE:
                        continue
                    base = st.median(normal)
                    baseline_n[group] += 1
                    if base <= 0:
                        continue
                    rb = min(k, 3)                              # rank bucket 0..3 (3 = "rank 4+")
                    for h, vals in bumped.items():
                        hb = min(h, 2)                          # 1, or 2+ higher out
                        for v in vals:
                            events[(group, rb, hb)].append(v / base)
    return events, baseline_n


def summarize(events):
    out = {}
    for (group, rb, hb), mults in events.items():
        if len(mults) < MIN_EVENTS:
            continue
        mults_sorted = sorted(mults)
        q1 = mults_sorted[len(mults_sorted) // 4]
        q3 = mults_sorted[3 * len(mults_sorted) // 4]
        out.setdefault(group, {}).setdefault(str(rb), {})[str(hb)] = {
            "mult": round(st.median(mults), 3),
            "n": len(mults),
            "iqr": [round(q1, 3), round(q3, 3)],
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2014)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    seasons = list(range(args.since, 2026))
    events, baseline_n = measure(seasons)
    summary = summarize(events)

    print(f"[cascade] seasons {args.since}-2025 · baselines: "
          + ", ".join(f"{g}={n}" for g, n in baseline_n.items()))
    LABELS = {"rec": "receiving (tgt)", "rush": "rushing (car)"}
    RANK = {"0": "rank1", "1": "rank2", "2": "rank3", "3": "rank4+"}
    for group in ("rec", "rush"):
        g = summary.get(group, {})
        print(f"── {LABELS[group]}")
        if not g:
            print("     (no bucket cleared MIN_EVENTS — signal too thin to ship)")
        for rb in sorted(g):
            for hb in sorted(g[rb]):
                c = g[rb][hb]
                who = "1 higher out" if hb == "1" else "2+ higher out"
                print(f"     {RANK[rb]:6s} · {who:13s} → ×{c['mult']:.3f}  (n={c['n']}, IQR {c['iqr'][0]:.2f}–{c['iqr'][1]:.2f})")

    payload = {"generated": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
               "since": args.since, "min_events": MIN_EVENTS,
               "note": "median own-volume multiplier when N higher-ranked same-position teammates are absent; measured from nflverse weekly stats",
               "groups": summary}
    if args.dry:
        print("[cascade] --dry: not written"); return
    json.dump(payload, open(OUT, "w"))
    print(f"[cascade] wrote {OUT}")


if __name__ == "__main__":
    main()
