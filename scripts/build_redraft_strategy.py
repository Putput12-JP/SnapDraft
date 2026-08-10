#!/usr/bin/env python3
"""
Build REDRAFT STRATEGY data from real, completed Sleeper redraft leagues.

WHAT THIS IS
------------
scripts/build_sleeper_adp.py answers "where do players go in drafts" (ADP). This
answers the *next* question: "which draft BUILDS actually win." For every team in
a completed redraft season we reconstruct the build (Zero RB / Hero RB / Robust RB
/ Elite TE / Balanced, plus the round each position was first taken) and join it to
the season OUTCOME (regular-season win%, points-for percentile, made-playoffs,
final placement, champion). Aggregated over thousands of teams that becomes:
"Robust RB made the playoffs 54% of the time in 12-team PPR (+4 vs field)."

Same public, keyless Sleeper API + league-graph crawl the ADP script uses. The two
run independently; this one reuses the ADP crawler's banked redraft league IDs as
seed fuel and walks each league's `previous_league_id` chain back to completed
2023-2025 seasons.

DATA CHAIN (all join on roster_id within a league)
--------------------------------------------------
  GET /league/<lid>                 season, status, settings (playoff_teams,
                                     playoff_week_start), scoring_settings.rec
                                     (0 std / 0.5 half / 1 ppr), roster_positions
                                     (SF vs 1QB), previous_league_id (walk back)
  GET /league/<lid>/drafts          -> draft_id(s)
  GET /draft/<did>/picks            roster_id, draft_slot, round, is_keeper,
                                     player_id, metadata.position  -> the BUILD
  GET /league/<lid>/rosters         per roster_id: wins/losses/ties, fpts, ppts
  GET /league/<lid>/winners_bracket made-playoffs / placement / champion

OUTPUTS (data/)
---------------
  redraft_strategy_corpus.json      compact per-team records (accretes over runs)
  redraft_strategy_state.json       league frontier + ingested-set (checkpoint)
  redraft_strategy_archetypes.json  per scoring|format: archetype success rates
  redraft_strategy_position_rounds.json  first-pos-round -> playoff rate (heatmap)
  redraft_strategy_by_slot.json     playoff rate & best archetype BY draft slot
  redraft_strategy_openings.json    exact first-4-pick sequences ranked by outcome
  redraft_strategy_curves.json      count-of-position-in-first-6 -> playoff rate
  redraft_strategy_stats.json       provenance strip (teams / leagues / seasons)

USAGE
  python3 scripts/build_redraft_strategy.py                 # one bounded crawl + rebuild
  python3 scripts/build_redraft_strategy.py --league-budget 300
  python3 scripts/build_redraft_strategy.py --rebuild-only  # recompute outputs, no crawl
"""

import argparse
import datetime as dt
import gzip
import json
import math
import os
import sys
import time
import urllib.request
import urllib.error

API = "https://api.sleeper.app/v1"
USER_AGENT = "Vault-Fantasy/1.0 (+https://putput12-jp.github.io/Vault-Fantasy)"

DATA_DIR = "data"
STATE_FILE = "redraft_strategy_state.json"
CORPUS_FILE = "redraft_strategy_corpus.json.gz"   # gzipped: see _load/_save
CORPUS_FILE_LEGACY = "redraft_strategy_corpus.json"   # pre-gzip name, for one-time migration
ADP_STATE_FILE = "sleeper_crawl_state.json"      # reuse its banked redraft league ids as seed

# Reconstructed ADP: as each league's picks stream by we accumulate, per
# (season, player), a running mean of the OVERALL pick number they went at. That
# is the draft-time price a pick-value model needs (scripts/build_pick_value.py
# joins it to nflverse realized value). Compact — one row per player-season, not
# one per pick — and accretes across runs exactly like the corpus. Only leagues
# crawled AFTER this was added contribute, so it fills in going forward + from any
# manual backfill crawl. Keyed "season|player_id"; a running (n, sumov, minov)
# survives incremental runs without keeping the full pick distribution.
PICKVALS_FILE = "redraft_pick_values.json"
_PICKVALS = {}          # "sea|pid" -> {"nm","pos","n","sumov","minov"}

# ---- what we ingest ------------------------------------------------------
REDRAFT_TYPE = 0                                  # league.settings.type: 0 redraft, 1 keeper, 2 dynasty
SEASONS = {"2023", "2024", "2025"}                # completed seasons we keep
# 2025 is last season — the most relevant board to a 2026 drafter — so the crawl is
# ordered to reach it first. Sleeper league_ids are time-ordered, so seeding the
# frontier newest-first lands on 2026 leagues, whose `previous_league_id` IS the
# 2025 instance; those parents jump a priority queue so chains resolve immediately
# instead of queueing behind 14k seed ids (that ordering is why run #1 was all 2024).
SEASON_RANK = {"2025": 0, "2024": 1, "2023": 2}
OPENING_LEN = 4                                   # picks in an "opening" sequence
TEAMS_MIN, TEAMS_MAX = 8, 16
STARTUP_MIN_ROUNDS = 10                           # a real full draft (skip 3-round keeper drafts etc.)
MAX_KEEPER_FRAC = 0.15                            # skip leagues where >15% of picks are keepers
SKILL_POS = {"QB", "RB", "WR", "TE"}
MIN_ARCH_SAMPLE = 40                              # an archetype needs >= N teams to be reported
MIN_SLOT_SAMPLE = 25                              # a (slot) bucket needs >= N teams

# per-run budgets (keep a cron run inside a few minutes)
DEF_LEAGUE_BUDGET = 400                           # completed leagues ingested per run
MAX_RUN_SECONDS = 1500
FETCH_FAIL_ABORT = 25                             # consecutive fetch failures => Sleeper is down, stop
REQ_MIN_INTERVAL = 0.08                           # ~750 req/min (Sleeper asks < 1000)

