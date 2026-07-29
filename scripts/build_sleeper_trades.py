#!/usr/bin/env python3
"""
Build a REAL trade corpus + a fitted trade market model from Sleeper leagues.

WHY
---
Vault's Trade Engines (Matchmaker / Exploit Finder / Idea Generator) were built
on hand-tuned constants: a flat +/-18% "fair" band, a made-up PICK_VALUES table,
and an acceptance score assembled from guessed penalties (-18 for asking a crown
jewel, +10 for timeline fit...). None of it had ever seen a real trade.

We already crawl ~110k real Sleeper leagues for ADP. Those same leagues have
executed trades, and Sleeper exposes them for free. This script harvests them and
fits the constants from data instead of intuition.

HOW IT WORKS
------------
  1. League IDs come from the ADP crawler's state file — no new discovery.
     Only leagues in the recency window's seasons are worth pulling.
  2. GET /league/<lid>/transactions/<leg> for leg 1..18. Leg == NFL week, and
     EVERY offseason trade lands in leg 1 — so a league that hasn't kicked off
     yet costs 2 requests, not 18.
  3. Each completed 2-team trade is normalized to two sides of asset ids:
       player -> sleeper player_id
       pick   -> "P<yearsOut>R<round>", years out measured from the NEXT rookie
                 draft as of the trade date (so a "2027 1st" traded in Aug 2026
                 and in Feb 2027 are the same asset, which is the whole point)
  4. The corpus is keyed by league so a re-pull replaces that league cleanly,
     and pruned to a recency window so the market stays current.

THE MODEL (--rebuild-only recomputes it without crawling)
---------------------------------------------------------
  * MARKET VALUES. Every accepted trade is evidence that its two sides were
    priced about equally BY THE PEOPLE ACTUALLY TRADING. We solve for per-asset
    multipliers on top of a FantasyCalc prior so that real trades balance:
    an Elo-style damped multiplicative update in log space, share-weighted so a
    throw-in doesn't absorb a stud's correction, shrunk toward the prior by
    sample count, and recency-weighted. The output is not "another calculator"
    — it is the gap between what a calculator says and what leagues pay, which
    is exactly the buy-low / sell-high signal the Exploit Finder wants.
  * PICK VALUES fall out of the same solve. Picks have thousands of samples and
    no strong prior, so this replaces the hardcoded PICK_VALUES table with
    measured ones.
  * FAIRNESS BANDS. The real distribution of value gaps in trades that actually
    cleared — which is what "is this fair?" should mean.
  * CONSOLIDATION PREMIUM. Real 2-for-1s are not even; the side buying the best
    player pays measurably more. A symmetric +/-18% band cannot see this.
  * SHAPES / POSITIONS / TIMING. How often each package shape really happens
    (Idea Generator sampled all four uniformly), which positions move, and the
    trade-volume + vet-for-pick curve across the season (Exploit Finder timing).
  * COMPS. The actual packages a given player was traded for. Retrieval beats
    inference: "real leagues paid this" is the most credible thing we can say.

OUTPUTS (data/)
---------------
  sleeper_trade_state.json    crawl bookkeeping (which leagues pulled, when)
  sleeper_trade_corpus.json   the trade corpus, keyed by league, windowed
  trade_market.json           the served model (values, picks, bands, priors)
  trade_comps.json            per-player real comparable packages

USAGE
  python3 scripts/build_sleeper_trades.py                  # crawl a chunk + rebuild
  python3 scripts/build_sleeper_trades.py --league-budget 300
  python3 scripts/build_sleeper_trades.py --rebuild-only   # refit from corpus only
"""

import argparse
import datetime as dt
import json
import math
import os
import random
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://api.sleeper.app/v1"
USER_AGENT = "Vault-Fantasy/1.0 (+https://putput12-jp.github.io/Vault-Fantasy)"
FC_URL = "https://api.fantasycalc.com/values/current?isDynasty={dyn}&numQbs={qbs}&numTeams=12&ppr=1"

DATA_DIR = "data"
ADP_STATE_FILE = "sleeper_crawl_state.json"     # league IDs come from here
STATE_FILE = "sleeper_trade_state.json"
CORPUS_FILE = "sleeper_trade_corpus.json"
META_FILE = "sleeper_player_meta.json"          # written by build_sleeper_adp.py
MARKET_FILE = "trade_market.json"
COMPS_FILE = "trade_comps.json"

