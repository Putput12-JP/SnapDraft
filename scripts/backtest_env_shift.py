#!/usr/bin/env python3
# backtest_env_shift.py ──────────────────────────────────────────────────────────
#   Does a change-only team-environment shift improve player VOLUME prediction?
#
#   The prop model is autoregressive on a player's own logs, which already encode
#   his team's pace/mix. So a team-tendency multiplier only adds information at a
#   DISCONTINUITY — he changed teams, or his team changed coordinators. This tests
#   exactly that, out of sample:
#
#     baseline pred (yr Y) = player's per-game volume in Y-1
#     shift    pred (yr Y) = baseline × (1 + DAMP·(teamFamilyPlays_curY /
#                                                   teamFamilyPlays_histY-1 − 1)), clamped
#       where teamFamilyPlays(env) = pace × (pass% for pass-family, rush% for rush)
#
#   Reported split by CHANGED (new team or new head coach) vs STABLE. The design is
#   only worth wiring if it helps the changed group without hurting the stable one.
#   Volume target by position: QB att, RB car, WR/TE rec (per game).
#
#   RESULT (2016-2025, leakage-free projected env — NO-GO for wiring):
#     ALL      +0.2% MAPE     CHANGED +0.4%     STABLE +0.2%
#     CHANGED pass-family +1.0% (best case)     CHANGED rush-family −1.1% (HURTS)
#   Once the team env is projected from prior seasons (as production must — we don't
#   know this season's pace/mix pregame), the shift adds essentially nothing, and it
#   actively hurts traded RBs (their carries hinge on the job battle, not team rush
#   volume). Vault's existing role_volume/roleShift already re-estimates a moved
#   player's ROLE, which is the part that matters — the team-env layer is redundant
#   on top. So the team tendencies ship as the Blueprint RESEARCH surface (real
#   standalone value), NOT as a projection multiplier. Kept as a documented gate,
#   like backtest_prop_model.py's TD-tail finding.
# ──────────────────────────────────────────────────────────────────────────────
import os, json, glob, math, statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
TEND = os.path.join(DATA, "team_tendencies.json")