ARCHETYPES = ["Robust RB", "Hero RB", "Zero RB", "WR Heavy", "Balanced"]

# ---- tiny rate-limited HTTP client --------------------------------------
_last_req = [0.0]

class FetchError(Exception):
    """A request failed after every retry — transient (rate limit / network / 5xx).

    This exists so callers can tell "Sleeper says this does not exist" (None) apart from
    "Sleeper would not answer us right now" (raise). Collapsing the two is what let a
    rate-limited winners_bracket fetch be read as "nobody made the playoffs" and write
    fabricated zero outcomes for every team in the league.
    """

def _get(path, tries=4):
    """Return the decoded body, or None when the resource genuinely is not there
    (404 / null body / unparseable). Raise FetchError if we simply never got an answer."""
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
    raise FetchError(path)

# ---- persistence ---------------------------------------------------------
# The corpus is stored GZIPPED (.json.gz): it is 200k+ repetitive records that
# nothing in the app reads (only the aggregated redraft_strategy_* outputs are
# served), and plain JSON crossed GitHub's 50MB warn toward the 100MB hard limit.
# gzip cuts it ~10x. _load/_save switch on the extension, so aggregated outputs
# stay plain JSON and human-inspectable.
def _open(p, mode):
    # _save writes atomically to a "<name>.tmp" sibling, so classify by the REAL
    # extension: ".json.gz.tmp" must still gzip. Keying on p.endswith(".gz") would
    # write the corpus as raw JSON under a .gz name, which the next run's _load
    # could not gunzip -> empty corpus (this sank the ADP + trade corpora).
    real = p[:-4] if p.endswith(".tmp") else p
    return gzip.open(p, mode) if real.endswith(".gz") else open(p, mode)

def _load(path, default):
    p = os.path.join(DATA_DIR, path)
    if os.path.exists(p):
        try:
            with _open(p, "rt") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[redraft-strategy] WARNING: could not read {path}: {e}", file=sys.stderr)
    return default

def _save(path, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    p = os.path.join(DATA_DIR, path)
    tmp = p + ".tmp"
    with _open(tmp, "wt") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, p)

def new_state():
    return {
        "version": 2,
        "chain": [],            # PRIORITY queue: previous_league_id parents (walk to 2025 fast)
        "frontier": [],         # seed league_ids, newest-first
        "seen_leagues": [],     # league_ids already visited (dedupe)
        "ingested": [],         # league_ids whose teams are in the corpus
        "last_run": None,
        "stats": {},
    }

def seed_frontier(state, log):
    """Prime the frontier from the ADP crawler's banked redraft league ids."""
    adp = _load(ADP_STATE_FILE, None)
    if not adp:
        log("seed: no ADP crawl state found — frontier stays as-is")
        return
    seen = set(state["seen_leagues"])
    frontier = state["frontier"]
    inq = set(frontier)
    added = 0
    for lid in adp.get("redraft_leagues", []):
        if lid not in seen and lid not in inq:
            frontier.append(lid)
            inq.add(lid)
            added += 1
    log(f"seed: +{added} redraft league ids from ADP crawler (frontier={len(frontier)})")

# ---- league / format helpers --------------------------------------------
def league_format(lg):
    rp = lg.get("roster_positions") or []
    if "SUPER_FLEX" in rp or rp.count("QB") >= 2:
        return "sf"
    return "1qb"

def league_scoring(lg):
    """'std' / 'half' / 'ppr' from scoring_settings.rec (points per reception)."""
    rec = ((lg.get("scoring_settings") or {}).get("rec"))
    try:
        rec = float(rec)
    except (TypeError, ValueError):
        rec = 0.0
    if rec >= 0.75:
        return "ppr"
    if rec >= 0.25:
        return "half"
    return "std"

# ---- build classification ------------------------------------------------
CORE_WINDOW = 5          # core archetypes are judged on rounds 1-5

def count_pos(pos_by_round, pos, rmin, rmax):
    return sum(pos_by_round.get(r, []).count(pos) for r in range(rmin, rmax + 1))

def classify(pos_by_round):
    """Core draft archetype from ROUNDS 1-5. Exactly one bucket per team.

    Matches the taxonomy the wider market uses, which reads a full five rounds
    rather than the first two or three — the earlier 1-2/1-3 window called a team
    "Zero RB" for skipping RB twice even if it took two backs in rounds 3-5, and
    that is not what anyone means by the term.

    Precedence below is what makes the five definitions mutually exclusive AND
    exhaustive (they overlap as plain prose — a 1-RB/3-WR start satisfies both
    Hero RB and WR Heavy, so RB count is resolved first):
      Robust RB  3+ RB in rounds 1-5
      Zero RB    0  RB in rounds 1-5
      WR Heavy   3+ WR (and 1-2 RB) in rounds 1-5
      Hero RB    exactly 1 RB, fewer than 3 WR
      Balanced   exactly 2 RB, fewer than 3 WR
    """
    rb = count_pos(pos_by_round, "RB", 1, CORE_WINDOW)
    wr = count_pos(pos_by_round, "WR", 1, CORE_WINDOW)
    if rb >= 3:
        return "Robust RB"
    if rb == 0:
        return "Zero RB"
    if wr >= 3:
        return "WR Heavy"
    return "Hero RB" if rb == 1 else "Balanced"


# ---- positional-timing overlays -----------------------------------------
# Independent of the core archetype: a team can be Hero RB AND Late QB. Each is a
# predicate over the round a position was FIRST taken, so they run off fields the
# corpus already stores (qb1 / te1) and need no re-ingest.
OVERLAYS = [
    ("Elite QB", lambda t: bool(t.get("qb1")) and 1 <= t["qb1"] <= 4),
    ("Late QB",  lambda t: bool(t.get("qb1")) and t["qb1"] >= 8),
    ("Elite TE", lambda t: bool(t.get("te1")) and 1 <= t["te1"] <= 2),
    ("Late TE",  lambda t: bool(t.get("te1")) and t["te1"] >= 8),
]