# ---- crawl config --------------------------------------------------------
WINDOW_DAYS = 430          # trades older than this stop counting (covers a full season + offseason)
REPULL_DAYS = 10           # re-pull a trade-producing league after this many days
DORMANT_REPULL_DAYS = 45   # a league that had no trades yet still deserves an occasional look
REPULL_SHARE = 0.3         # ceiling on the share of a run spent re-pulling
MAX_LEG = 18               # NFL weeks; leg 1 also holds every offseason trade
PRESEASON_LEGS = 2         # leagues that haven't kicked off only need leg 1 (+1 for safety)
DEF_LEAGUE_BUDGET = 900    # leagues pulled per run
MAX_RUN_SECONDS = 1500     # wall-clock cap so a cron run always finishes
WORKERS = 8                # parallel league pulls
REQ_PER_MIN = 850          # stay well under Sleeper's ~1000/min guidance
MAX_TEAMS_IN_TRADE = 2     # 3-way trades have no two-sided balance equation
MAX_PICK_ROUND = 5
MAX_YEARS_OUT = 3

# ---- model config --------------------------------------------------------
EPOCHS = 40                # solver passes over the corpus
ETA = 0.22                 # learning rate on the log-value multiplier
CLAMP_LN = math.log(3.0)   # a multiplier may not exceed 3x / drop below 1/3 the prior
RESID_CLAMP = math.log(4.0)  # winsorize per-trade residual so a fleece can't dominate
SHRINK_PLAYER = 30.0       # samples needed before a player's multiplier is taken at face value
SHRINK_PICK = 8.0          # picks have far more samples and a far weaker prior
HALFLIFE_DAYS = 200.0      # recency weight on each trade
MIN_TRADES_PLAYER = 4      # a player needs this many trades to be published
# A bucket has to be able to say something before it is allowed to speak. At ~50
# trades the fitted bands are noise (a redraft bucket briefly published a
# consolidation premium BELOW 1, which is backwards), and because a published
# bucket wins over borrowing dynasty's, a thin one is worse than none at all.
MIN_TRADES_BUCKET = 400
COMPS_PER_PLAYER = 6
POS_SET = {"QB", "RB", "WR", "TE"}

# Fallback prior for pick values, by years out from the next rookie draft, used
# only when FantasyCalc's own pick rows can't be read (see load_priors). These
# mirror index.html's PICK_VALUES — which a cross-check against FantasyCalc
# showed to be roughly 60% too high on future 1sts — so they are a last resort,
# not the intended path. yearsOut 0 == the NEXT rookie draft.
PICK_PRIOR = {
    0: {1: 3000, 2: 1500, 3: 1000, 4: 800, 5: 400},
    1: {1: 2100, 2: 1280, 3: 950, 4: 780, 5: 390},
    2: {1: 1860, 2: 1220, 3: 945, 4: 800, 5: 400},
    3: {1: 1700, 2: 1150, 3: 900, 4: 780, 5: 390},
}

# (mode, fmt) buckets the model is fit separately for — a superflex QB and a
# 1QB QB are simply not the same asset, and pooling them blurs both.
BUCKETS = [("dyn", "sf"), ("dyn", "1qb"), ("rdr", "sf"), ("rdr", "1qb")]


# ---- rate-limited HTTP ---------------------------------------------------
import threading

_rate_lock = threading.Lock()
_next_slot = [0.0]
_MIN_INTERVAL = 60.0 / REQ_PER_MIN


def _slot():
    """Global token gate: hands out request slots at most REQ_PER_MIN/min even
    across the worker pool. Threads make it easy to accidentally hammer the API."""
    with _rate_lock:
        now = time.time()
        t = max(now, _next_slot[0])
        _next_slot[0] = t + _MIN_INTERVAL
    wait = t - time.time()
    if wait > 0:
        time.sleep(wait)


def _get(path, tries=4):
    """GET <API>/<path> -> parsed JSON, or None on 404/empty. Retries on 429/5xx."""
    url = f"{API}/{path}"
    for attempt in range(tries):
        _slot()
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


