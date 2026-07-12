#!/usr/bin/env python3
"""
Build REAL dynasty ADP from aggregated Sleeper startup drafts.

Unlike scripts/build_adp_data.py (which reads FantasyCalc *trade values* as an
ADP proxy), this script aggregates *actual draft picks* from real Sleeper
dynasty leagues — the same methodology the big "X million picks from Y real
dynasty drafts" sites use.

HOW IT WORKS
------------
Sleeper's HTTP API is public + read-only + keyless, but there is NO
"list all drafts" endpoint. So we discover drafts by crawling the league graph:

  1. Seed from a user_id (yours).
  2. GET /user/<uid>/leagues/nfl/<season>  -> that user's leagues
  3. Keep dynasty leagues (settings.type == 2).
  4. GET /league/<lid>/users + /rosters     -> new owner user_ids (crawl fuel)
     GET /league/<lid>/drafts               -> draft ids
     GET /draft/<did>/picks                 -> every pick (+ picked_by = more uids)
  5. Persist a checkpoint so each cron run CONTINUES the snowball instead of
     restarting — that accretion is how the corpus grows to tens of thousands.

Each pick carries metadata (name/pos/team/years_exp), so we never need the
5MB /players/nfl file.

OUTPUTS (data/)
---------------
  sleeper_crawl_state.json    frontier + seen-sets (bookkeeping, grows slowly)
  sleeper_adp_corpus.json     the growing DB: per-draft compact picks, pruned
                              to a recency window so ADP stays fresh
  adp_sleeper_dynasty_1qb.json / _sf.json   served ADP (schema mirrors adp_*.json)
  sleeper_adp_history_1qb.json / _sf.json   daily ADP snapshots -> movers

Each run does a BOUNDED chunk of crawling (user + draft budgets) and always
saves progress, so it is safe to run on a short-timeout GitHub Action.

USAGE
  python3 scripts/build_sleeper_adp.py                 # one bounded crawl step + rebuild outputs
  python3 scripts/build_sleeper_adp.py --seed 972151901896687616
  python3 scripts/build_sleeper_adp.py --user-budget 50 --draft-budget 80   # tiny (smoke test)
  python3 scripts/build_sleeper_adp.py --rebuild-only  # recompute outputs from corpus, no crawling
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.request
import urllib.error

API = "https://api.sleeper.app/v1"
USER_AGENT = "Vault-Fantasy/1.0 (+https://putput12-jp.github.io/Vault-Fantasy)"

# ---- seed / crawl config -------------------------------------------------
DEFAULT_SEED = "972151901896687616"          # Sleeper user "Putput"
SEASONS = ["2024", "2025", "2026"]            # seasons to look for startups in
DYNASTY_TYPE = 2                              # league.settings.type: 0 redraft,1 keeper,2 dynasty
REDRAFT_TYPE = 0

# startup vs rookie split on draft rounds (no explicit Sleeper flag exists)
STARTUP_MIN_ROUNDS = 12                       # >= this = startup (fills full rosters)
ROOKIE_MAX_ROUNDS = 7                         # <= this = rookie draft (excluded here)

# which team sizes to pool, and the size we normalize pick numbers to
TEAMS_MIN, TEAMS_MAX = 8, 16
NORM_TEAMS = 12                               # pick_no normalized to a 12-team board

WINDOW_DAYS = 210                             # drop drafts older than this (freshness)
MIN_SAMPLES = 3                               # a player needs >= N drafts to get an ADP
HISTORY_MAX = 160                             # snapshots kept per player in history file

# per-run budgets (keep a cron run comfortably inside a few minutes)
DEF_USER_BUDGET = 400                         # frontier users processed per run
DEF_DRAFT_BUDGET = 400                        # new drafts pulled per run, PER MODE (dyn/rdr)
MAX_RUN_SECONDS = 1200                         # wall-clock cap so a cron run always finishes
REQ_MIN_INTERVAL = 0.08                       # ~750 req/min ceiling (Sleeper asks < 1000)

DATA_DIR = "data"
STATE_FILE = "sleeper_crawl_state.json"
CORPUS_FILE = "sleeper_adp_corpus.json"

# ---- tiny rate-limited HTTP client --------------------------------------
_last_req = [0.0]

def _get(path, tries=4):
    """GET <API>/<path> -> parsed JSON, or None on 404/empty. Retries on 429/5xx."""
    url = f"{API}/{path}"
    for attempt in range(tries):
        wait = REQ_MIN_INTERVAL - (time.time() - _last_req[0])
        if wait > 0:
            time.sleep(wait)
        _last_req[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8")
                if not raw or raw == "null":
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1))
                continue
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(1.0 * (attempt + 1))
        except json.JSONDecodeError:
            return None
    return None


# ---- state / corpus persistence -----------------------------------------
def _load(path, default):
    p = os.path.join(DATA_DIR, path)
    if os.path.exists(p):
        try:
            with open(p, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return default

def _save(path, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    p = os.path.join(DATA_DIR, path)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, p)


def new_state(seed):
    return {
        "version": 1,
        "seed": seed,
        "frontier": [seed],       # user_ids queued to process
        "seen_users": [seed],     # user_ids already processed (BFS visited)
        "seen_leagues": [],       # league_ids already classified
        "dynasty_leagues": [],    # dynasty league_ids discovered
        "redraft_leagues": [],    # redraft league_ids discovered
        "processed_drafts": [],   # draft_ids already pulled
        "last_run": None,
        "stats": {},
    }


# ---- classification helpers ---------------------------------------------
def league_is_dynasty(lg):
    return (lg.get("settings") or {}).get("type") == DYNASTY_TYPE

def league_mode(lg):
    """'dyn' for dynasty leagues, 'rdr' for redraft, None for keeper/other (skipped)."""
    t = (lg.get("settings") or {}).get("type")
    if t == DYNASTY_TYPE:
        return 'dyn'
    if t == REDRAFT_TYPE:
        return 'rdr'
    return None

def league_format(lg):
    """'sf' if the league starts 2 QBs (superflex), else '1qb'."""
    rp = lg.get("roster_positions") or []
    if "SUPER_FLEX" in rp:
        return "sf"
    if rp.count("QB") >= 2:
        return "sf"
    return "1qb"

def draft_ts(d):
    """Best-effort epoch ms for a draft (start_time, else created, else 0)."""
    for k in ("start_time", "last_picked", "created"):
        v = d.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return int(v)
    return 0


# ---- the crawl step ------------------------------------------------------
def crawl(state, corpus, user_budget, draft_budget, log):
    frontier = state["frontier"]
    seen_users = set(state["seen_users"])
    seen_leagues = set(state["seen_leagues"])
    dynasty_leagues = set(state["dynasty_leagues"])
    redraft_leagues = set(state.get("redraft_leagues", []))
    processed_drafts = set(state["processed_drafts"])
    drafts = corpus["drafts"]
    players = corpus["players"]

    users_done = 0
    done = {"dyn": 0, "rdr": 0}   # per-mode draft budgets — dynasty can't starve redraft
    new_dyn = 0
    new_rdr = 0
    t0 = time.time()

    # Always re-scan the seed first so the anchor account's own current drafts —
    # including this season's redraft startups — get ingested every run.
    seed = state.get("seed")
    if seed:
        seen_users.discard(seed)
        if seed in frontier:
            frontier.remove(seed)
        frontier.insert(0, seed)

    def push_user(uid):
        if uid and uid not in seen_users and uid not in frontier:
            frontier.append(uid)

    def ingest_draft(did, lg_format, mode):
        """Pull one completed startup draft's picks into the corpus (mode: 'dyn'|'rdr')."""
        if did in processed_drafts or did in drafts:
            return
        d = _get(f"draft/{did}")
        if not d:
            processed_drafts.add(did)
            return
        if d.get("status") != "complete":
            return  # revisit later once it completes (don't mark processed)
        rounds = (d.get("settings") or {}).get("rounds") or 0
        teams = (d.get("settings") or {}).get("teams") or 0
        if rounds < STARTUP_MIN_ROUNDS:
            processed_drafts.add(did)       # rookie / partial draft — skip, done
            return
        if not (TEAMS_MIN <= teams <= TEAMS_MAX):
            processed_drafts.add(did)
            return
        picks = _get(f"draft/{did}/picks") or []
        done[mode] += 1
        pmap = {}
        for pk in picks:
            pid = pk.get("player_id")
            pno = pk.get("pick_no")
            if not pid or not pno:
                continue
            pmap[pid] = pno
            md = pk.get("metadata") or {}
            if pid not in players and (md.get("last_name") or md.get("first_name")):
                players[pid] = {
                    "n": (f"{md.get('first_name','')} {md.get('last_name','')}").strip(),
                    "pos": md.get("position") or "",
                    "tm": md.get("team") or "",
                    "exp": md.get("years_exp") or "",
                }
            pu = pk.get("picked_by")
            if pu:
                push_user(pu)               # every pick is more crawl fuel
        drafts[did] = {"s": d.get("season"), "ts": draft_ts(d),
                       "t": teams, "f": lg_format, "m": mode, "p": pmap}
        processed_drafts.add(did)

    while frontier and users_done < user_budget:
        if time.time() - t0 > MAX_RUN_SECONDS:
            break
        uid = frontier.pop(0)
        seen_users.add(uid)
        users_done += 1
        for season in SEASONS:
            leagues = _get(f"user/{uid}/leagues/nfl/{season}")
            if not leagues:
                continue
            for lg in leagues:
                lid = lg.get("league_id")
                if not lid:
                    continue
                mode = league_mode(lg)   # 'dyn' | 'rdr' | None (skip keeper/other)
                if lid not in seen_leagues:
                    seen_leagues.add(lid)
                    if mode == 'dyn':
                        dynasty_leagues.add(lid); new_dyn += 1
                    elif mode == 'rdr':
                        redraft_leagues.add(lid); new_rdr += 1
                if mode is None:
                    continue
                fmt = league_format(lg)
                # harvest leaguemates from rosters (owner_ids) — fuel for the snowball
                for rs in (_get(f"league/{lid}/rosters") or []):
                    push_user(rs.get("owner_id"))
                # pull this league's completed startup drafts (per-mode budget)
                if done[mode] < draft_budget:
                    for d in (_get(f"league/{lid}/drafts") or []):
                        if done[mode] >= draft_budget:
                            break
                        ingest_draft(d.get("draft_id"), fmt, mode)
        # stop only when BOTH modes are satisfied — never let abundant dynasty
        # drafts end the run before redraft leagues have been harvested
        if done["dyn"] >= draft_budget and done["rdr"] >= draft_budget:
            break

    state["frontier"] = frontier
    state["seen_users"] = sorted(seen_users)
    state["seen_leagues"] = sorted(seen_leagues)
    state["dynasty_leagues"] = sorted(dynasty_leagues)
    state["redraft_leagues"] = sorted(redraft_leagues)
    state["processed_drafts"] = sorted(processed_drafts)
    log(f"crawl: +{users_done} users, +{done['dyn']} dyn / +{done['rdr']} rdr drafts, "
        f"+{new_dyn} dynasty / +{new_rdr} redraft leagues | frontier={len(frontier)} corpus_drafts={len(drafts)}")


