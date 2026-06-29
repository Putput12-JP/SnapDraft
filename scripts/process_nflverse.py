"""
process_nflverse.py  Vault Fantasy nflverse data pipeline
Uses the new stats_player release (nflfastR::calculate_stats format).

Season is AUTO-DETECTED (Sleeper /state/nfl) so the pipeline rolls over to a new
season on its own. During the offseason / preseason — before the detected season
has any regular-season data — it falls back to the last COMPLETE season as
"current", so the app keeps showing real data instead of an empty table.

Also pulls Next Gen Stats (passing / rushing / receiving) and surfaces the
richer per-week fields the older version discarded.
"""
import requests, csv, json, os, io, gzip
from datetime import datetime, timezone
from collections import defaultdict

# ── season detection ──────────────────────────────────────────────────────
# Detected at runtime (see detect_season). These module-level values are filled
# in by main() so helper functions can read CURRENT_SEASON / ARCHIVE_SEASON.
CURRENT_SEASON = None
ARCHIVE_SEASON = None

STATS_BASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player"
OLD_BASE   = "https://github.com/nflverse/nflverse-data/releases/download"
NGS_BASE   = "https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats"
PFR_BASE   = "https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats"
SLEEPER_STATE = "https://api.sleeper.com/state/nfl"
NGS_FIRST_YEAR = 2016  # Next Gen Stats only exist from 2016 on
PFR_FIRST_YEAR = 2018  # PFR advanced stats coverage starts here

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
os.makedirs(OUTPUT_DIR, exist_ok=True)
HEADERS = {"User-Agent": "VaultFantasy/2.0"}
POSITIONS = {"QB", "RB", "WR", "TE", "FB"}

# How many seasons of archive (incl. current) to keep available to the UI.
ARCHIVE_DEPTH = 3


def detect_season():
    """Return (detected_year, season_type, display_week) from Sleeper.

    Sleeper /state/nfl is the canonical season clock the rest of Vault already
    trusts (see build-feed.mjs). Falls back to a date-based guess if the call
    fails — the NFL league year flips in March, so Jan/Feb belong to the prior
    season's playoffs.
    """
    try:
        r = requests.get(SLEEPER_STATE, headers=HEADERS, timeout=30)
        r.raise_for_status()
        s = r.json()
        season = int(s.get("season"))
        stype = s.get("season_type", "regular")
        week = si(s.get("display_week") or s.get("week") or s.get("leg")) or 0
        print(f"  Sleeper state: season={season} type={stype} week={week}")
        return season, stype, week
    except Exception as e:
        now = datetime.now(timezone.utc)
        guess = now.year if now.month >= 3 else now.year - 1
        print(f"  WARN season detect failed ({e}); date-guess -> {guess}")
        return guess, "unknown", 0


def fetch_csv(url, label):
    print(f"  Fetching {label}...")
    r = requests.get(url, headers=HEADERS, allow_redirects=True, timeout=90)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    print(f"    -> {len(rows):,} rows")
    return rows


def try_fetch_csv(url, label):
    """Like fetch_csv but returns [] instead of raising (for optional feeds)."""
    try:
        return fetch_csv(url, label)
    except Exception as e:
        print(f"  WARN {label}: {e}")
        return []


def try_fetch_csv_gz(url, label):
    """Fetch a gzipped CSV (nflverse NGS assets ship as .csv.gz). Returns []
    on any failure or if the asset is empty/placeholder."""
    try:
        print(f"  Fetching {label}...")
        r = requests.get(url, headers=HEADERS, allow_redirects=True, timeout=90)
        r.raise_for_status()
        text = gzip.decompress(r.content).decode("utf-8", "replace")
        rows = list(csv.DictReader(io.StringIO(text)))
        print(f"    -> {len(rows):,} rows")
        return rows
    except Exception as e:
        print(f"  WARN {label}: {e}")
        return []


def sf(val, default=None):
    try:
        f = float(val)
        return None if f != f else round(f, 4)
    except (ValueError, TypeError):
        return default


def si(val, default=None):
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default


def pct(val):
    f = sf(val)
    return None if f is None else round(f * 100, 1)


def norm_name(s):
    """Normalized name key for cross-feed joins (matches the app's normName)."""
    s = (s or "").lower()
    out = []
    for ch in s:
        if ch.isalpha():
            out.append(ch)
    return "".join(out)