def _fetch_json(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


# ---- persistence ---------------------------------------------------------
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


def new_state():
    return {"version": 1, "pulled": {}, "skip": [], "last_run": None, "stats": {}}


# ---- trade normalization -------------------------------------------------
def _today():
    return dt.date.today()


def _day(ts_ms):
    """Epoch ms -> integer days since epoch (compact + plenty precise for this)."""
    return int(ts_ms // 86400000)


def next_rookie_year(ts_ms):
    """The year of the NEXT rookie draft as of a trade's date.

    Rookie drafts run in May. Trade in Aug 2026 -> next draft is 2027.
    Trade in Feb 2027 -> next draft is still 2027. Normalizing pick assets to
    'years out from the next draft' is what makes a 2027 1st the SAME asset in
    both trades; keying on the literal season would split it in two and halve
    the sample on every pick in the corpus.
    """
    d = dt.datetime.fromtimestamp(ts_ms / 1000.0, dt.timezone.utc)
    return d.year if d.month <= 5 else d.year + 1


def pick_asset(season, rnd, ts_ms):
    """{season, round} -> 'P<yearsOut>R<round>', or None if out of range/spent."""
    try:
        yr = int(season)
        rnd = int(rnd)
    except (TypeError, ValueError):
        return None
    if rnd < 1:
        return None
    # Deep startup drafts trade round-15 and round-20 picks, which are close to
    # worthless. Clamping those into the R5 bucket pooled them with rookie 5ths
    # and dragged that bucket's fitted value up more than 2x. Drop them instead —
    # a rookie draft is 3-5 rounds, so anything past that is a different asset.
    if rnd > MAX_PICK_ROUND:
        return None
    out = yr - next_rookie_year(ts_ms)
    if out < 0 or out > MAX_YEARS_OUT:
        return None
    return f"P{out}R{rnd}"


def parse_trade(tx):
    """A Sleeper trade transaction -> (sideA, sideB, faabA, faabB) or None.

    Sides are expressed as 'what each roster RECEIVES'. adds/drops are keyed
    player_id -> roster_id, and draft picks carry owner_id (the new owner).
    """
    rids = tx.get("roster_ids") or []
    if len(rids) != MAX_TEAMS_IN_TRADE:
        return None
    r1, r2 = rids[0], rids[1]
    ts = tx.get("status_updated") or tx.get("created") or 0
    if not ts:
        return None
    a, b = [], []
    for pid, rid in (tx.get("adds") or {}).items():
        if rid == r1:
            a.append(str(pid))
        elif rid == r2:
            b.append(str(pid))
    for pk in tx.get("draft_picks") or []:
        asset = pick_asset(pk.get("season"), pk.get("round"), ts)
        if not asset:
            continue
        own = pk.get("owner_id")
        if own == r1:
            a.append(asset)
        elif own == r2:
            b.append(asset)
    fa = fb = 0
    for w in tx.get("waiver_budget") or []:
        amt = w.get("amount") or 0
        if w.get("receiver") == r1:
            fa += amt
        elif w.get("receiver") == r2:
            fb += amt
    if not a and not b:
        return None
    return a, b, fa, fb


def league_fmt(lg):
    rp = lg.get("roster_positions") or []
    return "sf" if ("SUPER_FLEX" in rp or rp.count("QB") >= 2) else "1qb"


def league_mode(lg):
    t = (lg.get("settings") or {}).get("type")
    return "dyn" if t == 2 else ("rdr" if t == 0 else None)


def pull_league(lid, min_day):
    """Fetch one league's metadata + trades. Returns a corpus entry or None.

    Returns the sentinel {"skip": True} for leagues that will never be worth
    re-visiting (wrong type, or a season entirely behind the window), so the
    caller can blacklist them instead of paying for them every run.
    """
    lg = _get(f"league/{lid}")
    if not lg:
        return {"skip": True}
    mode = league_mode(lg)
    if not mode:
        return {"skip": True}
    season = str(lg.get("season") or "")
    # A completed season whose LAST possible trade predates the window can never
    # contribute — blacklist rather than re-scan 18 legs of it every run.
    try:
        if lg.get("status") == "complete" and int(season) < _today().year - 1:
            return {"skip": True}
    except ValueError:
        return {"skip": True}
    status = lg.get("status") or ""
    legs = PRESEASON_LEGS if status in ("pre_draft", "drafting") else MAX_LEG
    trades = []
    for leg in range(1, legs + 1):
        tx = _get(f"league/{lid}/transactions/{leg}")
        if not tx:
            continue
        for t in tx:
            if t.get("type") != "trade" or t.get("status") != "complete":
                continue
            parsed = parse_trade(t)
            if not parsed:
                continue
            a, b, fa, fb = parsed
            ts = t.get("status_updated") or t.get("created")
            day = _day(ts)
            if day < min_day:
                continue
            trades.append([day, leg, a, b, fa, fb])
    return {
        "m": mode,
        "f": league_fmt(lg),
        "tm": lg.get("total_rosters") or 12,
        "sn": season,
        "p": (_today() - dt.date(1970, 1, 1)).days,
        "x": trades,
    }


def candidate_leagues(state, corpus, budget, log):
    """League IDs worth pulling this run.

    Three classes, in priority order:
      * never pulled            — how the corpus grows
      * pulled and productive   — re-read after REPULL_DAYS so in-season trades
                                  keep landing without a full re-crawl
      * pulled and empty        — re-read only after DORMANT_REPULL_DAYS. A
                                  league can be pre-draft (or simply quiet) the
                                  day we hit it and busy a month later; without
                                  this it would be marked pulled and never
                                  looked at again, silently losing every trade
                                  it ever makes.

    Re-pulls are capped at REPULL_SHARE of the run. Once tens of thousands of
    leagues are productive, an uncapped re-pull queue would eat every run's
    budget and discovery would stop dead.
    """
    adp = _load(ADP_STATE_FILE, {})
    pool = list(adp.get("dynasty_leagues") or []) + list(adp.get("redraft_leagues") or [])
    if not pool:
        log("WARNING: no leagues in the ADP crawl state — run build_sleeper_adp.py first")
        return []
    skip = set(state.get("skip") or [])
    pulled = state.get("pulled") or {}
    leagues = corpus.get("leagues", {})
    today = (_today() - dt.date(1970, 1, 1)).days
    fresh, active, dormant = [], [], []
    for lid in pool:
        if lid in skip:
            continue
        last = pulled.get(lid)
        if last is None:
            fresh.append(lid)
        elif leagues.get(lid, {}).get("x"):
            if today - last >= REPULL_DAYS:
                active.append(lid)
        elif today - last >= DORMANT_REPULL_DAYS:
            dormant.append(lid)
    # Shuffle the unpulled pool: the ADP state is in BFS discovery order, which
    # correlates hard with a single seed's corner of the league graph. Sampling
    # it in order would build a market model out of one social circle.
    for lst in (fresh, active, dormant):
        random.shuffle(lst)
    cap = int(budget * REPULL_SHARE)
    repull = (active + dormant)[:cap]
    log(f"candidates: {len(fresh)} never-pulled, {len(active)} active + {len(dormant)} dormant "
        f"due for re-pull (taking {len(repull)}), {len(skip)} blacklisted")
    return repull + fresh


def crawl(state, corpus, budget, log):
    min_day = (_today() - dt.timedelta(days=WINDOW_DAYS) - dt.date(1970, 1, 1)).days
    todo = candidate_leagues(state, corpus, budget, log)[:budget]
    if not todo:
        return
    leagues = corpus.setdefault("leagues", {})
    pulled = state.setdefault("pulled", {})
    skip = set(state.get("skip") or [])
    today = (_today() - dt.date(1970, 1, 1)).days
    t0 = time.time()
    done = ntrades = nskip = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {}
        it = iter(todo)

        def submit_next():
            try:
                lid = next(it)
            except StopIteration:
                return False
            futures[ex.submit(pull_league, lid, min_day)] = lid
            return True

        for _ in range(WORKERS * 2):
            if not submit_next():
                break
        while futures:
            for fut in list(futures):
                if not fut.done():
                    continue
                lid = futures.pop(fut)
                try:
                    res = fut.result()
                except Exception:
                    res = None
                done += 1
                if res is None:
                    pass
                elif res.get("skip"):
                    skip.add(lid)
                    nskip += 1
                else:
                    pulled[lid] = today
                    if res["x"]:
                        leagues[lid] = res          # replaces any prior pull cleanly
                        ntrades += len(res["x"])
                    else:
                        leagues.pop(lid, None)
                if time.time() - t0 < MAX_RUN_SECONDS:
                    submit_next()
                if done % 100 == 0:
                    log(f"  {done}/{len(todo)} leagues · {ntrades} trades · {time.time()-t0:.0f}s")
            if time.time() - t0 > MAX_RUN_SECONDS:
                log("run budget reached — saving progress")
                for fut in futures:
                    fut.cancel()
                break
            time.sleep(0.02)

    state["skip"] = sorted(skip)
    log(f"crawl: {done} leagues, +{ntrades} trades, {nskip} blacklisted, {time.time()-t0:.0f}s")


def prune(corpus, log):
    min_day = (_today() - dt.timedelta(days=WINDOW_DAYS) - dt.date(1970, 1, 1)).days
    leagues = corpus.get("leagues", {})
    dropped = 0
    for lid in list(leagues):
        x = [t for t in leagues[lid]["x"] if t[0] >= min_day]
        if not x:
            del leagues[lid]
            dropped += 1
        else:
            leagues[lid]["x"] = x
    if dropped:
        log(f"prune: dropped {dropped} leagues with no in-window trades")


# ══════════════════════════════════════════════════════════════════════════
#  MODEL
# ══════════════════════════════════════════════════════════════════════════
_PICK_NAME_RE = re.compile(r"^(\d{4})\s+(\d)(?:st|nd|rd|th)(?:\s+\((Early|Mid|Late)\))?$")


def load_priors(log):
    """FantasyCalc priors per (mode, fmt) bucket: players by sleeper id, plus picks.

    FantasyCalc's value list carries PICK rows alongside the players ("2028 1st",
    "2027 2nd (Mid)"). They were being skipped here, which meant picks — the most
    frequently traded assets in the corpus — were the one thing anchored to a
    table somebody made up. They are a real market source, so use them: it also
    means a thin bucket starts somewhere sane instead of somewhere invented.

    Untiered rows ("2028 1st") are the ones we want, since the corpus has no
    draft slot either. Tiered rows are only read to fill a gap.
    """
    priors = {}
    base_year = next_rookie_year(time.time() * 1000)
    for mode, fmt in BUCKETS:
        url = FC_URL.format(dyn=("true" if mode == "dyn" else "false"),
                            qbs=(2 if fmt == "sf" else 1))
        data = _fetch_json(url)
        if not data:
            log(f"WARNING: FantasyCalc prior unavailable for {mode}/{fmt}")
            priors[(mode, fmt)] = {}
            continue
        d, picks, tiered = {}, {}, {}
        for row in data:
            p = row.get("player") or {}
            v = row.get("value")
            if not v:
                continue
            sid = p.get("sleeperId")
            name = p.get("name") or ""
            m = _PICK_NAME_RE.match(name)
            if m:
                out, rnd, tier = int(m.group(1)) - base_year, int(m.group(2)), m.group(3)
                if 0 <= out <= MAX_YEARS_OUT and 1 <= rnd <= MAX_PICK_ROUND:
                    (tiered if tier else picks)[f"P{out}R{rnd}"] = float(v)
            elif sid:
                d[str(sid)] = float(v)
        for k, v in tiered.items():
            picks.setdefault(k, v)
        priors[(mode, fmt)] = d
        priors[("picks", mode, fmt)] = picks
        log(f"prior {mode}/{fmt}: {len(d)} players + {len(picks)} pick slots from FantasyCalc")
    return priors


def flatten(corpus, mode, fmt):
    """Corpus -> [(day, leg, sideA, sideB)] for one bucket, FAAB-free only.

    FAAB in a trade is real value we cannot price, so those trades would teach
    the solver that one side gave away a player for nothing. They still count
    for shape/timing stats, but never for values.
    """
    out, with_faab = [], []
    for lg in corpus.get("leagues", {}).values():
        if lg.get("m") != mode or lg.get("f") != fmt:
            continue
        for day, leg, a, b, fa, fb in lg["x"]:
            if not a or not b:
                continue          # one-sided salary dump: no balance equation
            (with_faab if (fa or fb) else out).append((day, leg, a, b))
    return out, with_faab


def prior_value(asset, prior, pick_prior=None):
    """Prior value of one asset. Picks prefer FantasyCalc's own pick rows and
    fall back to the hand table only if those couldn't be read."""
    if asset.startswith("P") and "R" in asset:
        if pick_prior and asset in pick_prior:
            return float(pick_prior[asset])
        try:
            out = int(asset[1:asset.index("R")])
            rnd = int(asset[asset.index("R") + 1:])
        except ValueError:
            return 0.0
        return float(PICK_PRIOR.get(out, {}).get(rnd, 0))
    return float(prior.get(asset, 0.0))


def solve_values(trades, prior, pick_prior, today_day, log, tag=""):
    """Fit per-asset multipliers so real trades balance.

    Each accepted trade says its two sides were priced about equally by the
    people who made it. We hold a FantasyCalc prior and learn a multiplier on
    top, in log space:

        e = ln(value of side B) - ln(value of side A)

    and nudge every asset on A up by eta*e*share and every asset on B down by
    the same, share-weighted so a 5% throw-in doesn't absorb a stud's
    correction. Multipliers shrink toward 1 by sample count, so a player seen
    three times stays at his prior and a pick seen 4,000 times does not.
    """
    counts, wsum = {}, {}
    usable = []
    for day, leg, a, b in trades:
        if not all(prior_value(x, prior, pick_prior) > 0 for x in a + b):
            continue                      # an unpriceable asset makes the equation meaningless
        w = 0.5 ** ((today_day - day) / HALFLIFE_DAYS)
        usable.append((a, b, w))
        for x in a + b:
            counts[x] = counts.get(x, 0) + 1
            wsum[x] = wsum.get(x, 0.0) + w
    if not usable:
        log(f"solve{tag}: no usable trades")
        return {}, {}, []
    log(f"solve{tag}: {len(usable)}/{len(trades)} trades priceable, {len(counts)} assets")

    ln_m = {k: 0.0 for k in counts}
    for epoch in range(EPOCHS):
        grad = {}
        for a, b, w in usable:
            va = [prior_value(x, prior, pick_prior) * math.exp(ln_m[x]) for x in a]
            vb = [prior_value(x, prior, pick_prior) * math.exp(ln_m[x]) for x in b]
            sa, sb = sum(va), sum(vb)
            if sa <= 0 or sb <= 0:
                continue
            e = math.log(sb) - math.log(sa)
            e = max(-RESID_CLAMP, min(RESID_CLAMP, e))
            for x, v in zip(a, va):
                grad[x] = grad.get(x, 0.0) + w * ETA * e * (v / sa)
            for x, v in zip(b, vb):
                grad[x] = grad.get(x, 0.0) - w * ETA * e * (v / sb)
        for x, g in grad.items():
            # per-asset step is the mean weighted nudge over the trades it appeared in
            ln_m[x] = max(-CLAMP_LN, min(CLAMP_LN, ln_m[x] + g / wsum[x]))

    # Shrink toward the prior ONCE, at the end. Doing it inside the loop makes
    # every epoch re-shrink an already-shrunk estimate, so the fixed point ends
    # up somewhere that depends on the update rule rather than on the evidence.
    # This way the solver converges to what the trades say, and only then do we
    # discount it by how much evidence there actually was: lam is the "trades
    # before I believe you" constant, and it is what keeps a player seen three
    # times sitting at his prior while a pick seen thousands of times moves.
    for x in ln_m:
        lam = SHRINK_PICK if x.startswith("P") else SHRINK_PLAYER
        n = wsum[x]
        ln_m[x] *= n / (n + lam)

    # residual diagnostics: how well do real trades balance under the fit?
    resid = []
    for a, b, w in usable:
        sa = sum(prior_value(x, prior, pick_prior) * math.exp(ln_m[x]) for x in a)
        sb = sum(prior_value(x, prior, pick_prior) * math.exp(ln_m[x]) for x in b)
        if sa > 0 and sb > 0:
            resid.append(abs(sa - sb) / max(sa, sb))
    return ln_m, counts, resid


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def shape_key(a, b):
    """Package shape as a canonical (small side, big side) count pair."""
    na, nb = len(a), len(b)
    lo, hi = min(na, nb), max(na, nb)
    return f"{lo}-for-{min(hi, 4)}" + ("+" if hi > 4 else "")


def shape_class(n_recv, n_sent):
    """How a SIDE is shaped: is this manager consolidating or splitting?

    Kept separate from shape_key because acceptance depends on the direction a
    given manager is moving, not on the trade's overall silhouette. Receiving
    fewer, better pieces is a different decision from receiving more, worse ones
    — and real trades price the two differently.
    """
    if n_recv < n_sent:
        return "cons"
    if n_recv > n_sent:
        return "split"
    return "even"


QUANTILES = list(range(0, 101, 5))


def quantize(vals):
    """A sorted value list -> 21 evenly-spaced quantiles (a compact CDF)."""
    if not vals:
        return None
    s = sorted(vals)
    return [round(pct(s, q), 4) for q in QUANTILES]


def build_bucket(corpus, mode, fmt, prior, pick_prior, meta, today_day, log):
    trades, faab_trades = flatten(corpus, mode, fmt)
    tag = f" {mode}/{fmt}"
    if len(trades) < MIN_TRADES_BUCKET:
        log(f"bucket{tag}: only {len(trades)} trades — skipping model (need {MIN_TRADES_BUCKET})")
        return None
    ln_m, counts, resid = solve_values(trades, prior, pick_prior, today_day, log, tag)

    def val(x):
        return prior_value(x, prior, pick_prior) * math.exp(ln_m.get(x, 0.0))

    # ---- fairness bands: how lopsided a REAL accepted trade actually is -----
    gaps, cons_ratio, shapes, pos_moved, by_leg, vetpick_by_leg = [], [], {}, {}, {}, {}
    # Signed surplus, per SIDE: (what I get - what I give) / what I give. This is
    # the acceptance model's whole basis — a manager said yes at this surplus, so
    # an offer's percentile in this distribution IS its acceptance odds. Split by
    # shape class because consolidating and splitting clear at different prices.
    surplus = {"even": [], "cons": [], "split": []}
    pick_share = 0
    for day, leg, a, b in trades:
        sa, sb = sum(val(x) for x in a), sum(val(x) for x in b)
        if sa > 0 and sb > 0:
            surplus[shape_class(len(a), len(b))].append((sa - sb) / sb)
            surplus[shape_class(len(b), len(a))].append((sb - sa) / sa)
        shapes[shape_key(a, b)] = shapes.get(shape_key(a, b), 0) + 1
        by_leg[leg] = by_leg.get(leg, 0) + 1
        has_pick = any(x.startswith("P") for x in a + b)
        if has_pick:
            pick_share += 1
            vetpick_by_leg[leg] = vetpick_by_leg.get(leg, 0) + 1
        for x in a + b:
            if not x.startswith("P"):
                p = (meta.get(x) or {}).get("pos")
                if p in POS_SET:
                    pos_moved[p] = pos_moved.get(p, 0) + 1
        if sa <= 0 or sb <= 0:
            continue
        gaps.append(abs(sa - sb) / max(sa, sb))
        # consolidation: one side sends a package, the other sends one asset.
        # ratio > 1 means the package side paid MORE total value to consolidate.
        if len(a) == 1 and len(b) > 1:
            cons_ratio.append(sb / sa)
        elif len(b) == 1 and len(a) > 1:
            cons_ratio.append(sa / sb)
    gaps.sort()
    cons_ratio.sort()
    resid.sort()
    ntr = len(trades)

    # ---- per-player output --------------------------------------------------
    players = []
    for pid, n in counts.items():
        if pid.startswith("P") or n < MIN_TRADES_PLAYER:
            continue
        base = prior.get(pid)
        if not base:
            continue
        m = math.exp(ln_m.get(pid, 0.0))
        info = meta.get(pid) or {}
        players.append({
            "sleeperId": pid,
            "name": info.get("n") or pid,
            "pos": info.get("pos") or "",
            "team": info.get("tm") or "",
            "fc": round(base),
            "mkt": round(base * m),
            "mult": round(m, 3),
            "n": n,
            # share of all trades in the bucket that touched him — how gettable
            # / how often he is actually in play, which no calculator shows
            "liq": round(n / ntr * 1000, 2),
        })
    players.sort(key=lambda r: -r["mkt"])
    # Reference point for "this player moves a lot". Ship it rather than letting
    # the frontend hardcode a threshold: the raw liq scale drifts as the corpus
    # grows, so any constant baked into the UI would silently go stale.
    liq_p90 = pct(sorted(p["liq"] for p in players), 90) or 1

    picks = {}
    for x, n in counts.items():
        if not x.startswith("P"):
            continue
        picks[x] = {"v": round(val(x)), "prior": round(prior_value(x, prior, pick_prior)),
                    "mult": round(math.exp(ln_m.get(x, 0.0)), 3), "n": n}
    # A pick further out can never be worth MORE than the same round nearer —
    # that is a property of the asset, not something we should let a thin sample
    # overturn (at n=66 the fit briefly had a 2028 1st above a 2027 1st, which
    # reads as broken no matter how honest the noise is). Enforce it downward so
    # the near pick, which always has the bigger sample, is the one we trust.
    for rnd in range(1, MAX_PICK_ROUND + 1):
        cap = None
        for out in range(0, MAX_YEARS_OUT + 1):
            row = picks.get(f"P{out}R{rnd}")
            if not row:
                continue
            if cap is not None and row["v"] > cap:
                row["v"] = cap
                row["capped"] = True
            cap = row["v"]

    tot_shapes = sum(shapes.values()) or 1
    tot_pos = sum(pos_moved.values()) or 1
    return {
        "trades": ntr,
        "trades_with_faab": len(faab_trades),
        "leagues": sum(1 for lg in corpus.get("leagues", {}).values()
                       if lg.get("m") == mode and lg.get("f") == fmt),
        # what "fair" means empirically: the gap distribution of trades that CLEARED
        "fair": {"p25": round(pct(gaps, 25) or 0, 4), "p50": round(pct(gaps, 50) or 0, 4),
                 "p75": round(pct(gaps, 75) or 0, 4), "p90": round(pct(gaps, 90) or 0, 4),
                 "n": len(gaps)},
        # solver quality: how tightly real trades balance under the fitted values
        "resid": {"p50": round(pct(resid, 50) or 0, 4), "p90": round(pct(resid, 90) or 0, 4)},
        "consolidation": {"p50": round(pct(cons_ratio, 50) or 1, 4),
                          "p25": round(pct(cons_ratio, 25) or 1, 4),
                          "p75": round(pct(cons_ratio, 75) or 1, 4), "n": len(cons_ratio)},
        # 21-point CDF (0,5,...,100th percentile) of the surplus a manager
        # accepted, per shape class. The frontend reads an offer's percentile
        # straight off this — that IS the acceptance number.
        "surplus": {k: quantize(v) for k, v in surplus.items() if len(v) >= 40},
        "shapes": {k: round(v / tot_shapes, 4) for k, v in
                   sorted(shapes.items(), key=lambda kv: -kv[1])},
        "pickShare": round(pick_share / ntr, 4),
        "liqP90": round(liq_p90, 3),
        "positions": {k: round(v / tot_pos, 4) for k, v in pos_moved.items()},
        # volume + pick-involvement by week: the deadline curve the Exploit
        # Finder needs to say "this window is closing"
        "byWeek": {str(k): round(v / ntr, 4) for k, v in sorted(by_leg.items())},
        "pickByWeek": {str(k): round(vetpick_by_leg.get(k, 0) / v, 3)
                       for k, v in sorted(by_leg.items()) if v >= 20},
        "picks": dict(sorted(picks.items())),
        "players": players,
    }


def build_comps(corpus, mode, fmt, meta, log):
    """Real packages each player was actually traded for, most recent first.

    Retrieval, not inference: 'seven real leagues sent these three pieces for
    him in the last month' is a stronger argument than any fairness percentage.
    """
    trades, _ = flatten(corpus, mode, fmt)
    by_player = {}
    for day, leg, a, b in trades:
        for side, other in ((a, b), (b, a)):
            if len(side) != 1:
                continue      # only headline-asset deals make a readable comp
            pid = side[0]
            if pid.startswith("P"):
                continue
            by_player.setdefault(pid, []).append((day, other))
    out = {}
    for pid, rows in by_player.items():
        if len(rows) < 2:
            continue
        info = meta.get(pid) or {}
        rows.sort(key=lambda r: -r[0])
        seen, comps = set(), []
        for day, other in rows:
            key = ",".join(sorted(other))
            if key in seen:
                continue
            seen.add(key)
            comps.append({"d": day, "got": [label_asset(x, meta) for x in other]})
            if len(comps) >= COMPS_PER_PLAYER:
                break
        out[pid] = {"name": info.get("n") or pid, "pos": info.get("pos") or "",
                    "n": len(rows), "comps": comps}
    log(f"comps {mode}/{fmt}: {len(out)} players")
    return out


def label_asset(x, meta):
    """Asset id -> human label ('2027 1st', 'Bijan Robinson')."""
    if x.startswith("P") and "R" in x:
        try:
            out = int(x[1:x.index("R")])
            rnd = int(x[x.index("R") + 1:])
        except ValueError:
            return x
        yr = next_rookie_year(time.time() * 1000) + out
        sfx = {1: "1st", 2: "2nd", 3: "3rd"}.get(rnd, f"{rnd}th")
        return f"{yr} {sfx}"
    return (meta.get(x) or {}).get("n") or x


def build_model(corpus, log):
    meta = _load(META_FILE, {})
    if not meta:
        log("WARNING: sleeper_player_meta.json missing — names/positions will be blank")
    priors = load_priors(log)
    today_day = (_today() - dt.date(1970, 1, 1)).days
    buckets, comps = {}, {}
    for mode, fmt in BUCKETS:
        key = f"{mode}_{fmt}"
        b = build_bucket(corpus, mode, fmt, priors[(mode, fmt)],
                         priors.get(("picks", mode, fmt)), meta, today_day, log)
        if b:
            buckets[key] = b
            comps[key] = build_comps(corpus, mode, fmt, meta, log)
            log(f"bucket {key}: {b['trades']} trades · fair p50 {b['fair']['p50']:.3f} "
                f"p90 {b['fair']['p90']:.3f} · consolidation {b['consolidation']['p50']:.3f} "
                f"· {len(b['players'])} players")
    total = sum(len(lg["x"]) for lg in corpus.get("leagues", {}).values())
    model = {
        "source": "aggregated real Sleeper league trades",
        "window_days": WINDOW_DAYS,
        "total_trades": total,
        "total_leagues": len(corpus.get("leagues", {})),
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "buckets": buckets,
    }
    _save(MARKET_FILE, model)
    _save(COMPS_FILE, {"updated": model["updated"], "buckets": comps})
    log(f"wrote {MARKET_FILE} ({total} trades / {model['total_leagues']} leagues)")


def main():
    global MAX_RUN_SECONDS
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-budget", type=int, default=DEF_LEAGUE_BUDGET)
    ap.add_argument("--rebuild-only", action="store_true",
                    help="refit the model from the existing corpus, no crawling")
    ap.add_argument("--seconds", type=int, default=MAX_RUN_SECONDS)
    args = ap.parse_args()

    MAX_RUN_SECONDS = args.seconds

    def log(m):
        print(f"[sleeper-trades] {m}", flush=True)

    state = _load(STATE_FILE, None) or new_state()
    corpus = _load(CORPUS_FILE, None) or {"v": 1, "leagues": {}}

    if not args.rebuild_only:
        t0 = time.time()
        crawl(state, corpus, args.league_budget, log)
        prune(corpus, log)
        state["last_run"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        state["stats"] = {
            "pulled_leagues": len(state.get("pulled", {})),
            "blacklisted": len(state.get("skip", [])),
            "corpus_leagues": len(corpus["leagues"]),
            "corpus_trades": sum(len(lg["x"]) for lg in corpus["leagues"].values()),
            "run_seconds": round(time.time() - t0, 1),
        }
        _save(STATE_FILE, state)
        _save(CORPUS_FILE, corpus)
        log(f"state: {state['stats']}")

    build_model(corpus, log)
    log("done")


if __name__ == "__main__":
    main()