# ---- corpus -> ADP outputs ----------------------------------------------
def prune_corpus(corpus, log):
    cutoff = (time.time() - WINDOW_DAYS * 86400) * 1000
    drafts = corpus["drafts"]
    before = len(drafts)
    for did in list(drafts):
        ts = drafts[did].get("ts") or 0
        if ts and ts < cutoff:
            del drafts[did]
    if before != len(drafts):
        log(f"prune: dropped {before - len(drafts)} drafts older than {WINDOW_DAYS}d")

def _norm_pick(pick_no, teams):
    """Scale an overall pick number to a NORM_TEAMS-team board so 10/12/14-team pool cleanly."""
    if not teams:
        return pick_no
    return (pick_no - 1) * (NORM_TEAMS / teams) + 1

def compute_adp(corpus, mode, fmt):
    """Aggregate one mode+format's startup picks -> sorted player list. mode: 'dyn'|'rdr'."""
    players = corpus["players"]
    samples = {}   # player_id -> [normalized_pick, ...]
    ndrafts = 0
    for d in corpus["drafts"].values():
        if d.get("m", "dyn") != mode or d.get("f") != fmt:   # legacy drafts default to 'dyn'
            continue
        teams = d.get("t") or NORM_TEAMS
        ndrafts += 1
        for pid, pno in d.get("p", {}).items():
            samples.setdefault(pid, []).append(_norm_pick(pno, teams))
    rows = []
    for pid, arr in samples.items():
        n = len(arr)
        if n < MIN_SAMPLES:
            continue
        arr.sort()
        mean = sum(arr) / n
        var = sum((x - mean) ** 2 for x in arr) / n
        meta = players.get(pid, {})
        rows.append({
            "name": meta.get("n") or pid,
            "pos": meta.get("pos") or "",
            "team": meta.get("tm") or "",
            "sleeperId": pid,
            "years_exp": meta.get("exp") or "",
            "adp": round(mean, 1),               # normalized overall pick (12-team)
            "adpRound": round(mean / NORM_TEAMS + 0.5, 1),
            "n": n,
            "stdev": round(var ** 0.5, 1),
            "hi": round(arr[0], 1),
            "lo": round(arr[-1], 1),
        })
    rows.sort(key=lambda r: r["adp"])
    poscount = {}
    for i, r in enumerate(rows, 1):
        r["rank"] = i
        poscount[r["pos"]] = poscount.get(r["pos"], 0) + 1
        r["positionRank"] = poscount[r["pos"]]
    return rows, ndrafts