# Per-position fantasy boom / bust thresholds (PPR points in a single game).
BOOM = {"QB": 24, "RB": 20, "WR": 20, "TE": 15}
BUST = {"QB": 12, "RB": 8, "WR": 7, "TE": 5}


def process_stats(rows):
    """Process both old player_stats and new stats_player format (same field names)."""
    players = {}
    for row in rows:
        name = row.get("player_display_name") or row.get("player_name", "")
        if not name: continue
        pos = (row.get("position") or row.get("position_group") or "?").upper()
        if pos not in POSITIONS and pos != "?": continue
        week = si(row.get("week"))
        if not week or week < 1 or week > 22: continue
        stype = row.get("season_type", "REG")
        if stype not in ("REG", "regular", "Regular Season"): continue

        if name not in players:
            players[name] = {"name": name, "pos": pos,
                             "team": row.get("recent_team") or row.get("team", ""),
                             "headshot": row.get("headshot_url", ""),
                             "weeks": [], "_acc": defaultdict(float), "_g": 0}
        p = players[name]
        if row.get("recent_team") or row.get("team"): p["team"] = row.get("recent_team") or row.get("team","")
        if pos != "?": p["pos"] = pos

        pts = sf(row.get("fantasy_points_ppr") or row.get("fantasy_points"), 0)
        pts_std = sf(row.get("fantasy_points"), 0)
        wk = {"wk": week, "pts": round(pts, 1)}

        if pos == "QB":
            # NOTE: the new stats_player release renamed several columns vs the
            # old player_stats feed: passing_interceptions, sacks_suffered.
            wk.update({"cmp": si(row.get("completions")), "att": si(row.get("attempts")),
                       "pyds": si(row.get("passing_yards")), "ptds": si(row.get("passing_tds")),
                       "ints": si(row.get("passing_interceptions") or row.get("interceptions")),
                       "ryds": si(row.get("rushing_yards")),
                       "car": si(row.get("carries")), "rtds": si(row.get("rushing_tds")),
                       "sck": si(row.get("sacks_suffered") or row.get("sacks")),
                       "pfd": si(row.get("passing_first_downs")), "pacr": sf(row.get("pacr")),
                       "pepa": sf(row.get("passing_epa")), "repa": sf(row.get("rushing_epa"))})
            for k, f in [("pyds", "passing_yards"), ("ptds", "passing_tds"),
                         ("ints", "passing_interceptions"), ("ryds", "rushing_yards"),
                         ("rtds", "rushing_tds"), ("car", "carries"), ("att", "attempts"),
                         ("cmp", "completions"), ("sck", "sacks_suffered"),
                         ("pfd", "passing_first_downs"), ("p2p", "passing_2pt_conversions")]:
                p["_acc"][k] += sf(row.get(f), 0)
            # old-feed fallbacks (1999-2024 archives may use legacy names)
            if not row.get("passing_interceptions") and row.get("interceptions"):
                p["_acc"]["ints"] += sf(row.get("interceptions"), 0)
            if not row.get("sacks_suffered") and row.get("sacks"):
                p["_acc"]["sck"] += sf(row.get("sacks"), 0)
            p["_acc"]["pepa"] += sf(row.get("passing_epa"), 0)
            p["_acc"]["repa"] += sf(row.get("rushing_epa"), 0)
        elif pos == "RB":
            wk.update({"car": si(row.get("carries")), "ryds": si(row.get("rushing_yards")),
                       "rtds": si(row.get("rushing_tds")), "tgt": si(row.get("targets")),
                       "rec": si(row.get("receptions")), "recyds": si(row.get("receiving_yards")),
                       "rectds": si(row.get("receiving_tds")), "ts": pct(row.get("target_share")),
                       "yac": si(row.get("receiving_yards_after_catch")),
                       "rfd": si(row.get("rushing_first_downs")),
                       "recfd": si(row.get("receiving_first_downs")),
                       "recepa": sf(row.get("receiving_epa")), "repa": sf(row.get("rushing_epa"))})
            for k, f in [("car", "carries"), ("ryds", "rushing_yards"), ("rtds", "rushing_tds"),
                         ("tgt", "targets"), ("rec", "receptions"), ("recyds", "receiving_yards"),
                         ("rectds", "receiving_tds"), ("yac", "receiving_yards_after_catch"),
                         ("rfd", "rushing_first_downs"), ("recfd", "receiving_first_downs"),
                         ("recays", "receiving_air_yards")]:
                p["_acc"][k] += sf(row.get(f), 0)
            p["_acc"]["repa"] += sf(row.get("rushing_epa"), 0)
            p["_acc"]["recepa"] += sf(row.get("receiving_epa"), 0)
        else:
            wk.update({"tgt": si(row.get("targets")), "rec": si(row.get("receptions")),
                       "recyds": si(row.get("receiving_yards")), "rectds": si(row.get("receiving_tds")),
                       "ts": pct(row.get("target_share")), "ays": pct(row.get("air_yards_share")),
                       "wopr": sf(row.get("wopr")), "racr": sf(row.get("racr")),
                       "yac": si(row.get("receiving_yards_after_catch")),
                       "recfd": si(row.get("receiving_first_downs")),
                       "recepa": sf(row.get("receiving_epa"))})
            for k, f in [("tgt", "targets"), ("rec", "receptions"), ("recyds", "receiving_yards"),
                         ("rectds", "receiving_tds"), ("yac", "receiving_yards_after_catch"),
                         ("recfd", "receiving_first_downs"), ("recays", "receiving_air_yards")]:
                p["_acc"][k] += sf(row.get(f), 0)
            p["_acc"]["recepa"] += sf(row.get("receiving_epa"), 0)

        p["_acc"]["pts"] += pts
        p["_acc"]["pts_std"] += pts_std
        p["_acc"]["games"] += 1
        p["weeks"].append(wk)
        p["_g"] += 1

    result = {}
    for name, p in players.items():
        if not p["_g"]: continue
        g = p["_g"]; acc = p["_acc"]; pos = p["pos"]
        # boom / bust consistency from real weekly points
        boom = sum(1 for w in p["weeks"] if (w.get("pts") or 0) >= BOOM.get(pos, 99))
        bust = sum(1 for w in p["weeks"] if (w.get("pts") or 0) <= BUST.get(pos, -1))
        ssn = {"games": g, "avg_pts": round(acc["pts"]/g, 2), "total_pts": round(acc["pts"], 1),
               "total_pts_std": round(acc["pts_std"], 1), "avg_pts_std": round(acc["pts_std"]/g, 2),
               "boom_pct": round(boom/g*100, 1), "bust_pct": round(bust/g*100, 1)}
        if pos == "QB":
            ssn.update({"avg_pyds": round(acc.get("pyds",0)/g,1), "avg_ptds": round(acc.get("ptds",0)/g,2),
                        "total_ints": int(acc.get("ints",0)), "avg_ryds": round(acc.get("ryds",0)/g,1),
                        "avg_pepa": round(acc.get("pepa",0)/g,3), "total_sacks": int(acc.get("sck",0)),
                        "total_pfd": int(acc.get("pfd",0)), "total_p2p": int(acc.get("p2p",0)),
                        "total_rtds": int(acc.get("rtds",0))})
            _avg_rate(ssn, p, [("avg_pacr", "pacr", 3)])
        elif pos == "RB":
            ssn.update({"avg_car": round(acc.get("car",0)/g,1), "avg_ryds": round(acc.get("ryds",0)/g,1),
                        "avg_tgt": round(acc.get("tgt",0)/g,1), "total_yac": int(acc.get("yac",0)),
                        "total_rfd": int(acc.get("rfd",0)), "total_recfd": int(acc.get("recfd",0)),
                        "avg_recepa": round(acc.get("recepa",0)/g,3),
                        "avg_repa": round(acc.get("repa",0)/g,3)})
            _avg_rate(ssn, p, [("avg_ts", "ts", 1)])
        else:
            ssn.update({"avg_tgt": round(acc.get("tgt",0)/g,1), "avg_rec": round(acc.get("rec",0)/g,1),
                        "avg_recyds": round(acc.get("recyds",0)/g,1), "total_yac": int(acc.get("yac",0)),
                        "total_recfd": int(acc.get("recfd",0)),
                        "avg_recepa": round(acc.get("recepa",0)/g,3)})
            for key, field, dec in [("avg_ts", "ts", 1), ("avg_wopr", "wopr", 3), ("avg_racr", "racr", 3)]:
                _avg_rate(ssn, p, [(key, field, dec)])
        sw = sorted(p["weeks"], key=lambda w: w["wk"])
        l4 = sw[-4:] if len(sw) >= 4 else sw
        l4avg = round(sum(w["pts"] for w in l4)/len(l4), 2) if l4 else 0
        result[name] = {"name": name, "pos": pos, "team": p["team"], "headshot": p["headshot"],
                        "l4w_avg": l4avg, "season": ssn, "weeks": sw}
    print(f"    -> {len(result)} players processed")
    return result


