#!/usr/bin/env python3
"""Round × position draft history → data/redraft_round_position.json

Answers "what did teams who took a <position> in round <N> actually do?" for every round,
using the drafted players backfilled by scripts/backfill_redraft_picks.py joined to the
outcome rows in the strategy corpus. The strategy corpus alone cannot do this: it stores
positional COUNTS and the first-four-pick sequence, not what was taken in round 7.

Only signals that held their sign in ALL THREE seasons are published. A round×position cell
that was good one year and bad the next is not advice, and shipping it as advice is how a
draft tool teaches people last season by accident. In PPR/1QB/12 that leaves 8 of 46 cells.

Also publishes the durable "<pos> in rounds N+" levers, which answer the follow-up question
a warning creates — "fine, so when DO I take one?". No single round carries a durable
positive QB signal in 1QB, but "QB in rounds 8+" does, and without it the UI can only say
"later", which is useless on the clock.
"""
import json, os, math, collections, datetime as dt

DATA = "data"
CORPUS = "redraft_strategy_corpus.json"
PICKS = "redraft_strategy_picks.json"
OUT = "redraft_round_position.json"

MIN_CELL = 200          # teams in one round×position cell, per season
MIN_SEASON = 1500       # teams in a season before it can vote
MAX_ROUND = 14
SEASONS = ("2023", "2024", "2025")
# buckets worth publishing: everything else is too thin to survive the 3-season test
CELLS = [("ppr", "1qb", 12), ("ppr", "sf", 12), ("ppr", "1qb", 10), ("ppr", "sf", 10)]

def _load(p):
    f = os.path.join(DATA, p)
    if not os.path.exists(f):
        raise SystemExit(f"missing {f}")
    with open(f) as fh:
        return json.load(fh)

def wilson_ok(k, n, base, z=1.96):
    """Does the 95% interval clear the field baseline? Guards the pooled number only."""
    if not n:
        return False
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    lo, hi = (c - m) / d, (c + m) / d
    return lo > base or hi < base

def levers(teams, base_by_season):
    """Durable '<pos> in rounds N+' effects, from the corpus's first-round-of-position
    fields — no picks join needed."""
    out = []
    for pos, key in (("QB", "qb1"), ("TE", "te1"), ("RB", "rb1"), ("WR", "wr1")):
        for frm in range(2, 13):
            grp = [t for t in teams if t.get(key) and t[key] >= frm]
            if len(grp) < 600:
                continue
            lifts = []
            for sea in SEASONS:
                g = [t for t in grp if t["sea"] == sea]
                b = base_by_season.get(sea)
                if b is None or len(g) < MIN_CELL:
                    lifts.append(None); continue
                lifts.append(sum(t["po"] for t in g) / len(g) - b)
            got = [x for x in lifts if x is not None]
            if len(got) < 3 or not all(x > 0 for x in got):
                continue
            pooled = sum(t["po"] for t in grp) / len(grp)
            out.append({"pos": pos, "fromRound": frm, "n": len(grp),
                        "lift": round(pooled - sum(base_by_season[s] for s in SEASONS) / 3, 4),
                        "seasons": [round(x, 4) if x is not None else None for x in lifts]})
    # EARLIEST durable round per position, not the strongest. "QB in rounds 11+" scores higher
    # than "rounds 8+", but that is the tail — the people who wait that long are a different
    # population, and "wait until round 11 for a quarterback" is a far bigger claim than the
    # data needs to make. A drafter is asking "when can I stop worrying", which is the earliest
    # round the effect turns durably positive. Require a real effect too: a +0.2pp lever is
    # technically durable and practically noise.
    best = {}
    for l in sorted(out, key=lambda x: x["fromRound"]):
        if l["lift"] < 0.012:
            continue
        best.setdefault(l["pos"], l)
    return list(best.values())

def build():
    corpus = _load(CORPUS)["teams"]
    P = _load(PICKS)
    PL, LG = P["players"], P["leagues"]
    payload = {"source": "real completed Sleeper redraft leagues",
               "teams": len(corpus),
               "seasons": list(SEASONS),
               "minCell": MIN_CELL,
               "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "buckets": {}}
    for sc, fmt, tm in CELLS:
        teams = [t for t in corpus if t["sc"] == sc and t["fmt"] == fmt and t["tm"] == tm]
        if len(teams) < 4000:
            continue
        per = {s: [t for t in teams if t["sea"] == s] for s in SEASONS}
        base_by_season = {s: (sum(t["po"] for t in v) / len(v))
                          for s, v in per.items() if len(v) >= MIN_SEASON}
        if len(base_by_season) < 3:
            continue
        pooled_base = sum(t["po"] for t in teams) / len(teams)

        agg = collections.defaultdict(lambda: collections.defaultdict(lambda: {"n": 0, "po": 0}))
        for t in teams:
            rost = (LG.get(t["lid"]) or {}).get(str(t["rid"]))
            if not rost:
                continue
            seen = set()
            for rd, pid in rost:
                info = PL.get(pid)
                if not info or rd > MAX_ROUND:
                    continue
                k = (rd, info[1])
                if k in seen:            # one credit per round+position per team
                    continue
                seen.add(k)
                a = agg[t["sea"]][k]
                a["n"] += 1
                a["po"] += t["po"]

        rows = []
        for rd in range(1, MAX_ROUND + 1):
            for pos in ("QB", "RB", "WR", "TE"):
                lifts, ns, ks = [], [], []
                for sea in SEASONS:
                    a = agg[sea].get((rd, pos))
                    if not a or a["n"] < MIN_CELL:
                        lifts.append(None); ns.append(0); ks.append(0); continue
                    lifts.append(a["po"] / a["n"] - base_by_season[sea])
                    ns.append(a["n"]); ks.append(a["po"])
                got = [x for x in lifts if x is not None]
                if len(got) < 3:
                    continue
                if not (all(x > 0 for x in got) or all(x < 0 for x in got)):
                    continue                              # flipped — not advice
                tot, kt = sum(ns), sum(ks)
                if not wilson_ok(kt, tot, pooled_base):
                    continue
                rows.append({"round": rd, "pos": pos, "n": tot,
                             "lift": round(kt / tot - pooled_base, 4),
                             "seasons": [round(x, 4) for x in lifts],
                             "dir": "good" if got[0] > 0 else "bad"})
        payload["buckets"][f"{sc}|{fmt}|{tm}"] = {
            "n": len(teams),
            "base": round(pooled_base, 4),
            "rounds": rows,
            "levers": levers(teams, base_by_season),
        }
        print(f"{sc}/{fmt}/{tm}: {len(teams)} teams · {len(rows)} durable round×position cells "
              f"· {len(payload['buckets'][f'{sc}|{fmt}|{tm}']['levers'])} levers")
    with open(os.path.join(DATA, OUT), "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {DATA}/{OUT} ({os.path.getsize(os.path.join(DATA, OUT))/1024:.0f} KB)")

if __name__ == "__main__":
    build()