def update_history(fmt, rows, log):
    """Append today's ADP snapshot per player; compute 14-day delta onto rows."""
    hist = _load(f"sleeper_adp_history_{fmt}.json", {"dates": [], "adp": {}})
    today = dt.date.today().isoformat()
    if today not in hist["dates"]:
        hist["dates"].append(today)
        hist["dates"] = hist["dates"][-HISTORY_MAX:]
    di = len(hist["dates"]) - 1
    for r in rows:
        series = hist["adp"].setdefault(r["sleeperId"], {})
        series[today] = r["adp"]
    # trim each series to kept dates
    keep = set(hist["dates"])
    for pid in list(hist["adp"]):
        hist["adp"][pid] = {d: v for d, v in hist["adp"][pid].items() if d in keep}
        if not hist["adp"][pid]:
            del hist["adp"][pid]
    # 14-day delta (positive = ADP got later = falling; negative = rising)
    ref_date = None
    cutoff = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    for d in hist["dates"]:
        if d <= cutoff:
            ref_date = d
    for r in rows:
        prev = hist["adp"].get(r["sleeperId"], {}).get(ref_date) if ref_date else None
        r["adpDelta14"] = round(r["adp"] - prev, 1) if prev is not None else None
    _save(f"sleeper_adp_history_{fmt}.json", hist)
    return hist

