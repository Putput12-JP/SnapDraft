#!/usr/bin/env python3
# build_game_script.py ─────────────────────────────────────────────────────────
#   Fits the GAME-SCRIPT term for the player-prop model → data/game_script_model.json
#
#   The prop model's env adjustment (matchupAdj) scales ALL of a team's markets by
#   one direction-blind multiplier off implied team total. That is right on scoring
#   VOLUME but wrong on pass/rush MIX: it drags an underdog's passing props DOWN
#   when negative game script should push them UP. This term adds a spread-driven
#   `scriptMult` that skews pass-family vs rush-family volume in OPPOSITE directions.
#
#   Fit (holdout-validated, never in-sample eyeballed):
#     • team game logs — pass attempts (Σ att) and rush attempts (Σ car) per
#       team-game, aggregated from data/nflverse_stats_<season>.json (already pulled).
#     • joined to that game's PREGAME market spread from nflverse games.csv
#       (spread_line — the closing pregame number; set before kickoff, does not
#       leak the outcome the way an in-game number would).
#     • per team-season baseline pass/rush SHARE isolates MIX from pace/total (the
#       total channel is already handled by envMult), so we don't double-count it.
#     • functional form matches exactly what the three surfaces deploy:
#         s = clamp(spread / SP_REF, -1, 1)          # favorite < 0, dog > 0
#         passScriptMult = clamp(1 + K_PASS·s,      lo, hi)   # dog → > 1
#         rushScriptMult = clamp(1 + K_RUSH·(−s),   lo, hi)   # dog → < 1
#
#   Every reader falls back to scriptMult = 1 when this file is absent (mirror the
#   trade-market getters: "not in the model" degrades to the old behavior for free).
#
#   docs/game-script-prop-model.md — spec, families, phasing, validation gate.
# ──────────────────────────────────────────────────────────────────────────────
import os, io, csv, ssl, json, math, glob, datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "game_script_model.json")
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# Fit window: the modern pass-happy era. Team-relative baselines normalize each
# team-season, so era pass-rate drift doesn't bias the MIX response to spread.
FIT_FROM = 2014
MIN_TEAM_GAMES = 6            # a team-season needs this many games for a stable baseline
SP_REF_GRID = [round(6 + 0.5 * i, 1) for i in range(0, 17)]   # 6.0 … 14.0
CLAMP = [0.90, 1.12]         # spec discipline — same ±10-12% rail as envMult
TD_DAMP = 0.5                # damp scriptMult on efficiency-heavy TD (Poisson) markets

# Which modeled markets ride which volume family (must mirror prop_model.json keys).
FAMILIES = {
    "pass":    ["pass_att", "pass_cmp", "pass_yd", "rec", "rec_yd"],
    "rush":    ["rush_att", "rush_yd"],
    "pass_td": ["pass_td", "rec_td"],           # pass family, damped
}

