#!/usr/bin/env python3
# build_team_tendencies.py ──────────────────────────────────────────────────────
#   Phase 2 foundation for the game-script prop model → data/team_tendencies.json
#
#   Phase 1 (build_game_script.py) captures how a team's pass/rush MIX BENDS to the
#   scoreboard (spread). This builds the NEUTRAL ANCHOR it bends from: each team's
#   own offensive fingerprint — pace, pass rate over expected (PROE), and how it
#   concentrates carries and targets — the signal set a competitor exposes as its
#   "Playcaller Blueprint" (docs/game-script-prop-model.md, Phase 2).
#
#   Per team-season (REG) from nflverse play-by-play:
#     • environment — plays/game (pace), pass%, PROE (mean pass_oe in neutral WP)
#     • backfield   — RB1 / RB2 carry share (QB runs excluded via the top passer)
#     • target tree — top-1/2/3 receiver target share (concentration → Stars↔Spread)
#   All expressed as DELTAS vs that season's league median, so a "current" baseline
#   is a recency-weighted, mean-reverted blend of a team's recent seasons — reset
#   toward league median when the head coach changed (a new staff ≠ the old tape).
#
#   Fingerprints follow the TEAM (modal head coach per season from PBP), the best
#   proxy available without a hand-curated play-caller map; the docs note where a
#   caller-name map and a WR/TE/RB positional target split would sharpen it.
#
#   Cadence mirrors the other model builders; every downstream reader must treat a
#   missing file / team as "no signal" and fall back to league-neutral.
# ──────────────────────────────────────────────────────────────────────────────
import os, io, csv, ssl, gzip, json, math, statistics, datetime, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "team_tendencies.json")
CACHE = os.environ.get("PBP_CACHE", "")   # optional dir to cache the big PBP downloads
PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{yr}.csv.gz"

SEASONS = list(range(2015, 2026))          # 11 seasons — matches the competitor's depth
CUR_SEASON = 2026                          # the baseline we publish for
RECENT = 3                                 # seasons that feed the current baseline
HALFLIFE = 1.5                             # recency weighting (seasons)
REVERT_K = 1.0                             # mean-reversion strength toward league median
COACH_RESET = 0.5                          # extra shrink toward median when the HC changed