# (mode, fmt) -> (output bucket name, source noun, human label)
BUCKETS = [
    ("dyn", "1qb", "dynasty_1qb", "dynasty startup",  "Dynasty Startup (1QB)"),
    ("dyn", "sf",  "dynasty_sf",  "dynasty startup",  "Dynasty Startup (Superflex)"),
    ("rdr", "1qb", "redraft_1qb", "redraft",          "Redraft (1QB)"),
    ("rdr", "sf",  "redraft_sf",  "redraft",          "Redraft (Superflex)"),
]

def write_outputs(corpus, log):
    for mode, fmt, bucket, noun, label in BUCKETS:
        rows, ndrafts = compute_adp(corpus, mode, fmt)
        update_history(bucket, rows, log)
        out = {
            "format": f"sleeper_{bucket}",
            "format_label": label,
            "norm_teams": NORM_TEAMS,
            "source": f"aggregated real Sleeper {noun} drafts",
            "drafts": ndrafts,
            "total_drafts_corpus": len(corpus["drafts"]),
            "count": len(rows),
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "players": rows,
        }
        _save(f"adp_sleeper_{bucket}.json", out)
        log(f"output {bucket}: {len(rows)} players from {ndrafts} drafts")


def write_stats(corpus, state, log):
    """Small public stats file for the ADP Explorer's provenance strip + funnel.
    Numbers describe the LIVE ADP pool (current window) and the crawl connectivity."""
    drafts = corpus["drafts"]
    by_mode = {}
    picks = 0
    for d in drafts.values():
        m = d.get("m", "dyn")
        by_mode[m] = by_mode.get(m, 0) + 1
        picks += len(d.get("p", {}))
    stats = {
        "picks": picks,
        "drafts": len(drafts),
        "drafts_by_mode": by_mode,
        "players": len(corpus["players"]),
        "users_crawled": len(state.get("seen_users", [])),
        "frontier": len(state.get("frontier", [])),
        "leagues": {
            "dynasty": len(state.get("dynasty_leagues", [])),
            "redraft": len(state.get("redraft_leagues", [])),
            "total": len(state.get("dynasty_leagues", [])) + len(state.get("redraft_leagues", [])),
        },
        "window_days": WINDOW_DAYS,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _save("sleeper_adp_stats.json", stats)
    log(f"stats: {picks} picks / {len(drafts)} drafts / {stats['users_crawled']} users / {stats['leagues']['total']} leagues")


# ---- main ---------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default=DEFAULT_SEED, help="Sleeper user_id to seed the crawl")
    ap.add_argument("--user-budget", type=int, default=DEF_USER_BUDGET)
    ap.add_argument("--draft-budget", type=int, default=DEF_DRAFT_BUDGET)
    ap.add_argument("--rebuild-only", action="store_true",
                    help="recompute outputs from the existing corpus, no crawling")
    args = ap.parse_args()

    def log(m):
        print(f"[sleeper-adp] {m}", flush=True)

    state = _load(STATE_FILE, None) or new_state(args.seed)
    corpus = _load(CORPUS_FILE, None) or {"drafts": {}, "players": {}}

    if not args.rebuild_only:
        t0 = time.time()
        crawl(state, corpus, args.user_budget, args.draft_budget, log)
        prune_corpus(corpus, log)
        state["last_run"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        state["stats"] = {
            "seen_users": len(state["seen_users"]),
            "frontier": len(state["frontier"]),
            "dynasty_leagues": len(state["dynasty_leagues"]),
            "redraft_leagues": len(state.get("redraft_leagues", [])),
            "corpus_drafts": len(corpus["drafts"]),
            "run_seconds": round(time.time() - t0, 1),
        }
        _save(STATE_FILE, state)
        _save(CORPUS_FILE, corpus)
        log(f"state: {state['stats']}")

    write_outputs(corpus, log)
    write_stats(corpus, state, log)
    log("done")


if __name__ == "__main__":
    main()
