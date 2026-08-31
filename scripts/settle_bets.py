#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
#  VAULT · SETTLEMENT + CLV HARNESS
#      data/prop_line_history.json  + data/game_line_history.json
#      + data/nflverse_stats_<season>.json + nflverse games.csv
#        →  data/bet_results.json   (per-pick settled ledger)
#        →  data/edge_scoreboard.json (aggregates: UI + model feedback)
#
#  Closes the loop prop-edge-model-plan.md calls #5. The snapshots are RETAINED
#  (finished weeks are kept, unlike the live board), so this rebuilds the whole
#  ledger deterministically each run — no append/merge, no drift.
#
#  CLV (closing-line value) is the PRIMARY signal: it accrues every week at low
#  variance, so it's the fast read on whether our number is sharp. Realized win%
#  is the slower, higher-variance confirmation. The builders read the scoreboard
#  back to sharpen the model over the season (docs/edge-feedback-loop.md).
#
#  Usage:  python3 scripts/settle_bets.py
#          python3 scripts/settle_bets.py --dry            (compute, don't write)
#          python3 scripts/settle_bets.py --season 2026    (limit to one season)
# ════════════════════════════════════════════════════════════════════════════
import argparse, csv, io, json, math, os, sys, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# Share the shipped serving math (dist / calibration / shrink) with the builder.
sys.path.insert(0, HERE)
import build_prop_projections as B  # noqa: E402

# ── market → nflverse weekly stat column(s) (superset of B.MARKETS; combos sum) ─
COL = {
    "pass_yd": ("pyds",), "pass_att": ("att",), "pass_cmp": ("cmp",),
    "pass_td": ("ptds",), "pass_int": ("ints",),
    "rush_yd": ("ryds",), "rush_att": ("car",), "rush_td": ("rtds",),
    "rec": ("rec",), "rec_yd": ("recyds",), "rec_td": ("rectds",),
    "anytime_td": ("rtds", "rectds"), "rush_rec_yd": ("ryds", "recyds"),
    "pass_rush_yd": ("pyds", "ryds"),
}
COUNT_MK = {"pass_att", "pass_cmp", "rush_att", "rec", "pass_int",
            "pass_td", "rush_td", "rec_td", "anytime_td"}   # integer stats → push only on integer line
K_BLEND = 300        # sample-size the in-season blend weight is shrunk against (large ⇒ early weeks barely move)
EPS = 1e-6


# ── odds helpers ────────────────────────────────────────────────────────────
def am_prob(a):
    if a is None: return None
    return 100.0 / (a + 100.0) if a > 0 else (-a) / (-a + 100.0)

def am_dec(a):
    if a is None: return None
    return a / 100.0 + 1.0 if a > 0 else 100.0 / (-a) + 1.0

def devig(over, under):
    """Two-way American prices → vig-free P(over). None if either side missing."""
    po, pu = am_prob(over), am_prob(under)
    if po is None or pu is None or (po + pu) == 0: return None
    return po / (po + pu)

def clamp(p, lo=EPS, hi=1 - EPS): return max(lo, min(hi, p))
def logit(p): p = clamp(p); return math.log(p / (1 - p))
def sig(x): return 1 / (1 + math.exp(-x))
def logloss1(y, p): p = clamp(p); return -(y * math.log(p) + (1 - y) * math.log(1 - p))


# ── model P(over) for a market's shipped params (mirrors prop-model.js serving) ─
def load_prop_model():
    try:
        m = json.load(open(os.path.join(DATA, "prop_model.json")))
        return m.get("markets", m)
    except Exception:
        return {}

def model_p_over(mp, proj, line):
    if mp is None or proj is None or line is None: return None
    try:
        raw = B.prob_fn_for(mp)(proj, line)
        p = B.apply_calib(mp.get("calib"), raw)
        p = B.shrink_prob(p, mp.get("shrink", 1.0))
        return clamp(p)
    except Exception:
        return None


# ── actuals ─────────────────────────────────────────────────────────────────
def load_actuals(season):
    """nflverse_stats for a season → {name: {wk: {col: val}}}. Regular/postseason
    weeks only (preseason is never in here, which is why we gate settlement to
    non-preseason: a 'pre' week N would otherwise false-match regular week N)."""
    # ONLY the per-season file — never the generic nflverse_stats.json alias,
    # which is season-ambiguous (it holds the current season) and would settle
    # e.g. 2026 week-1 props against 2025 week-1 actuals before 2026 data lands.
    path = os.path.join(DATA, f"nflverse_stats_{season}.json")
    if not os.path.exists(path):
        return {}
    try:
        blob = json.load(open(path))
    except Exception:
        return {}
    out = {}
    for name, rec in blob.items():
        if not isinstance(rec, dict): continue
        wk = {}
        for row in rec.get("weeks", []) or []:
            if isinstance(row, dict) and row.get("wk") is not None:
                wk[int(row["wk"])] = row
        if wk: out[name] = wk
    return out