# First two picks, tracked as its own analysis layer.
OPENINGS2 = ["RB/RB", "RB/WR", "WR/RB", "WR/WR"]

def core_of(t):
    """Core archetype for a stored team record, recomputed from rb15/wr15.

    Deliberately ignores the `arch` frozen at ingest: deriving it here means a
    taxonomy revision is a rebuild (`--rebuild-only`, seconds) instead of a full
    re-crawl. Records predating rb15 return None and drop out of the core layer
    rather than being silently bucketed under the old definitions.
    """
    rb, wr = t.get("rb15"), t.get("wr15")
    if rb is None or wr is None:
        return None
    if rb >= 3:
        return "Robust RB"
    if rb == 0:
        return "Zero RB"
    if wr >= 3:
        return "WR Heavy"
    return "Hero RB" if rb == 1 else "Balanced"


def opening2(seq):
    """'RB/WR' from a stored pick sequence, or None if either pick is not RB/WR."""
    if not seq:
        return None
    parts = seq.split("-")
    if len(parts) < 2 or parts[0] not in ("RB", "WR") or parts[1] not in ("RB", "WR"):
        return None
    return f"{parts[0]}/{parts[1]}"

def first_round_of(pos_by_round, pos):
    rounds = [r for r in pos_by_round if pos in pos_by_round[r]]
    return min(rounds) if rounds else None

# ---- outcome parsing -----------------------------------------------------
def parse_bracket(wb):
    """winners_bracket -> (playoff_roster_ids:set, placement:{roster_id->place}, champion:roster_id|None).

    Matches look like {r, m, t1, t2, w, l, p}. t1/t2 are roster_ids (int) or refs
    ({w:mid}/{l:mid}) — only int entries are concrete teams. `p` on a match means it
    decides place p (winner) and p+1 (loser); the p==1 match's winner is the champ.
    """
    playoff = set()
    placement = {}
    champion = None
    if not isinstance(wb, list):
        return playoff, placement, champion
    max_round = 0
    final_by_round = None
    for mt in wb:
        for k in ("t1", "t2"):
            v = mt.get(k)
            if isinstance(v, int):
                playoff.add(v)
        r = mt.get("r") or 0
        if r > max_round:
            max_round = r
            final_by_round = mt
        p = mt.get("p")
        w, l = mt.get("w"), mt.get("l")
        if isinstance(p, int):
            if isinstance(w, int):
                placement.setdefault(w, p)
            if isinstance(l, int):
                placement.setdefault(l, p + 1)
            if p == 1 and isinstance(w, int):
                champion = w
    # fall back: champion = winner of the last-round match if no p==1 was present
    if champion is None and final_by_round and isinstance(final_by_round.get("w"), int):
        champion = final_by_round["w"]
    return playoff, placement, champion