def _avg_rate(ssn, p, specs):
    for key, field, dec in specs:
        vals = [w.get(field) for w in p["weeks"] if w.get(field) is not None]
        if vals:
            ssn[key] = round(sum(vals)/len(vals), dec)


# ── Next Gen Stats ─────────────────────────────────────────────────────────
# Season-summary rows live under week == 0. Keyed by normalized player name so
# the front-end can join exactly like the age feed.
NGS_FIELDS = {
    "passing": [
        ("cpoe", "completion_percentage_above_expectation"),
        ("ttt", "avg_time_to_throw"),
        ("aggr", "aggressiveness"),
        ("ayts", "avg_air_yards_to_sticks"),
        ("iay", "avg_intended_air_yards"),
    ],
    "receiving": [
        ("sep", "avg_separation"),
        ("cush", "avg_cushion"),
        ("xyac", "avg_yac_above_expectation"),
        ("catch", "catch_percentage"),
        ("tays", "percent_share_of_intended_air_yards"),
    ],
    "rushing": [
        ("ryoe", "rush_yards_over_expected"),
        ("ryoe_att", "rush_yards_over_expected_per_att"),
        ("reff", "efficiency"),
        ("box8", "percent_attempts_gte_eight_defenders"),
    ],
}


def process_ngs(kind, rows):
    out = {}
    specs = NGS_FIELDS[kind]
    for row in rows:
        if si(row.get("week"), -1) != 0:  # 0 == season summary
            continue
        if row.get("season_type", "REG") not in ("REG", "regular"):
            continue
        name = row.get("player_display_name") or row.get("player_name") or ""
        if not name: continue
        key = norm_name(name)
        if not key: continue
        rec = out.setdefault(key, {})
        for short, field in specs:
            v = sf(row.get(field))
            if v is not None:
                rec[short] = round(v, 3)
    return out