def actual_for(actuals, name, week, market):
    cols = COL.get(market)
    if not cols: return None
    wk = actuals.get(name)
    if not wk: return None
    row = wk.get(int(week))
    if not row: return None
    tot, seen = 0.0, False
    for c in cols:
        v = row.get(c)
        if isinstance(v, (int, float)):
            tot += v; seen = True
    return tot if seen else None

def games_played(actuals, name, before_week):
    wk = actuals.get(name)
    return sum(1 for w in wk if w < before_week) if wk else 0


# ── grade (break-even-aware, confidence-shrunk by games so far) ──────────────
def grade_letter(padj, be=0.55):
    e = padj - be
    if e >= 0.10: return "A"
    if e >= 0.05: return "B"
    if e >= 0.02: return "C"
    if e >= 0.0:  return "D"
    return "F"

def grade_for(p_side, g, be=0.55):
    if p_side is None: return None
    padj = 0.5 + (p_side - 0.5) * g / (g + 6)   # shrink toward 0.5 by sample
    return grade_letter(padj, be)


# ── prop settlement ─────────────────────────────────────────────────────────
def settle_props(season_filter=None):
    try:
        blob = json.load(open(os.path.join(DATA, "prop_line_history.json")))
    except Exception:
        return [], {"reason": "no prop_line_history.json"}
    props = blob.get("props", {})
    # Dedup by pick identity (not by history-key): adding seasonType to the
    # snapshot key means one live prop can be retained under both the old and new
    # key format with identical body fields. Collapse to the freshest (latest
    # lastSeen, then most samples) so a settled pick is never double-counted.
    dedup = {}
    for r in props.values():
        ident = (str(r.get("season")), (r.get("seasonType") or "").lower(),
                 r.get("week"), r.get("pid"), r.get("market"))
        cur = dedup.get(ident)
        if cur is None:
            dedup[ident] = r; continue
        better = (r.get("lastSeen") or "", len(r.get("samples") or [])) > \
                 (cur.get("lastSeen") or "", len(cur.get("samples") or []))
        if better: dedup[ident] = r
    actuals_cache, model = {}, load_prop_model()
    picks, unmatched, unsettled = [], 0, 0

    for r in dedup.values():
        seasonType = (r.get("seasonType") or "").lower()
        if seasonType == "pre":       # preseason props settle against nothing meaningful; skip
            continue
        season = str(r.get("season"))
        if season_filter and season != str(season_filter): continue
        market, name, week = r.get("market"), r.get("name"), r.get("week")
        if market not in COL or not name or week is None:
            continue
        if season not in actuals_cache:
            actuals_cache[season] = load_actuals(season)
        actuals = actuals_cache[season]

        actual = actual_for(actuals, name, week, market)
        if actual is None:            # game not played yet, or name didn't join
            unsettled += 1
            if name not in actuals: unmatched += 1
            continue

        opn = r.get("open") or {}
        cls = (r.get("samples") or [r.get("cur")])[-1] or r.get("cur") or {}
        line_o, line_c = opn.get("line"), cls.get("line")
        proj = opn.get("proj")
        if line_o is None or line_c is None:
            unsettled += 1; continue

        # Vault's side is set at the flag (open): over if our projection beats the line.
        side = None
        if proj is not None:
            side = "over" if proj > line_o else "under"

        # outcome settled at the CLOSING line (the number a bettor actually gets)
        is_count = market in COUNT_MK
        push = is_count and float(line_c) == round(float(line_c)) and abs(actual - line_c) < 1e-9
        over_won = actual > line_c if is_count else actual > line_c
        won_close = won_open = None
        if side and not push:
            win_side = "over" if actual > line_c else "under"
            won_close = 1.0 if side == win_side else 0.0
            win_side_o = "over" if actual > line_o else "under"
            won_open = 1.0 if side == win_side_o else 0.0

        # ── CLV ──────────────────────────────────────────────────────────────
        # line CLV signed to our side: positive = market moved to give us the better number.
        clv_line = None
        if side == "over":  clv_line = line_c - line_o
        elif side == "under": clv_line = line_o - line_c
        # no-vig probability CLV from the two-way prices (book-agnostic; ~0 on flat pickem)
        q_o = devig(opn.get("over"), opn.get("under"))
        q_c = devig(cls.get("over"), cls.get("under"))
        clv_prob = None
        if side and q_o is not None and q_c is not None:
            qo_side = q_o if side == "over" else 1 - q_o
            qc_side = q_c if side == "over" else 1 - q_c
            clv_prob = qc_side - qo_side       # positive = market came to agree with us
        # price CLV on our side (decimal odds we got vs the close)
        po_side = (opn.get("bestOver") if side == "over" else opn.get("bestUnder"))
        pc_side = (cls.get("bestOver") if side == "over" else cls.get("bestUnder"))
        clv_price = None
        do, dc = am_dec(po_side), am_dec(pc_side)
        if do is not None and dc is not None: clv_price = do - dc

        beat_close = None
        if clv_line is not None:
            beat_close = 1.0 if (clv_line > 1e-9 or (abs(clv_line) < 1e-9 and (clv_prob or 0) > 1e-9)
                                 or (abs(clv_line) < 1e-9 and (clv_price or 0) > 1e-9)) else 0.0

        # ── model vs market probabilities (blend-weight + reliability inputs) ─
        p_model = model_p_over(model.get(market) if market in model else None, proj, line_o)
        p_model_side = None
        if p_model is not None and side:
            p_model_side = p_model if side == "over" else 1 - p_model
        p_mkt_side = None
        if q_o is not None and side:
            p_mkt_side = q_o if side == "over" else 1 - q_o
        g = games_played(actuals, name, week)
        grade = grade_for(p_model_side, g) if p_model_side is not None else None

        picks.append({
            "kind": "prop", "season": season, "seasonType": seasonType, "week": week,
            "pid": r.get("pid"), "name": name, "team": r.get("team"), "pos": r.get("pos"),
            "opp": r.get("opp"), "market": market, "side": side,
            "line_open": line_o, "line_close": line_c, "proj": proj, "actual": actual,
            "push": bool(push), "won_close": won_close, "won_open": won_open,
            "clv_line": clv_line, "clv_prob": clv_prob, "clv_price": clv_price,
            "beat_close": beat_close,
            "p_model": p_model_side, "p_market": p_mkt_side, "games": g, "grade": grade,
        })

    return picks, {"unsettled": unsettled, "unmatched_names": unmatched, "settled": len(picks)}