# ---- ingest one league ---------------------------------------------------
def ingest_league(lid, corpus, state, log_bad=None):
    """Ingest one league if it's a completed in-range redraft season. Push its
    previous_league_id onto the frontier regardless (to walk the chain back).
    Returns number of team records added."""
    seen = state["_seen"]
    chain = state["_chain"]
    ingested = state["_ingested"]
    if lid in seen:
        return 0, None
    seen.add(lid)
    lg = _get(f"league/{lid}")
    if not lg:
        return 0, None
    # Walk the chain back no matter what this season is, and do it with PRIORITY:
    # a 2026 league's parent is the 2025 season we actually want.
    prev = lg.get("previous_league_id")
    if prev and prev not in ("0", 0) and prev not in seen:
        chain.insert(0, prev)

    if (lg.get("settings") or {}).get("type") != REDRAFT_TYPE:
        return 0, None
    if lg.get("status") != "complete":
        return 0, None
    if str(lg.get("season")) not in SEASONS:
        return 0, None
    if lid in ingested:
        return 0, None

    # team count lives on the DRAFT settings, not the league (league.settings.teams
    # is frequently null); len(rosters) is the honest fallback.
    rosters = _get(f"league/{lid}/rosters") or []
    teams = len(rosters)
    if not (TEAMS_MIN <= teams <= TEAMS_MAX):
        return 0, None
    # skip abandoned / reset leagues that are "complete" but never actually played
    if sum((rs.get("settings") or {}).get("wins") or 0 for rs in rosters) == 0:
        return 0, None

    drafts = _get(f"league/{lid}/drafts") or []
    if not drafts:
        return 0, None
    # the season's startup draft = most rounds
    draft = max(drafts, key=lambda d: (d.get("settings") or {}).get("rounds") or 0)
    if ((draft.get("settings") or {}).get("rounds") or 0) < STARTUP_MIN_ROUNDS:
        return 0, None
    picks = _get(f"draft/{draft['draft_id']}/picks") or []
    if not picks:
        # completed offline drafts have no picks on Sleeper — can't reconstruct a build
        return 0, None
    keepers = sum(1 for p in picks if p.get("is_keeper"))
    if picks and keepers / len(picks) > MAX_KEEPER_FRAC:
        return 0, None

    wb = _get(f"league/{lid}/winners_bracket") or []
    playoff, placement, champion = parse_bracket(wb)
    # A completed season whose bracket yields no playoff field gives us NO outcome labels.
    # Ingesting it anyway wrote po=0/place=0/champ=0 for all 10-12 teams — fabricated
    # "missed the playoffs" rows. That is measurable: champ rate must be exactly 1/teams,
    # and it read 1/18 in ppr/sf/12 (a third of that bucket was fake zeros) against 1/12.3
    # in ppr/1qb/12. A transient fetch already raised FetchError above, so reaching here
    # means the bracket really is absent or unparseable — skip the league.
    if not playoff:
        if log_bad:
            log_bad(f"{lid}: no parseable winners_bracket ({len(wb)} matches) — skipped")
        return 0, None

    fmt = league_format(lg)
    sc = league_scoring(lg)
    season = str(lg.get("season"))

    # --- per-roster build from picks ---
    builds = {}   # roster_id -> {pos_by_round, order, slot}
    for pk in picks:
        if pk.get("is_keeper"):
            continue
        rid = pk.get("roster_id")
        pos = (pk.get("metadata") or {}).get("position") or ""
        rnd = pk.get("round") or 0
        slot = pk.get("draft_slot")
        if rid is None or pos not in SKILL_POS or not rnd:
            continue
        b = builds.setdefault(rid, {"pos_by_round": {}, "order": [], "slot": slot})
        b["pos_by_round"].setdefault(rnd, []).append(pos)
        b["order"].append((pk.get("pick_no") or 0, pos))   # true pick order -> opening sequence
        if b["slot"] is None and slot is not None:
            b["slot"] = slot
        # --- reconstructed ADP for the pick-value model ---
        ov = pk.get("pick_no")
        pid = pk.get("player_id")
        if ov and pid:
            md = pk.get("metadata") or {}
            nm = (md.get("first_name", "") + " " + md.get("last_name", "")).strip()
            k = f"{season}|{pid}"
            e = _PICKVALS.get(k)
            if e is None:
                _PICKVALS[k] = {"nm": nm, "pos": pos, "n": 1, "sumov": ov, "minov": ov}
            else:
                e["n"] += 1
                e["sumov"] += ov
                if ov < e["minov"]:
                    e["minov"] = ov

    # --- outcome per roster ---
    outc = {}
    fpts_list = []
    for rs in rosters:
        rid = rs.get("roster_id")
        st = rs.get("settings") or {}
        w = st.get("wins") or 0
        l = st.get("losses") or 0
        t = st.get("ties") or 0
        games = w + l + t
        winpct = (w + 0.5 * t) / games if games else None
        fpts = (st.get("fpts") or 0) + (st.get("fpts_decimal") or 0) / 100.0
        ppts = (st.get("ppts") or 0) + (st.get("ppts_decimal") or 0) / 100.0
        outc[rid] = {"winpct": winpct, "fpts": fpts, "ppts": ppts}
        fpts_list.append((rid, fpts))
    # points-for percentile within league (1.0 = highest scorer)
    fpts_list.sort(key=lambda x: x[1])
    npts = len(fpts_list)
    for i, (rid, _) in enumerate(fpts_list):
        outc[rid]["ptspct"] = round(i / (npts - 1), 4) if npts > 1 else 0.5

    added = 0
    for rid, b in builds.items():
        if rid not in outc:
            continue
        pbr = b["pos_by_round"]
        # need a real drafted build (at least a few skill picks)
        if sum(len(v) for v in pbr.values()) < 6:
            continue
        o = outc[rid]
        if o["winpct"] is None:
            continue
        # opening = the first N skill positions this team actually took, in pick order
        seq = [p for _, p in sorted(b["order"])][:OPENING_LEN]
        # lineup efficiency: points scored / points available had the lineup been
        # perfect. Sleeper's ppts is the only place this is exposed, and it turns
        # "which builds are hard to actually START" into a measurable cost.
        eff = round(o["fpts"] / o["ppts"], 4) if o["ppts"] else None
        rec = {
            # Teams inside one league are NOT independent draws: playoff slots are zero-sum
            # and exactly one roster can be champion. Keeping the league + roster key is what
            # makes clustered standard errors and within-league contrasts possible, and it
            # means a future bad-data class can be deleted selectively instead of by reset.
            "lid": lid,
            "rid": rid,
            "sea": season,
            "tm": teams,
            "slot": b["slot"] or 0,
            "fmt": fmt,
            "sc": sc,
            "arch": classify(pbr),
            "seq": "-".join(seq) if len(seq) == OPENING_LEN else "",
            "rb1": first_round_of(pbr, "RB") or 0,
            "wr1": first_round_of(pbr, "WR") or 0,
            "qb1": first_round_of(pbr, "QB") or 0,
            "te1": first_round_of(pbr, "TE") or 0,
            # rounds 1-5 drive the core archetype; 1-6 drive the "how many" curves
            "rb15": count_pos(pbr, "RB", 1, 5),
            "wr15": count_pos(pbr, "WR", 1, 5),
            "rb16": sum(pbr.get(r, []).count("RB") for r in range(1, 7)),
            "wr16": sum(pbr.get(r, []).count("WR") for r in range(1, 7)),
            "qb16": sum(pbr.get(r, []).count("QB") for r in range(1, 7)),
            "te16": sum(pbr.get(r, []).count("TE") for r in range(1, 7)),
            "wpct": round(o["winpct"], 4),
            "ppct": o["ptspct"],
            "eff": eff,
            "po": 1 if rid in playoff else 0,
            "place": placement.get(rid, 0),
            "champ": 1 if champion == rid else 0,
        }
        corpus["teams"].append(rec)
        added += 1
    ingested.add(lid)
    return added, season