def merge_ngs(target, src):
    for key, rec in src.items():
        target.setdefault(key, {}).update(rec)


def fetch_ngs(season):
    """Return {normName: {…ngs fields}} for a season, or {} if unavailable."""
    if season < NGS_FIRST_YEAR:
        return {}
    merged = {}
    for kind in ("passing", "rushing", "receiving"):
        rows = try_fetch_csv_gz(f"{NGS_BASE}/ngs_{season}_{kind}.csv.gz", f"ngs_{season}_{kind}")
        if rows:
            merge_ngs(merged, process_ngs(kind, rows))
    return merged


# ── PFR advanced stats ─────────────────────────────────────────────────────
# PFR ships WEEKLY rows (no season-summary row), so we aggregate to a season
# summary: weighted averages for rates (drop %, pressure %, YBC/A, YAC/A) and
# totals for counting stats (broken tackles, hurries, etc.). Reliably published
# for 2024 + 2025 — the gap NGS currently has.
PFR_PASS_SUM = ("times_sacked", "times_blitzed", "times_hurried", "times_hit",
                "times_pressured", "passing_bad_throws", "passing_drops")
PFR_REC_SUM = ("receiving_drop", "receiving_broken_tackles", "receiving_int")
PFR_RUSH_SUM = ("carries", "rushing_yards_before_contact",
                "rushing_yards_after_contact", "rushing_broken_tackles")


def _accum(d, key, val):
    f = sf(val); d[key] = d.get(key, 0) + (f if f is not None else 0)