# ── game-market settlement ───────────────────────────────────────────────────
def load_games_csv(seasons):
    """nflverse games.csv → {(season,week,away,home): {home_score,away_score}}.
    Fetches once; on failure returns {} so prop settlement still proceeds."""
    try:
        with urllib.request.urlopen(GAMES_URL, timeout=30) as resp:
            text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"[settle] games.csv fetch failed ({e}); skipping game settlement")
        return {}
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            s = int(row.get("season") or 0)
            if s not in seasons: continue
            hs, as_ = row.get("home_score"), row.get("away_score")
            if hs in (None, "", "NA") or as_ in (None, "", "NA"): continue
            key = (str(s), str(row.get("week")), row.get("away_team"), row.get("home_team"))
            out[key] = {"home_score": float(hs), "away_score": float(as_)}
        except Exception:
            continue
    return out

def settle_games(season_filter=None):
    try:
        blob = json.load(open(os.path.join(DATA, "game_line_history.json")))
    except Exception:
        return [], {"reason": "no game_line_history.json"}
    games = blob.get("games", {})
    reg = [g for g in games.values() if (g.get("seasonType") or "").lower() not in ("pre",)]
    if not reg:
        return [], {"settled": 0, "note": "no non-preseason games banked yet"}
    seasons = {int(g["season"]) for g in reg if str(g.get("season")).isdigit()}
    scores = load_games_csv(seasons)
    if not scores:
        return [], {"settled": 0, "note": "no scores available"}

    picks, unsettled = [], 0
    for g in reg:
        season = str(g.get("season"))
        if season_filter and season != str(season_filter): continue
        away, home, week = g.get("away"), g.get("home"), str(g.get("week"))
        sc = scores.get((season, week, away, home))
        if not sc:
            unsettled += 1; continue
        margin = sc["home_score"] - sc["away_score"]         # home margin (actual)
        total_actual = sc["home_score"] + sc["away_score"]
        opn = g.get("open") or {}
        cls = (g.get("samples") or [g.get("cur")])[-1] or g.get("cur") or {}
        vl = cls.get("vault") or opn.get("vault")            # model line going into the game

        # SPREAD — the Vault model picks a side vs the closing market spread;
        # does that side cover? (forward ATS test of the game model)
        if vl and vl.get("spread") is not None and cls.get("spread") is not None and opn.get("spread") is not None:
            mkt_c, mkt_o = cls["spread"], opn["spread"]
            side = "home" if vl["spread"] < mkt_c else "away"   # model spread lower ⇒ model likes home more than market
            home_cov = margin + mkt_c > 0                       # home covers the closing spread
            push = abs(margin + mkt_c) < 1e-9
            won = None if push else (1.0 if (side == "home") == home_cov else 0.0)
            clv_line = (mkt_o - mkt_c) if side == "home" else (mkt_c - mkt_o)  # signed to model side
            picks.append({"kind": "game", "market": "spread", "season": season, "week": g.get("week"),
                          "away": away, "home": home, "side": side, "line_open": mkt_o, "line_close": mkt_c,
                          "vault_line": vl["spread"], "actual": margin, "push": push, "won_close": won,
                          "clv_line": clv_line, "beat_close": (1.0 if clv_line > 1e-9 else 0.0)})

        # TOTAL — model over/under vs the closing market total
        if vl and vl.get("total") is not None and cls.get("total") is not None and opn.get("total") is not None:
            mkt_c, mkt_o = cls["total"], opn["total"]
            side = "over" if vl["total"] > mkt_c else "under"
            push = abs(total_actual - mkt_c) < 1e-9
            won = None if push else (1.0 if (side == "over") == (total_actual > mkt_c) else 0.0)
            clv_line = (mkt_c - mkt_o) if side == "over" else (mkt_o - mkt_c)
            picks.append({"kind": "game", "market": "total", "season": season, "week": g.get("week"),
                          "away": away, "home": home, "side": side, "line_open": mkt_o, "line_close": mkt_c,
                          "vault_line": vl["total"], "actual": total_actual, "push": push, "won_close": won,
                          "clv_line": clv_line, "beat_close": (1.0 if clv_line > 1e-9 else 0.0)})

    return picks, {"settled": len(picks), "unsettled": unsettled}