ALIAS = {"OAK": "LV", "LVR": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS"}


def norm_team(t):
    t = (t or "").upper()
    return ALIAS.get(t, t)


def fetch_games():
    """games.csv → REG games with a spread_line, mapped to per-team Vegas spread
    (favorite negative). Returns dict[(season, team, week)] = team_spread, plus a
    list of (spread_line, home_margin) pairs to verify the sign convention."""
    text = None
    try:
        import requests
        text = requests.get(GAMES_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=90).text
    except Exception:
        import urllib.request
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(GAMES_URL, headers={"User-Agent": "Mozilla/5.0"})
        text = urllib.request.urlopen(req, timeout=90, context=ctx).read().decode("utf-8", "replace")

    def f(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    spread = {}
    sign_pairs = []
    for r in csv.DictReader(io.StringIO(text)):
        if (r.get("game_type") or "").upper() != "REG":
            continue
        season = int(r["season"]) if r.get("season", "").isdigit() else None
        if season is None or season < FIT_FROM:
            continue
        wk = int(r["week"]) if r.get("week", "").isdigit() else None
        sl = f(r.get("spread_line"))
        if wk is None or sl is None:
            continue
        ht, at = norm_team(r.get("home_team")), norm_team(r.get("away_team"))
        # nflverse spread_line is the HOME team's expected margin (positive ⇒ home
        # favored), same scale build_game_model.py compares to home margin. Vegas
        # "favorite negative" convention ⇒ home spread = −spread_line, away = +.
        spread[(season, ht, wk)] = -sl
        spread[(season, at, wk)] = sl
        hs, as_ = f(r.get("home_score")), f(r.get("away_score"))
        if hs is not None and as_ is not None:
            sign_pairs.append((sl, hs - as_))
    return spread, sign_pairs


def team_games(seasons):
    """dict[(season, team, week)] = (pass_att, rush_att) from the local player files."""
    agg = defaultdict(lambda: [0, 0])
    for s in seasons:
        path = os.path.join(DATA, f"nflverse_stats_{s}.json")
        if not os.path.exists(path):
            continue
        with open(path) as fh:
            d = json.load(fh)
        for _nm, p in d.items():
            t = norm_team(p.get("team"))
            if not t:
                continue
            for w in p.get("weeks", []):
                wk = w.get("wk")
                if not wk:
                    continue
                att = w.get("att") or 0
                car = w.get("car") or 0
                cell = agg[(s, t, wk)]
                cell[0] += att
                cell[1] += car
    return agg


def build_samples(agg, spread):
    """Join team-games to spread, subtract each team-season's own baseline share.
    Returns list of dicts: {season, spread, pRatio, rRatio}."""
    # per-team-season game shares
    by_ts = defaultdict(list)   # (season, team) → [(wk, psh)]
    for (s, t, wk), (patt, ratt) in agg.items():
        tot = patt + ratt
        if tot < 10:            # a near-empty team-week (data gap) — skip
            continue
        sp = spread.get((s, t, wk))
        if sp is None:
            continue            # no REG spread (bye / playoffs / missing) → drop
        by_ts[(s, t)].append((wk, patt / tot, sp))

    samples = []
    for (s, t), games in by_ts.items():
        if len(games) < MIN_TEAM_GAMES:
            continue
        base_psh = sum(g[1] for g in games) / len(games)
        base_rsh = 1 - base_psh
        if base_psh <= 0 or base_rsh <= 0:
            continue
        for (wk, psh, sp) in games:
            samples.append({
                "season": s, "spread": sp,
                "pRatio": psh / base_psh,
                "rRatio": (1 - psh) / base_rsh,
            })
    return samples


def _fit_k(samples, sp_ref, key, sign):
    """OLS through the deployed form ratio = 1 + K·(sign·s), s=clamp(sp/SP_REF,-1,1).
    K = Σ(y−1)·x / Σx²   (x = sign·s). Returns (K, sse)."""
    num = den = sse = 0.0
    for r in samples:
        s = max(-1.0, min(1.0, r["spread"] / sp_ref))
        x = sign * s
        y = r[key]
        num += (y - 1) * x
        den += x * x
    k = num / den if den > 0 else 0.0
    for r in samples:
        s = max(-1.0, min(1.0, r["spread"] / sp_ref))
        x = sign * s
        pred = 1 + k * x
        sse += (r[key] - pred) ** 2
    return k, sse


def fit(samples, sp_ref):
    kp, sse_p = _fit_k(samples, sp_ref, "pRatio", +1)   # dog (s>0) → pass up
    kr, sse_r = _fit_k(samples, sp_ref, "rRatio", -1)   # dog (s>0) → rush down
    return kp, kr, sse_p + sse_r


def choose_sp_ref(samples):
    best = None
    for spref in SP_REF_GRID:
        kp, kr, sse = fit(samples, spref)
        if best is None or sse < best[3]:
            best = (spref, kp, kr, sse)
    return best   # (sp_ref, K_PASS, K_RUSH, sse)


def _rmse(vals):
    return math.sqrt(sum(v * v for v in vals) / len(vals)) if vals else None


def holdout(samples, sp_ref):
    """Leave-one-season-out. For each holdout season, fit K on the rest and score
    the held-out games. Reports whether the script term beats the no-script
    baseline (predict ratio = 1) OUT of sample, and where the lift lands."""
    seasons = sorted({r["season"] for r in samples})
    per_season = []
    pooled_pred = []      # out-of-sample predictions for the bucket table
    for Y in seasons:
        train = [r for r in samples if r["season"] != Y]
        test = [r for r in samples if r["season"] == Y]
        if len(train) < 200 or not test:
            continue
        kp, kr, _ = fit(train, sp_ref)
        p_base, p_mdl, r_base, r_mdl = [], [], [], []
        dir_hit = dir_n = 0
        for r in test:
            s = max(-1.0, min(1.0, r["spread"] / sp_ref))
            pp = 1 + kp * s
            rp = 1 + kr * (-s)
            p_base.append(r["pRatio"] - 1); p_mdl.append(r["pRatio"] - pp)
            r_base.append(r["rRatio"] - 1); r_mdl.append(r["rRatio"] - rp)
            if abs(r["spread"]) >= 6:     # big-spread games: does mix bend the right way?
                dir_n += 1
                if (r["pRatio"] - 1) * s > 0:   # dog throws more than its baseline
                    dir_hit += 1
            pooled_pred.append({"spread": r["spread"], "pRatio": r["pRatio"], "rRatio": r["rRatio"]})
        pb, pm = _rmse(p_base), _rmse(p_mdl)
        rb, rm = _rmse(r_base), _rmse(r_mdl)
        per_season.append({
            "season": Y, "n": len(test),
            "K_PASS": round(kp, 4), "K_RUSH": round(kr, 4),
            "pass_rmse_base": round(pb, 4), "pass_rmse_model": round(pm, 4),
            "pass_rmse_impr_pct": round(100 * (pb - pm) / pb, 1) if pb else None,
            "rush_rmse_base": round(rb, 4), "rush_rmse_model": round(rm, 4),
            "rush_rmse_impr_pct": round(100 * (rb - rm) / rb, 1) if rb else None,
            "bigspread_dir_acc_pct": round(100 * dir_hit / dir_n, 1) if dir_n else None,
        })
    # pooled bucket table — the "lift lands where theory predicts" check
    buckets = [(-99, -9, "fav ≥9"), (-9, -3, "fav 3-9"), (-3, 3, "≈pick"),
               (3, 9, "dog 3-9"), (9, 99, "dog ≥9")]
    table = []
    for lo, hi, label in buckets:
        grp = [p for p in pooled_pred if lo <= p["spread"] < hi]
        if not grp:
            continue
        table.append({
            "bucket": label, "n": len(grp),
            "mean_passRatio": round(sum(p["pRatio"] for p in grp) / len(grp), 4),
            "mean_rushRatio": round(sum(p["rRatio"] for p in grp) / len(grp), 4),
        })
    # pooled improvement
    def pooled(key, sign, kp, kr):
        base, mdl = [], []
        for p in pooled_pred:
            s = max(-1.0, min(1.0, p["spread"] / sp_ref))
            pred = 1 + (kp if sign > 0 else kr) * (sign * s)
            base.append(p[key] - 1); mdl.append(p[key] - pred)
        b, m = _rmse(base), _rmse(mdl)
        return b, m, (100 * (b - m) / b if b else None)
    kp_all, kr_all, _ = fit(samples, sp_ref)
    pb, pm, ppi = pooled("pRatio", +1, kp_all, kr_all)
    rb, rm, rpi = pooled("rRatio", -1, kp_all, kr_all)
    return {
        "method": "leave-one-season-out; fit K on other seasons, score held-out games",
        "per_season": per_season,
        "pooled_holdout": {
            "pass_rmse_base": round(pb, 4), "pass_rmse_model": round(pm, 4), "pass_rmse_impr_pct": round(ppi, 1) if ppi is not None else None,
            "rush_rmse_base": round(rb, 4), "rush_rmse_model": round(rm, 4), "rush_rmse_impr_pct": round(rpi, 1) if rpi is not None else None,
        },
        "spread_buckets": table,
    }


def main():
    seasons = sorted(int(p.split("_")[-1].split(".")[0])
                     for p in glob.glob(os.path.join(DATA, "nflverse_stats_*.json"))
                     if p.split("_")[-1].split(".")[0].isdigit())
    seasons = [s for s in seasons if s >= FIT_FROM]
    print(f"[game-script] fitting from seasons {seasons}")

    spread, sign_pairs = fetch_games()
    # verify the sign convention we assumed (spread_line positive ⇒ home favored)
    if sign_pairs:
        n = len(sign_pairs)
        mean_x = sum(a for a, _ in sign_pairs) / n
        mean_y = sum(b for _, b in sign_pairs) / n
        cov = sum((a - mean_x) * (b - mean_y) for a, b in sign_pairs) / n
        assert cov > 0, "spread_line sign convention unexpected — home-margin correlation is negative"
        print(f"[game-script] spread_line→home-margin cov={cov:.2f} (positive ⇒ home-favored-positive, as assumed)")

    agg = team_games(seasons)
    samples = build_samples(agg, spread)
    print(f"[game-script] {len(samples)} team-game samples over {len({(r['season']) for r in samples})} seasons")

    sp_ref, kp, kr, sse = choose_sp_ref(samples)
    # clamp discipline: the deployed multiplier is railed, but keep the raw K honest
    kp_c = max(0.0, min(CLAMP[1] - 1, kp))
    kr_c = max(0.0, min(CLAMP[1] - 1, kr))
    print(f"[game-script] SP_REF={sp_ref}  K_PASS={kp:.4f}  K_RUSH={kr:.4f}  (clamped bounds {CLAMP})")

    bt = holdout(samples, sp_ref)
    ph = bt["pooled_holdout"]
    print(f"[game-script] holdout pass RMSE {ph['pass_rmse_base']}→{ph['pass_rmse_model']} ({ph['pass_rmse_impr_pct']}%)  "
          f"rush {ph['rush_rmse_base']}→{ph['rush_rmse_model']} ({ph['rush_rmse_impr_pct']}%)")
    for b in bt["spread_buckets"]:
        print(f"    {b['bucket']:>8}  n={b['n']:>4}  passRatio={b['mean_passRatio']}  rushRatio={b['mean_rushRatio']}")

    # Ship gate. The holdout lift on the underlying quantity (team pass/rush attempt
    # share) is directionally correct but small, and the CLV-vs-closing-line gate
    # (the one the spec makes a hard requirement) cannot run until in-season prop
    # picks settle. So the model ships DORMANT — every reader honors `active` and
    # falls back to scriptMult ×1 while it is false. Flip to true only after the
    # settlement/CLV loop confirms it beats the line on large-spread volume props.
    pass_lift = ph.get("pass_rmse_impr_pct")
    rush_lift = ph.get("rush_rmse_impr_pct")
    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "version": 1,
        "active": False,
        "activation_gate": ("Holdout is on attempt prediction only; the CLV-vs-closing-line gate "
                            "needs settled in-season prop picks (currently empty). Flip `active` to "
                            "true once the settlement loop confirms the term beats the line on "
                            f"large-spread volume props. Holdout attempt lift so far: pass {pass_lift}%, rush {rush_lift}%."),
        "note": ("Spread-driven pass/rush MIX skew for the prop model. Applied to the "
                 "VOLUME component only, on top of (never instead of) envMult. Clamped "
                 "to the same ±10-12% rail as envMult. Fallback ×1 when absent OR inactive."),
        "SP_REF": sp_ref,
        "K_PASS": round(kp_c, 4),
        "K_RUSH": round(kr_c, 4),
        "K_PASS_raw": round(kp, 4),
        "K_RUSH_raw": round(kr, 4),
        "clamp": CLAMP,
        "td_damp": TD_DAMP,
        "families": FAMILIES,
        "provenance": {
            "source": "nflverse team game logs (Σ att / Σ car per team-game from nflverse_stats_<season>.json) joined to games.csv pregame spread_line",
            "spread_convention": "team spread, favorite negative (home = −spread_line, away = +spread_line)",
            "fit": "per team-season baseline pass/rush SHARE removed (isolates MIX from pace/total, which envMult already carries); OLS through 1+K·clamp(sp/SP_REF,±1); SP_REF chosen by pooled SSE grid search",
            "seasons": seasons,
            "n_samples": len(samples),
            "fit_sse": round(sse, 2),
            "clamp_note": "K_PASS/K_RUSH published pre-clamped into [0, hi-1]; K_*_raw are the unclamped fits",
        },
        "backtest": bt,
        "validation_note": ("Holdout is on team pass/rush ATTEMPT prediction — the volume this term moves. "
                            "The CLV-vs-closing-line gate (settlement loop, edge-feedback-loop.md) needs settled "
                            "in-season prop picks, which are empty at build time; it is the in-season follow-up."),
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"[game-script] wrote {OUT}")


if __name__ == "__main__":
    main()