def process_pfr(kind, rows):
    """Aggregate weekly PFR rows by player → season summary."""
    by = {}
    for row in rows:
        if row.get("game_type", "REG") not in ("REG", "regular"):
            continue
        name = row.get("pfr_player_name") or ""
        if not name: continue
        rec = by.setdefault(norm_name(name), {"_g": 0})
        rec["_g"] += 1
        if kind == "pass":
            for f in PFR_PASS_SUM: _accum(rec, f, row.get(f))
        elif kind == "rec":
            for f in PFR_REC_SUM: _accum(rec, f, row.get(f))
            # receiving_rat is already a rate; average it across games
            r = sf(row.get("receiving_rat"))
            if r is not None:
                rec.setdefault("_rat", []).append(r)
        elif kind == "rush":
            for f in PFR_RUSH_SUM: _accum(rec, f, row.get(f))
    out = {}
    for k, rec in by.items():
        g = rec.get("_g", 0)
        if not g: continue
        slot = {}
        if kind == "pass":
            # carry totals + derived per-game / rate fields
            sk = rec.get("times_sacked", 0); pr = rec.get("times_pressured", 0)
            hu = rec.get("times_hurried", 0); ht = rec.get("times_hit", 0)
            bz = rec.get("times_blitzed", 0); bt = rec.get("passing_bad_throws", 0)
            # PFR pressure/bad-throw % are fractions in the CSV (e.g. 0.18 = 18%).
            # We store as a real percentage so the front-end renders 18.0%.
            slot["press_pct"] = round(pr / max(bz, 1) * 100, 1)
            slot["bt_pct_g"] = round(bt / g, 1)
            slot["hur_g"] = round(hu / g, 1)
            slot["hit_g"] = round(ht / g, 1)
            slot["sk_g"] = round(sk / g, 2)
        elif kind == "rec":
            dr = rec.get("receiving_drop", 0); brk = rec.get("receiving_broken_tackles", 0)
            slot["drops"] = int(dr)
            slot["bktk"] = int(brk)
            rats = rec.get("_rat") or []
            if rats:
                slot["rec_rat"] = round(sum(rats) / len(rats), 1)
        elif kind == "rush":
            car = rec.get("carries", 0)
            ybc = rec.get("rushing_yards_before_contact", 0)
            yac_r = rec.get("rushing_yards_after_contact", 0)
            brk = rec.get("rushing_broken_tackles", 0)
            slot["ybca"] = round(ybc / car, 2) if car else None
            slot["yaca"] = round(yac_r / car, 2) if car else None
            slot["rbktk"] = int(brk)
        for f, v in slot.items():
            if v is not None: out.setdefault(k, {})[f] = v
    return out


def fetch_pfr(season):
    """Return {normName: {…pfr fields}} for a season, merged across pass/rec/rush."""
    if season < PFR_FIRST_YEAR:
        return {}
    merged = {}
    for kind in ("pass", "rec", "rush"):
        rows = try_fetch_csv_gz(f"{PFR_BASE}/advstats_week_{kind}_{season}.csv.gz",
                                f"pfr_{season}_{kind}")
        if rows:
            for k, rec in process_pfr(kind, rows).items():
                merged.setdefault(k, {}).update(rec)
    return merged


def process_snaps(rows):
    players = {}
    for row in rows:
        name = (row.get("player") or "").strip()
        if not name: continue
        pos = (row.get("position") or "?").upper()
        if pos not in POSITIONS and pos != "?": continue
        week = si(row.get("week"))
        if week is None: continue
        off = sf(row.get("offense_pct"))
        if off is None: continue
        if name not in players: players[name] = {"weeks":[], "_off":[]}
        players[name]["weeks"].append({"wk":week,"off":round(off*100,1)})
        players[name]["_off"].append(off)
    out = {}
    for n, p in players.items():
        offs = p["_off"]
        sw = sorted(p["weeks"], key=lambda w: w["wk"])
        avg = round(sum(offs)/len(offs)*100, 1) if offs else None
        l4 = [w["off"] for w in sw[-4:]]
        trend = round(sum(l4)/len(l4) - (avg or 0), 1) if l4 and avg is not None else None
        out[n] = {"avg_off": avg, "trend": trend, "weeks": sw}
    return out


def process_injuries(rows):
    players = {}
    for row in rows:
        name = (row.get("full_name") or row.get("player_name") or "").strip()
        if not name: continue
        week = si(row.get("week"), 0)
        ex = players.get(name, {})
        if week >= ex.get("_wk", 0):
            players[name] = {"_wk":week,"status":row.get("report_status") or "",
                             "designation":row.get("report_primary_injury") or ""}
    return {n:{k:v for k,v in d.items() if not k.startswith("_")} for n,d in players.items()}


def run_season(season, with_injuries=False):
    stats, snaps, inj, ngs = {}, {}, {}, {}
    # Try new stats_player release first, then fall back to old player_stats release
    for url, label in [
        (f"{STATS_BASE}/stats_player_week_{season}.csv", f"stats_player_week_{season} (new)"),
        (f"{OLD_BASE}/player_stats/player_stats_{season}.csv", f"player_stats_{season} (old)"),
    ]:
        try:
            rows = fetch_csv(url, label)
            if rows:
                stats = process_stats(rows)
                break
        except Exception as e:
            print(f"  WARN stats {season}: {e}")

    snaps = process_snaps(try_fetch_csv(f"{OLD_BASE}/snap_counts/snap_counts_{season}.csv",
                                        f"snap_counts_{season}"))
    # NGS + PFR live in the same "advanced tracking" file. NGS is the deep
    # 2016-2023 record; PFR fills the 2024+ gap with pressure / contact /
    # broken-tackle data nflverse currently hasn't republished for NGS.
    ngs = fetch_ngs(season)
    pfr = fetch_pfr(season)
    for k, rec in pfr.items():
        ngs.setdefault(k, {}).update(rec)

    if with_injuries:
        inj = process_injuries(try_fetch_csv(f"{OLD_BASE}/injuries/injuries_{season}.csv",
                                             f"injuries_{season}"))

    return stats, snaps, inj, ngs