MIN_G = 6                      # games in each season for a stable per-game rate
DAMPS = [0.35, 0.5, 0.65]      # player share doesn't move 1:1 with team volume
CLAMP = (0.88, 1.12)
FAMILY = {"QB": "pass", "WR": "pass", "TE": "pass", "RB": "rush"}
VOL = {"QB": "att", "RB": "car", "WR": "rec", "TE": "rec"}
ALIAS = {"OAK": "LV", "LVR": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS"}


def nt(t):
    t = (t or "").upper()
    return ALIAS.get(t, t)


def load_season(y):
    p = os.path.join(DATA, f"nflverse_stats_{y}.json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def per_game(player, field):
    g = v = 0
    for w in player.get("weeks", []):
        x = w.get(field)
        if x is not None:
            v += x; g += 1
    return (v / g, g) if g else (None, 0)


def fam_plays(env, fam):
    if not env or env.get("pace") is None or env.get("pass_pct") is None:
        return None
    share = env["pass_pct"] if fam == "pass" else (100 - env["pass_pct"])
    return env["pace"] * share / 100.0


def league_median(bs, y, key):
    vals = [m[key] for m in bs.get(str(y), {}).values() if m.get(key) is not None]
    return statistics.median(vals) if vals else None


# Leakage-free projection of a team's env AS-OF season Y: recency-weighted,
# mean-reverted delta-vs-median over seasons < Y, reset toward median when the
# year-Y coach (announced pregame, so fair to use) differs from the prior tape.
# Mirrors build_team_tendencies.current so the backtest matches what ships.
def proj_env(bs, team, Y, cur_coach, keys=("pace", "pass_pct"), recent=3, hl=1.5, k=1.0, reset=0.5):
    yrs = [y for y in range(Y - recent, Y) if str(y) in bs and team in bs[str(y)]]
    if not yrs:
        return None
    out = {}
    for key in keys:
        num = den = 0.0
        for y in yrs:
            mm = bs[str(y)][team]
            med = league_median(bs, y, key)
            if mm.get(key) is None or med is None:
                continue
            w = 0.5 ** ((Y - 1 - y) / hl)
            if cur_coach and mm.get("coach") and mm["coach"] != cur_coach:
                w *= reset
            num += w * (mm[key] - med); den += w
        med_ref = league_median(bs, Y - 1, key)
        if med_ref is None:
            return None
        out[key] = med_ref + (num / (den + k) if den else 0.0)
    return out


def main():
    tend = json.load(open(TEND))
    bs = tend["by_season"]
    seasons = sorted(int(y) for y in bs)
    rows = []   # (changed, family, actual, base_pred, {damp: shift_pred})
    for Y in seasons:
        if (Y - 1) not in seasons:
            continue
        cur, prev = load_season(Y), load_season(Y - 1)
        if not cur or not prev:
            continue
        prev_by_key = {}
        for nm, p in prev.items():
            prev_by_key[nm] = p
        for nm, p in cur.items():
            pos = (p.get("pos") or "").upper()
            if pos not in FAMILY:
                continue
            pp = prev.get(nm)
            if not pp:
                continue
            fam, field = FAMILY[pos], VOL[pos]
            act, gA = per_game(p, field)
            base, gB = per_game(pp, field)
            if act is None or base is None or gA < MIN_G or gB < MIN_G or base <= 0 or act <= 0:
                continue
            curTeam, histTeam = nt(p.get("team")), nt(pp.get("team"))
            coachCur = (bs.get(str(Y), {}).get(curTeam) or {}).get("coach")   # known pregame
            # curEnv: leakage-free projection from < Y data. histEnv: the actual env
            # the player's most-recent logs reflect (his prior team last season).
            envCur = proj_env(bs, curTeam, Y, coachCur)
            envHist = bs.get(str(Y - 1), {}).get(histTeam)
            fpC, fpH = fam_plays(envCur, fam), fam_plays(envHist, fam)
            if not fpC or not fpH:
                continue
            coachHistSameTeam = (bs.get(str(Y - 1), {}).get(curTeam) or {}).get("coach")
            changed = (histTeam != curTeam) or (coachCur and coachHistSameTeam and coachCur != coachHistSameTeam)
            ratio = fpC / fpH
            preds = {}
            for d in DAMPS:
                m = max(CLAMP[0], min(CLAMP[1], 1 + d * (ratio - 1)))
                preds[d] = base * m
            rows.append((bool(changed), fam, act, base, preds))

    def report(subset, label):
        if not subset:
            print(f"  {label}: (none)"); return
        n = len(subset)
        base_ae = statistics.fmean(abs(a - b) / a for _, _, a, b, _ in subset)
        print(f"  {label}: n={n}  baseline MAPE={base_ae*100:.2f}%")
        for d in DAMPS:
            sh_ae = statistics.fmean(abs(a - pr[d]) / a for _, _, a, _, pr in subset)
            impr = 100 * (base_ae - sh_ae) / base_ae
            print(f"      damp {d}: shift MAPE={sh_ae*100:.2f}%   ({impr:+.2f}% vs baseline)")

    print(f"[env-shift] {len(rows)} player-seasons across {seasons[0]+1}-{seasons[-1]}")
    changed = [r for r in rows if r[0]]
    stable = [r for r in rows if not r[0]]
    print(f"[env-shift] changed (new team or new HC): {len(changed)}  |  stable: {len(stable)}")
    report(rows, "ALL")
    report(changed, "CHANGED situations")
    report(stable, "STABLE situations")
    for fam in ("pass", "rush"):
        report([r for r in changed if r[1] == fam], f"CHANGED · {fam}-family")


if __name__ == "__main__":
    main()