# ---- crawl step ----------------------------------------------------------
def crawl(state, corpus, league_budget, log, max_seconds=MAX_RUN_SECONDS):
    state["_seen"] = set(state["seen_leagues"])
    state["_chain"] = list(state.get("chain", []))
    state["_frontier"] = list(state["frontier"])
    state["_ingested"] = set(state["ingested"])
    seed_frontier_into(state)

    t0 = time.time()
    ingested_this_run = 0
    teams_added = 0
    processed = 0
    by_season = {}
    chain = state["_chain"]
    frontier = state["_frontier"]
    fetch_failures = 0
    consecutive_failures = 0
    no_bracket = [0]

    def note_bad(_msg):
        no_bracket[0] += 1

    while (chain or frontier) and ingested_this_run < league_budget:
        if time.time() - t0 > max_seconds:
            break
        # chain parents first — that is the short path to last season
        lid = chain.pop(0) if chain else frontier.pop(0)
        processed += 1
        try:
            added, season = ingest_league(lid, corpus, state, log_bad=note_bad)
        except FetchError as e:
            # Sleeper never answered. The league is NOT bad data — we just don't know yet.
            # ingest_league already marked it seen, which would blacklist it forever, so
            # un-see it and put it back at the END of the queue for a later run.
            fetch_failures += 1
            consecutive_failures += 1
            state["_seen"].discard(lid)
            frontier.append(lid)
            if consecutive_failures >= FETCH_FAIL_ABORT:
                log(f"crawl: aborting — {consecutive_failures} consecutive fetch failures "
                    f"(last: {e}). Sleeper looks unhealthy; the queue is preserved.")
                break
            continue
        consecutive_failures = 0
        if added:
            ingested_this_run += 1
            teams_added += added
            by_season[season] = by_season.get(season, 0) + 1
        if processed % 100 == 0:
            log(f"  ...{processed} checked, {ingested_this_run} ingested, {teams_added} teams, "
                f"seasons={by_season}, chain={len(chain)} frontier={len(frontier)}")

    if fetch_failures:
        log(f"crawl: {fetch_failures} leagues deferred on fetch failure (re-queued, not lost)")
    if no_bracket[0]:
        log(f"crawl: {no_bracket[0]} completed leagues skipped for no parseable winners_bracket "
            f"(these used to enter the corpus as all-zero outcomes)")
    state["chain"] = chain
    state["frontier"] = frontier
    state["seen_leagues"] = sorted(state["_seen"])
    state["ingested"] = sorted(state["_ingested"])
    for k in ("_seen", "_chain", "_frontier", "_ingested"):
        state.pop(k, None)
    log(f"crawl: checked {processed}, ingested {ingested_this_run} completed seasons {by_season}, "
        f"+{teams_added} teams | corpus={len(corpus['teams'])} chain={len(state['chain'])} frontier={len(state['frontier'])}")

def seed_frontier_into(state):
    """Merge banked ADP redraft leagues into the working frontier, NEWEST FIRST.

    Sleeper league_ids are time-ordered, so descending order starts at the current
    (2026) leagues whose previous_league_id is exactly the 2025 season we want.
    """
    adp = _load(ADP_STATE_FILE, None)
    if not adp:
        return
    seen = state["_seen"]
    frontier = state["_frontier"]
    inq = set(frontier)
    fresh = [lid for lid in adp.get("redraft_leagues", []) if lid not in seen and lid not in inq]
    frontier.extend(fresh)
    # Always re-sort newest-first, not just the fresh ids: a frontier persisted by an
    # older run is in ascending (oldest-first) order, which is exactly what buried
    # 2025 behind thousands of 2024 leagues. Sorting on load is idempotent.
    #
    # Sort NUMERICALLY. These ids are strings of differing length (18 vs 19 digits),
    # so a lexicographic sort ranks "858…" (a 2022 league) above "1039…" (a 2024 one)
    # and hands back the oldest seasons first — the exact opposite of the intent.
    frontier.sort(key=lambda x: int(x) if str(x).isdigit() else 0, reverse=True)

# ---- aggregation / outputs ----------------------------------------------
def _mean(vals):
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None

def wilson(k, n, z=1.96):
    """95% Wilson score interval for a rate. Correct at the small n these buckets have.

    This is the single most important number in the file. With ~30-150 teams behind an
    opening, a 10-point 'edge' is usually indistinguishable from the field — of 47
    reported PPR/1QB openings, only 4 survive this test. Publishing a ranked table
    without it is publishing noise in rank order.
    """
    if not n:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    ctr = (p + z * z / (2 * n)) / d
    rad = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, ctr - rad), min(1.0, ctr + rad))

def _stability(grp, key_fn, baseline_fn, min_n):
    """Is an edge durable across seasons, or an artifact of one lucky year?

    Returns (label, {season: lift}). 'durable' = same sign every season with enough
    teams; 'mixed' = the sign flips (Balanced looked +4.9 in 2024 and -6.2 in 2023 —
    a first pass on 2024 alone called it the best build in the game); 'thin' = not
    enough seasons to judge yet.
    """
    per = {}
    for sea in sorted({t["sea"] for t in grp}):
        g = [t for t in grp if t["sea"] == sea]
        if len(g) < min_n:
            continue
        base = baseline_fn(sea)
        if base is None:
            continue
        per[sea] = round(key_fn(g) - base, 4)
    if len(per) < 2:
        return "thin", per
    signs = {1 if v > 0 else (-1 if v < 0 else 0) for v in per.values()}
    return ("durable" if len(signs) == 1 else "mixed"), per

def _is_top3(t):
    """Did this team finish top-3 in points scored in its league?

    Derived from the stored percentile rather than a new ingested field, so it works
    on every record already in the corpus: ppct = i/(n-1) with i ascending from the
    lowest scorer, so the team's rank from the top is (n-1) - i.
    """
    n = t.get("tm") or 0
    if n < 4:
        return None
    i = round((t.get("ppct") or 0) * (n - 1))
    return 1 if i >= n - 3 else 0

def _top3_rate(teams):
    vals = [v for v in (_is_top3(t) for t in teams) if v is not None]
    return (sum(vals) / len(vals)) if vals else None