ALIAS = {"OAK": "LV", "LVR": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS"}


def norm_team(t):
    t = (t or "").upper()
    return ALIAS.get(t, t)


def fnum(x):
    try:
        f = float(x)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def pbp_rows(yr):
    """Stream one season of play-by-play. Cache the gz locally when PBP_CACHE is set."""
    raw = None
    if CACHE:
        p = os.path.join(CACHE, f"pbp_{yr}.csv.gz")
        if os.path.exists(p):
            raw = open(p, "rb").read()
    if raw is None:
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(PBP_URL.format(yr=yr), headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=180, context=ctx).read()
        if CACHE:
            os.makedirs(CACHE, exist_ok=True)
            open(os.path.join(CACHE, f"pbp_{yr}.csv.gz"), "wb").write(raw)
    text = gzip.GzipFile(fileobj=io.BytesIO(raw)).read().decode("utf-8", "replace")
    return csv.DictReader(io.StringIO(text))


def season_positions(yr):
    """name → position from the local player-week file, for future use / QB id sanity."""
    path = os.path.join(DATA, f"nflverse_stats_{yr}.json")
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        d = json.load(fh)
    return {nm: (p.get("pos") or "").upper() for nm, p in d.items()}


def process_season(yr):
    """→ dict[team] = per-team raw tallies for the season."""
    T = defaultdict(lambda: {
        "plays": 0, "pass": 0, "rush": 0, "games": set(),
        "proe_sum": 0.0, "proe_n": 0,
        "carries": defaultdict(int), "pass_by": defaultdict(int),
        "targets": defaultdict(int), "coach": defaultdict(int),
    })
    for r in pbp_rows(yr):
        if r.get("season_type") != "REG":
            continue
        pt = norm_team(r.get("posteam"))
        if not pt:
            continue
        isP, isR = r.get("pass") == "1", r.get("rush") == "1"
        if not (isP or isR):
            continue
        t = T[pt]
        t["plays"] += 1
        t["games"].add(r.get("game_id"))
        if isP:
            t["pass"] += 1
        if isR:
            t["rush"] += 1
        # coach of this offense (home_coach when it's the home team, else away)
        coach = r.get("home_coach") if r.get("posteam_type") == "home" else r.get("away_coach")
        if coach:
            t["coach"][coach] += 1
        # PROE — neutral win-probability plays only, so it measures tendency not situation
        xoe, wp = fnum(r.get("pass_oe")), fnum(r.get("wp"))
        if xoe is not None and wp is not None and 0.2 <= wp <= 0.8:
            t["proe_sum"] += xoe; t["proe_n"] += 1
        # who ran / who passed (to strip QB runs from carry share)
        if isR and r.get("rusher_player_id"):
            t["carries"][r["rusher_player_id"]] += 1
        if isP and r.get("passer_player_id"):
            t["pass_by"][r["passer_player_id"]] += 1
        if r.get("pass_attempt") == "1" and r.get("receiver_player_id"):
            t["targets"][r["receiver_player_id"]] += 1
    return T


def team_metrics(t):
    g = len(t["games"]) or 1
    scrim = t["pass"] + t["rush"]
    pace = t["plays"] / g
    pass_pct = 100 * t["pass"] / scrim if scrim else None
    proe = t["proe_sum"] / t["proe_n"] if t["proe_n"] else None
    # carry share among non-QB rushers (drop the team's primary passer id)
    qb = max(t["pass_by"], key=t["pass_by"].get) if t["pass_by"] else None
    car = sorted((c for pid, c in t["carries"].items() if pid != qb), reverse=True)
    tot_car = sum(car)
    rb1 = 100 * car[0] / tot_car if tot_car and car else None
    rb2 = 100 * car[1] / tot_car if tot_car and len(car) > 1 else None
    tgt = sorted(t["targets"].values(), reverse=True)
    tot_tgt = sum(tgt)
    def share(i):
        return 100 * tgt[i] / tot_tgt if tot_tgt and len(tgt) > i else None
    return {
        "games": g, "pace": pace, "pass_pct": pass_pct, "proe": proe,
        "rb1_carry_pct": rb1, "rb2_carry_pct": rb2,
        "wr1_tgt_pct": share(0), "top2_tgt_pct": (share(0) + share(1)) if (share(0) is not None and share(1) is not None) else None,
        "top3_tgt_pct": (share(0) + share(1) + share(2)) if all(share(i) is not None for i in (0, 1, 2)) else None,
        "coach": max(t["coach"], key=t["coach"].get) if t["coach"] else None,
    }


METRIC_KEYS = ["pace", "pass_pct", "proe", "rb1_carry_pct", "rb2_carry_pct", "wr1_tgt_pct", "top2_tgt_pct", "top3_tgt_pct"]


def main():
    per_season = {}            # yr → { team → metrics }
    medians = {}               # yr → { metric → league median }
    for yr in SEASONS:
        try:
            T = process_season(yr)
        except Exception as e:
            print(f"[tendencies] {yr}: skip ({e})")
            continue
        def _round(mm):
            return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in mm.items()}
        m = {tm: _round(team_metrics(t)) for tm, t in T.items() if len(t["games"]) >= 4}
        per_season[yr] = m
        med = {}
        for k in METRIC_KEYS:
            vals = [mm[k] for mm in m.values() if mm.get(k) is not None]
            med[k] = statistics.median(vals) if vals else None
        medians[yr] = med
        pv = [mm["pace"] for mm in m.values() if mm.get("pace")]
        print(f"[tendencies] {yr}: {len(m)} teams  pace {min(pv):.1f}-{max(pv):.1f}  "
              f"pass% med {med['pass_pct']:.1f}  PROE med {med['proe']:.1f}")

    if not per_season:
        print("[tendencies] no seasons processed — aborting"); return

    # ── current baseline: recency-weighted, mean-reverted, coach-change-aware ──
    recent_yrs = [y for y in SEASONS if y in per_season][-RECENT:]
    teams = sorted({tm for y in recent_yrs for tm in per_season[y]})
    current = {}
    for tm in teams:
        # most recent season's coach = the staff we're projecting; older tape from a
        # different HC is down-weighted (a new coordinator doesn't inherit the mix).
        latest = next((y for y in reversed(recent_yrs) if tm in per_season[y]), None)
        cur_coach = per_season[latest][tm]["coach"] if latest else None
        coach_changed = False
        out = {"seasons_used": [], "coach": cur_coach}
        for k in METRIC_KEYS:
            num = den = 0.0
            for y in recent_yrs:
                mm = per_season[y].get(tm)
                if not mm or mm.get(k) is None or medians[y].get(k) is None:
                    continue
                w = 0.5 ** ((max(recent_yrs) - y) / HALFLIFE)
                if cur_coach and mm.get("coach") and mm["coach"] != cur_coach:
                    w *= COACH_RESET            # different staff → discount that tape
                    coach_changed = True
                num += w * (mm[k] - medians[y][k]); den += w    # work in delta-vs-median space
                if y not in out["seasons_used"]:
                    out["seasons_used"].append(y)
            # mean-reverted delta (Empirical-Bayes toward 0 = league median)
            delta = num / (den + REVERT_K) if den else 0.0
            med_cur = medians[max(recent_yrs)].get(k)
            out[k] = round(med_cur + delta, 2) if med_cur is not None else None
            out[k + "_delta"] = round(delta, 2)
        out["coach_changed"] = coach_changed
        current[tm] = out

    # league medians (latest season) for readers that want the neutral reference
    league = {k: (round(medians[max(recent_yrs)][k], 2) if medians[max(recent_yrs)].get(k) is not None else None)
              for k in METRIC_KEYS}

    payload = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "version": 1,
        "active": False,
        "note": ("Per-team neutral offensive fingerprint (pace, PROE, carry/target "
                 "concentration) for the prop model's Phase-2 baseline anchor. Deltas "
                 "are vs the season's league median. Ships DORMANT: readers fall back "
                 "to league-neutral until wired + validated in-season."),
        "cur_season": CUR_SEASON,
        "recent_seasons": recent_yrs,
        "league_median": league,
        "metrics": METRIC_KEYS,
        "current": current,
        "by_season": {str(y): per_season[y] for y in per_season},
        "provenance": {
            "source": "nflverse play-by-play (REG); PROE = mean pass_oe on neutral WP plays (0.2–0.8)",
            "carry_share": "non-QB rushers only (team's primary passer id removed)",
            "target_share": "rank-based receiver target concentration (position split is a follow-up)",
            "coach": "modal head_coach per team-season from PBP; a change vs the latest season down-weights older tape",
            "baseline": f"recency-weighted (halflife {HALFLIFE}s) delta-vs-median over the last {RECENT} seasons, mean-reverted (k={REVERT_K}), coach-change reset ×{COACH_RESET}",
            "seasons": recent_yrs,
        },
        "followups": [
            "position-split target tree (WR/TE/RB share) needs a gsis-id→position join",
            "play-caller-name attribution (OC, prior-team sample) needs a curated caller map",
            "wire current baseline into the scriptMult neutral anchor + role-share priors, gated on in-season CLV",
        ],
    }
    with open(OUT, "w") as fh:
        json.dump(payload, fh, indent=2)
    print(f"[tendencies] wrote {OUT}  ({len(current)} current teams over {recent_yrs})")


if __name__ == "__main__":
    main()