# ── aggregation → scoreboard (UI + model feedback) ──────────────────────────
def mean(xs): xs = [x for x in xs if x is not None]; return sum(xs) / len(xs) if xs else None

def reliability(pairs, edges=(0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.01)):
    """(p_model_side, y) → in-season calibration curve, the recalibration input."""
    out, lo = [], 0.5
    for hi in edges:
        b = [(p, y) for p, y in pairs if lo <= p < hi]
        if b:
            out.append([round(lo, 3), round(hi, 3), len(b),
                        round(mean([p for p, _ in b]), 4), round(mean([y for _, y in b]), 4)])
        lo = hi
    return out

def fit_temp(pairs):
    """Grid-search the residual temperature t on the SERVED model probs vs
    in-season outcomes: p' = sig(t·logit(p)). t<1 ⇒ model still overconfident
    this season (needs more shrink); t>1 ⇒ under-confident. The builder composes
    a sample-shrunk version of this onto the shipped calib table (docs)."""
    pairs = [(p, y) for p, y in pairs if p is not None and y is not None]
    if len(pairs) < 40: return None, len(pairs)
    best_t, best_ll = 1.0, 1e18
    for i in range(6, 21):                      # t in [0.6 .. 2.0]
        t = i / 10.0
        ll = mean([logloss1(y, sig(t * logit(p))) for p, y in pairs])
        if ll < best_ll: best_t, best_ll = t, ll
    return best_t, len(pairs)


def fit_blend_w(triples):
    """Grid-search the model↔market blend weight (weight on the model) that
    minimizes blended log-loss vs outcomes. This is the MEASURED weight; the
    builder shrinks it by n/(n+K) so early weeks barely move (docs)."""
    triples = [(pm, pk, y) for pm, pk, y in triples if pm is not None and pk is not None and y is not None]
    if len(triples) < 30: return None, len(triples)
    best_w, best_ll = 1.0, 1e18
    for i in range(21):
        w = i / 20.0
        ll = mean([logloss1(y, sig(w * logit(pm) + (1 - w) * logit(pk))) for pm, pk, y in triples])
        if ll < best_ll: best_w, best_ll = w, ll
    return best_w, len(triples)