def _pts_curve(teams):
    """points-percentile decile -> observed playoff rate, for the whole slice.

    Used to separate "this build wins" from "this build just scored a lot". A build
    whose playoff rate BEATS what its scoring alone predicts is converting points
    into wins; one that trails it was schedule-unlucky and is underrated by record.
    """
    buckets = {}
    for t in teams:
        d = min(9, int((t["ppct"] or 0) * 10))
        b = buckets.setdefault(d, [0, 0])
        b[0] += 1
        b[1] += t["po"]
    return {d: (v[1] / v[0]) for d, v in buckets.items() if v[0] >= 10}

def _expected_po(grp, curve, fallback):
    """Playoff rate this group 'should' have, given only how much it scored."""
    vals = []
    for t in grp:
        d = min(9, int((t["ppct"] or 0) * 10))
        vals.append(curve.get(d, fallback))
    return _mean(vals) if vals else fallback

def _agg_rows(teams):
    """Baseline + per-archetype stats for one slice of team records."""
    n = len(teams)
    if not n:
        return None
    base_po = sum(t["po"] for t in teams) / n
    base_champ = sum(t["champ"] for t in teams) / n
    curve = _pts_curve(teams)
    base_eff = _mean([t.get("eff") for t in teams])
    out = {
        "n": n,
        "baseline": {
            "playoffRate": round(base_po, 4),
            "champRate": round(base_champ, 4),
            "avgWinPct": round(sum(t["wpct"] for t in teams) / n, 4),
            "avgPtsPct": round(sum(t["ppct"] for t in teams) / n, 4),
            "avgEff": round(base_eff, 4) if base_eff is not None else None,
            "top3Rate": round(_top3_rate(teams), 4) if _top3_rate(teams) is not None else None,
        },
        "archetypes": [],
    }
    # Three analysis layers on one scale: mutually-exclusive core archetypes, the
    # independent timing overlays, and the first-two-picks opening. `kind` keeps
    # them distinguishable so the UI never implies the rows partition the field.
    groups = [("core", a, [t for t in teams if core_of(t) == a]) for a in ARCHETYPES]
    groups += [("overlay", name, [t for t in teams if pred(t)]) for name, pred in OVERLAYS]
    groups += [("opening", o, [t for t in teams if opening2(t.get("seq")) == o]) for o in OPENINGS2]

    for kind, arch, grp in groups:
        m = len(grp)
        if m < MIN_ARCH_SAMPLE:
            out["archetypes"].append({"arch": arch, "kind": kind, "n": m, "insufficient": True})
            continue
        po = sum(t["po"] for t in grp) / m
        champ = sum(t["champ"] for t in grp) / m
        exp_po = _expected_po(grp, curve, base_po)
        eff = _mean([t.get("eff") for t in grp])
        lo, hi = wilson(sum(t["po"] for t in grp), m)
        stab, per_season = _stability(
            grp,
            lambda g: sum(t["po"] for t in g) / len(g),
            lambda sea: (lambda s: sum(t["po"] for t in s) / len(s) if len(s) >= 100 else None)(
                [t for t in teams if t["sea"] == sea]),
            60)
        row = {
            "arch": arch,
            "kind": kind,
            "n": m,
            # does the interval clear the field? if not, this rank is decoration
            "ci95": [round(lo, 4), round(hi, 4)],
            "significant": bool(lo > base_po or hi < base_po),
            "stability": stab,
            "bySeason": per_season,
            "share": round(m / n, 4),
            "playoffRate": round(po, 4),
            "champRate": round(champ, 4),
            "avgWinPct": round(sum(t["wpct"] for t in grp) / m, 4),
            "avgPtsPct": round(sum(t["ppct"] for t in grp) / m, 4),
            "playoffLift": round(po - base_po, 4),      # vs field
            "champLift": round(champ - base_champ, 4),
            # share of teams that finished top-3 in points — a scoring-strength
            # measure that playoff rate can mask when schedule luck intervenes
            "top3Rate": round(_top3_rate(grp), 4) if _top3_rate(grp) is not None else None,
            # scoring-adjusted: did the build win MORE than its points explain?
            "expPlayoffRate": round(exp_po, 4),
            "luckDelta": round(po - exp_po, 4),
            # lineup efficiency: share of available points actually started
            "avgEff": round(eff, 4) if eff is not None else None,
            "effLift": round(eff - base_eff, 4) if (eff is not None and base_eff is not None) else None,
        }
        out["archetypes"].append(row)
    out["archetypes"].sort(key=lambda r: (r.get("playoffRate") or -1), reverse=True)
    return out

MIN_SEASON_SLICE = 250   # a single season needs this many teams to stand alone

def write_archetypes(corpus, log):
    teams = corpus["teams"]
    combos = sorted({(t["sc"], t["fmt"]) for t in teams})
    result = {}
    nseason = 0
    for sc, fmt in combos:
        slice_ = [t for t in teams if t["sc"] == sc and t["fmt"] == fmt]
        agg = _agg_rows(slice_)
        if not agg:
            continue
        # Per-season cuts so the page can filter to 2023 / 2024 / 2025. Last season is
        # the one a drafter actually cares about, and pooling hides that Robust RB was
        # -2.7 in 2024 and +14.7 in 2025.
        agg["bySeasonSlice"] = {}
        for sea in sorted({t["sea"] for t in slice_}):
            sub = [t for t in slice_ if t["sea"] == sea]
            if len(sub) < MIN_SEASON_SLICE:
                continue
            sub_agg = _agg_rows(sub)
            if sub_agg:
                agg["bySeasonSlice"][sea] = sub_agg
                nseason += 1
        result[f"{sc}|{fmt}"] = agg
    _save("redraft_strategy_archetypes.json", _wrap(result, corpus))
    log(f"output archetypes: {len(result)} scoring|format slices (+{nseason} season cuts)")