def write(data, filename):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w") as f: json.dump(data, f, separators=(",",":"))
    print(f"  {filename}  ({os.path.getsize(path)//1024}KB,  {len(data)} entries)")


def main():
    global CURRENT_SEASON, ARCHIVE_SEASON
    now = datetime.now(timezone.utc).isoformat()
    print(f"\n=== Vault nflverse pipeline  {now[:10]} ===")

    detected, stype, disp_week = detect_season()

    # Build the detected season first. If it has no regular-season data yet
    # (offseason / preseason), fall back to the previous season as "current".
    print(f"\n--- Detected season {detected} ({stype}) ---")
    det_stats, det_snaps, det_inj, det_ngs = run_season(detected, with_injuries=True)
    det_has_data = len(det_stats) > 0

    if det_has_data:
        CURRENT_SEASON = detected
        cur_stats, cur_snaps, cur_inj, cur_ngs = det_stats, det_snaps, det_inj, det_ngs
        data_through_week = disp_week
    else:
        CURRENT_SEASON = detected - 1
        print(f"\n  No {detected} data yet -> current season falls back to {CURRENT_SEASON}")
        print(f"\n--- Season {CURRENT_SEASON} (current, fallback) ---")
        cur_stats, cur_snaps, cur_inj, cur_ngs = run_season(CURRENT_SEASON, with_injuries=True)
        data_through_week = 0  # detected season hasn't started

    ARCHIVE_SEASON = CURRENT_SEASON - 1

    # Build the rest of the archive depth (current-1, current-2, …).
    archive_years = [CURRENT_SEASON]
    archives = {}
    for yr in range(CURRENT_SEASON - 1, CURRENT_SEASON - ARCHIVE_DEPTH, -1):
        print(f"\n--- Season {yr} (archive) ---")
        a_stats, a_snaps, _a_inj, a_ngs = run_season(yr)
        archives[yr] = (a_stats, a_snaps, a_ngs)
        archive_years.append(yr)

    print("\n--- Writing files ---")
    # Current season: generic + per-year names (the UI reads nflverse_stats.json
    # for "current" and nflverse_stats_<year>.json for archives).
    write(cur_stats, "nflverse_stats.json")
    write(cur_snaps, "nflverse_snaps.json")
    write(cur_inj,   "nflverse_injuries.json")
    write(cur_ngs,   "nflverse_ngs.json")
    write(cur_stats, f"nflverse_stats_{CURRENT_SEASON}.json")
    write(cur_snaps, f"nflverse_snaps_{CURRENT_SEASON}.json")
    write(cur_ngs,   f"nflverse_ngs_{CURRENT_SEASON}.json")
    for yr, (a_stats, a_snaps, a_ngs) in archives.items():
        write(a_stats, f"nflverse_stats_{yr}.json")
        write(a_snaps, f"nflverse_snaps_{yr}.json")
        write(a_ngs,   f"nflverse_ngs_{yr}.json")

    arc_player_count = len(archives.get(ARCHIVE_SEASON, ({},))[0])
    meta = {"updated_at": now,
            "current_season": CURRENT_SEASON,
            "season": CURRENT_SEASON,
            "detected_season": detected,
            "season_type": stype,
            "latest_complete_season": CURRENT_SEASON,
            "archive_season": ARCHIVE_SEASON,
            "archive_years": archive_years,
            "data_through_week": data_through_week,
            "ngs_available": bool(cur_ngs),
            "player_count": len(cur_stats),
            "snap_count": len(cur_snaps),
            "archive_player_count": arc_player_count}
    with open(os.path.join(OUTPUT_DIR, "nflverse_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  nflverse_meta.json")
    print(f"\nDone  current {CURRENT_SEASON}: {len(cur_stats)} players | "
          f"archive {ARCHIVE_SEASON}: {arc_player_count} players | "
          f"ngs: {len(cur_ngs)} | detected {detected}/{stype}")


if __name__ == "__main__":
    main()