def build_scoreboard(prop_picks, game_picks):
    board = {"markets": {}, "grades": {}, "games": {}}

    by_mk = defaultdict(list)
    for p in prop_picks: by_mk[p["market"]].append(p)
    for mk, ps in by_mk.items():
        graded = [p for p in ps if p["won_close"] is not None]      # excludes pushes / no-side
        rel_pairs = [(p["p_model"], p["won_close"]) for p in graded if p["p_model"] is not None]
        triples = [(p["p_model"], p["market"] and p["p_market"], p["won_close"]) for p in graded]
        w_meas, n_blend = fit_blend_w([(p["p_model"], p["p_market"], p["won_close"]) for p in graded])
        ml = [logloss1(p["won_close"], p["p_model"]) for p in graded if p["p_model"] is not None]
        kl = [logloss1(p["won_close"], p["p_market"]) for p in graded if p["p_market"] is not None]
        temp, n_temp = fit_temp(rel_pairs)
        board["markets"][mk] = {
            "n": len(ps), "n_graded": len(graded),
            "winrate_close": mean([p["won_close"] for p in graded]),
            "clv_beat_rate": mean([p["beat_close"] for p in ps]),
            "mean_clv_prob": mean([p["clv_prob"] for p in ps]),
            "mean_clv_line": mean([p["clv_line"] for p in ps]),
            "model_logloss": mean(ml), "market_logloss": mean(kl),
            "reliability": reliability(rel_pairs),
            "inseason_temp": {"t": temp, "n": n_temp, "k_shrink": K_BLEND,
                              "note": "builder composes t onto calib, shrunk by n/(n+K)"},
            "blend": {"w_measured": w_meas, "n": n_blend, "k_shrink": K_BLEND,
                      "note": "measured model<->market weight; served blend deferred (see docs #3)"},
        }

    by_grade = defaultdict(list)
    for p in prop_picks:
        if p["grade"] and p["won_close"] is not None: by_grade[p["grade"]].append(p)
    for gr, ps in by_grade.items():
        board["grades"][gr] = {"n": len(ps), "winrate_close": mean([p["won_close"] for p in ps]),
                               "clv_beat_rate": mean([p["beat_close"] for p in ps]),
                               "mean_clv_prob": mean([p["clv_prob"] for p in ps])}

    by_gm = defaultdict(list)
    for p in game_picks: by_gm[p["market"]].append(p)
    for mk, ps in by_gm.items():
        graded = [p for p in ps if p["won_close"] is not None]
        board["games"][mk] = {"n": len(ps), "n_graded": len(graded),
                              "ats_or_ou_pct": mean([p["won_close"] for p in graded]),
                              "clv_beat_rate": mean([p["beat_close"] for p in ps]),
                              "mean_clv_line": mean([p["clv_line"] for p in ps])}
    return board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=None)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    prop_picks, pmeta = settle_props(args.season)
    game_picks, gmeta = settle_games(args.season)
    board = build_scoreboard(prop_picks, game_picks)

    import datetime
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    ledger = {"generated": now, "props": prop_picks, "games": game_picks,
              "meta": {"props": pmeta, "games": gmeta}}
    scoreboard = {"generated": now, "k_shrink": K_BLEND,
                  "settled_props": len(prop_picks), "settled_games": len(game_picks),
                  **board, "meta": {"props": pmeta, "games": gmeta}}

    print(f"[settle] props: {pmeta}")
    print(f"[settle] games: {gmeta}")
    for mk, m in sorted(board["markets"].items()):
        wr = m["winrate_close"]; cb = m["clv_beat_rate"]
        print(f"   {mk:14s} n={m['n']:4d} graded={m['n_graded']:4d} "
              f"win={wr:.3f} " if wr is not None else f"   {mk:14s} n={m['n']:4d} graded={m['n_graded']:4d} win=  -   "
              , f"clv-beat={cb:.3f}" if cb is not None else "clv-beat=  -  ",
              f"w={m['blend']['w_measured']}" if m['blend']['w_measured'] is not None else "")

    if args.dry:
        print("[settle] --dry: not written"); return
    json.dump(ledger, open(os.path.join(DATA, "bet_results.json"), "w"))
    json.dump(scoreboard, open(os.path.join(DATA, "edge_scoreboard.json"), "w"))
    print(f"[settle] wrote bet_results.json ({len(prop_picks)} props, {len(game_picks)} games) + edge_scoreboard.json")


if __name__ == "__main__":
    main()