def write_position_rounds(corpus, log):
    """For each position, round-of-first-pick -> playoff rate (heatmap data),
    split by scoring|format. Also playoff-team vs field median first-round."""
    teams = corpus["teams"]
    combos = sorted({(t["sc"], t["fmt"]) for t in teams})
    result = {}
    for sc, fmt in combos:
        slice_ = [t for t in teams if t["sc"] == sc and t["fmt"] == fmt]
        block = {}
        for pos, key in (("RB", "rb1"), ("WR", "wr1"), ("QB", "qb1"), ("TE", "te1")):
            byround = {}
            for t in slice_:
                r = t[key]
                if not r:
                    continue
                d = byround.setdefault(r, {"n": 0, "po": 0})
                d["n"] += 1
                d["po"] += t["po"]
            rows = [{"round": r, "n": d["n"], "playoffRate": round(d["po"] / d["n"], 4)}
                    for r, d in sorted(byround.items()) if d["n"] >= MIN_SLOT_SAMPLE]
            block[pos] = rows
        result[f"{sc}|{fmt}"] = block
    _save("redraft_strategy_position_rounds.json", _wrap(result, corpus))
    log(f"output position_rounds: {len(result)} slices")

def write_by_slot(corpus, log):
    """Playoff rate + best archetype BY draft slot, per scoring|format|teams."""
    teams = corpus["teams"]
    combos = sorted({(t["sc"], t["fmt"], t["tm"]) for t in teams})
    result = {}
    for sc, fmt, tm in combos:
        slice_ = [t for t in teams if t["sc"] == sc and t["fmt"] == fmt and t["tm"] == tm]
        slots = {}
        for slot in range(1, tm + 1):
            grp = [t for t in slice_ if t["slot"] == slot]
            if len(grp) < MIN_SLOT_SAMPLE:
                continue
            po = sum(t["po"] for t in grp) / len(grp)
            # best archetype from this slot (needs a small floor)
            best = None
            for arch in ARCHETYPES:
                ag = [t for t in grp if t["arch"] == arch]
                if len(ag) >= max(10, MIN_SLOT_SAMPLE // 2):
                    rate = sum(t["po"] for t in ag) / len(ag)
                    if best is None or rate > best["playoffRate"]:
                        best = {"arch": arch, "n": len(ag), "playoffRate": round(rate, 4)}
            slots[slot] = {"n": len(grp), "playoffRate": round(po, 4), "bestArchetype": best}
        if slots:
            result[f"{sc}|{fmt}|{tm}"] = slots
    _save("redraft_strategy_by_slot.json", _wrap(result, corpus))
    log(f"output by_slot: {len(result)} scoring|format|teams slices")

MIN_OPENING_SAMPLE = 30      # an exact 4-pick opening needs >= N teams to be reported
MIN_CURVE_SAMPLE = 40

def write_openings(corpus, log):
    """THE OPENINGS — exact first-four-pick position sequences ranked by outcome.

    This is the sharp end of the whole dataset. Five archetypes are a summary;
    "WR-WR-RB-RB went 58%" is a decision. Every team's real opening is mined, so a
    drafter can look up the exact shape they are building toward mid-draft.
    """
    teams = corpus["teams"]
    combos = sorted({(t["sc"], t["fmt"]) for t in teams})
    result = {}
    for sc, fmt in combos:
        slice_ = [t for t in teams if t["sc"] == sc and t["fmt"] == fmt and t.get("seq")]
        if not slice_:
            continue
        n = len(slice_)
        base_po = sum(t["po"] for t in slice_) / n
        base_champ = sum(t["champ"] for t in slice_) / n
        curve = _pts_curve(slice_)
        groups = {}
        for t in slice_:
            groups.setdefault(t["seq"], []).append(t)
        rows = []
        for seq, grp in groups.items():
            m = len(grp)
            if m < MIN_OPENING_SAMPLE:
                continue
            po = sum(t["po"] for t in grp) / m
            exp_po = _expected_po(grp, curve, base_po)
            lo, hi = wilson(sum(t["po"] for t in grp), m)
            stab, per_season = _stability(
                grp,
                lambda g: sum(t["po"] for t in g) / len(g),
                lambda sea: (lambda s: sum(t["po"] for t in s) / len(s) if len(s) >= 100 else None)(
                    [t for t in slice_ if t["sea"] == sea]),
                25)
            rows.append({
                "seq": seq,
                "n": m,
                "share": round(m / n, 4),
                "playoffRate": round(po, 4),
                "playoffLift": round(po - base_po, 4),
                "ci95": [round(lo, 4), round(hi, 4)],
                "significant": bool(lo > base_po or hi < base_po),
                "stability": stab,
                "bySeason": per_season,
                "champRate": round(sum(t["champ"] for t in grp) / m, 4),
                "champLift": round(sum(t["champ"] for t in grp) / m - base_champ, 4),
                "avgPtsPct": round(sum(t["ppct"] for t in grp) / m, 4),
                "luckDelta": round(po - exp_po, 4),
            })
        rows.sort(key=lambda r: r["playoffRate"], reverse=True)
        result[f"{sc}|{fmt}"] = {
            "n": n,
            "distinctOpenings": len(groups),
            "reported": len(rows),
            "significant": sum(1 for r in rows if r["significant"]),
            "baseline": {"playoffRate": round(base_po, 4), "champRate": round(base_champ, 4)},
            "openings": rows,
        }
    _save("redraft_strategy_openings.json", _wrap(result, corpus))
    log(f"output openings: {len(result)} slices, "
        f"{sum(v['reported'] for v in result.values())} reported / "
        f"{sum(v['significant'] for v in result.values())} statistically significant")

def write_curves(corpus, log):
    """How MANY of each position in the first six rounds -> playoff rate.

    Answers the question archetypes can only gesture at: not "should I go RB early"
    but "how many RBs is too many". Each curve has a peak; that peak is the advice.
    """
    teams = corpus["teams"]
    combos = sorted({(t["sc"], t["fmt"]) for t in teams})
    result = {}
    for sc, fmt in combos:
        slice_ = [t for t in teams if t["sc"] == sc and t["fmt"] == fmt]
        if not slice_:
            continue
        base_po = sum(t["po"] for t in slice_) / len(slice_)
        block = {"baseline": round(base_po, 4), "n": len(slice_), "positions": {}}
        for pos, key in (("RB", "rb16"), ("WR", "wr16"), ("QB", "qb16"), ("TE", "te16")):
            counts = {}
            for t in slice_:
                c = t.get(key)
                if c is None:
                    continue
                d = counts.setdefault(c, [0, 0])
                d[0] += 1
                d[1] += t["po"]
            rows = [{"count": c, "n": v[0],
                     "playoffRate": round(v[1] / v[0], 4),
                     "playoffLift": round(v[1] / v[0] - base_po, 4)}
                    for c, v in sorted(counts.items()) if v[0] >= MIN_CURVE_SAMPLE]
            if rows:
                peak = max(rows, key=lambda r: r["playoffRate"])
                block["positions"][pos] = {"curve": rows, "peak": peak["count"]}
        result[f"{sc}|{fmt}"] = block
    _save("redraft_strategy_curves.json", _wrap(result, corpus))
    log(f"output curves: {len(result)} slices")

def write_stats(corpus, state, log):
    teams = corpus["teams"]
    seasons = sorted({t["sea"] for t in teams})
    by_sc, by_sea = {}, {}
    for t in teams:
        by_sc[t["sc"]] = by_sc.get(t["sc"], 0) + 1
        by_sea[t["sea"]] = by_sea.get(t["sea"], 0) + 1
    stats = {
        "teams": len(teams),
        "leagues": len(state.get("ingested", [])),
        "seasons": seasons,
        "teams_by_season": by_sea,
        "teams_by_scoring": by_sc,
        "frontier": len(state.get("frontier", [])),
        "seen_leagues": len(state.get("seen_leagues", [])),
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _save("redraft_strategy_stats.json", stats)
    log(f"stats: {len(teams)} teams / {stats['leagues']} leagues / seasons {seasons}")

def _wrap(payload, corpus):
    return {
        "source": "aggregated real completed Sleeper redraft leagues",
        "seasons": sorted({t["sea"] for t in corpus["teams"]}),
        "teams": len(corpus["teams"]),
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data": payload,
    }

# ---- main ----------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-budget", type=int, default=DEF_LEAGUE_BUDGET)
    ap.add_argument("--rebuild-only", action="store_true",
                    help="recompute outputs from the existing corpus, no crawling")
    ap.add_argument("--max-seconds", type=int, default=MAX_RUN_SECONDS,
                    help="wall-clock cap for the crawl step (default suits the cron; raise it "
                         "for a manual backfill)")
    ap.add_argument("--reset-corpus", action="store_true",
                    help="discard the corpus AND the crawl checkpoint and start over. Needed "
                         "after the winners_bracket fix: the fabricated all-zero outcome rows "
                         "carry no league id, so they cannot be deleted selectively.")
    args = ap.parse_args()

    def log(m):
        print(f"[redraft-strategy] {m}", flush=True)

    state = _load(STATE_FILE, None) or new_state()
    # Fall back to the pre-gzip file the first time, so the switch migrates in place
    # (this run reads the old .json, every _save writes the new .json.gz).
    corpus = _load(CORPUS_FILE, None) or _load(CORPUS_FILE_LEGACY, None) or {"teams": []}
    global _PICKVALS
    _PICKVALS = _load(PICKVALS_FILE, None) or {}

    if args.reset_corpus:
        if args.rebuild_only:
            ap.error("--reset-corpus with --rebuild-only would rebuild from an empty corpus")
        # Reuse the OLD ingested ids as the fresh frontier. They are already known to be
        # completed, in-range, real redraft seasons, so the re-crawl goes straight at them
        # instead of re-discovering them through thousands of non-qualifying leagues.
        # NEWEST FIRST. `ingested` is stored sorted ascending, and Sleeper league ids are
        # time-ordered, so draining it as-is rebuilds 2023 first — the thinnest and least
        # useful season. Sort numerically (the ids differ in digit length, so a string sort
        # puts 2022 ahead of 2024) to match the crawler's existing newest-first intent.
        known = sorted(state.get("ingested", []),
                       key=lambda x: int(x) if str(x).isdigit() else 0, reverse=True)
        log(f"reset: discarding {len(corpus['teams'])} team records; re-seeding the frontier "
            f"with the {len(known)} league ids already known to qualify")
        state, corpus = new_state(), {"teams": []}
        _PICKVALS.clear()   # re-crawling the same leagues would double-count reconstructed ADP
        # These go on `chain`, not `frontier`: crawl() drains chain first, and
        # seed_frontier_into() re-sorts the frontier and floods it with ~28k banked ADP
        # league ids — which would bury the known-good list behind mostly non-qualifying ones.
        state["chain"] = known

    if not args.rebuild_only:
        t0 = time.time()
        crawl(state, corpus, args.league_budget, log, max_seconds=args.max_seconds)
        state["last_run"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        state["stats"] = {
            "corpus_teams": len(corpus["teams"]),
            "ingested_leagues": len(state["ingested"]),
            "frontier": len(state["frontier"]),
            "run_seconds": round(time.time() - t0, 1),
        }
        _save(STATE_FILE, state)
        _save(CORPUS_FILE, corpus)
        _save(PICKVALS_FILE, _PICKVALS)
        log(f"state: {state['stats']}  pickvals={len(_PICKVALS)} player-seasons")

    write_archetypes(corpus, log)
    write_position_rounds(corpus, log)
    write_by_slot(corpus, log)
    write_openings(corpus, log)
    write_curves(corpus, log)
    write_stats(corpus, state, log)
    log("done")


if __name__ == "__main__":
    main()
