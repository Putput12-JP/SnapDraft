#!/usr/bin/env python3
"""Backfill the drafted PLAYERS for every league already in the redraft strategy corpus.

The strategy corpus stores each team's build as positions-per-round and drops player_id to
stay compact. That makes one question unanswerable: what did the teams running a given build
actually *look like* — their Upside / Floor / Risk profile — as opposed to what a simulated
2026 roster would look like. Grading a hypothetical roster off the current board returns
implausibly uniform grades; grading the real historical teams does not.

This is a BACKFILL, not a re-crawl. It only works because the corpus now stores `lid`/`rid`
(added when the winners_bracket fix forced a rebuild), so drafted players can be joined onto
outcome rows that already exist. Cost is 2 requests per league instead of a fresh 5-endpoint
crawl: ~17k requests for ~8.5k leagues rather than ~3.5 hours.

Output: data/redraft_strategy_picks.json
    {"players": {pid: [name, pos]},
     "leagues": {lid: {rid: [[round, pid], ...]}}}
Players are stored once in a shared map; the per-roster lists carry ids only, which keeps a
~1.4M-pick file in the low tens of MB rather than repeating names a million times.

Checkpoint: data/redraft_strategy_picks_state.json — safe to interrupt and resume.
"""
import json, os, sys, time, argparse, urllib.request, urllib.error, gzip

API = "https://api.sleeper.app/v1"
UA = "Vault-Fantasy/1.0 (+https://putput12-jp.github.io/Vault-Fantasy)"
DATA = "data"
CORPUS = "redraft_strategy_corpus.json.gz"   # gzipped by build_redraft_strategy.py
OUT = "redraft_strategy_picks.json"
STATE = "redraft_strategy_picks_state.json"
REQ_MIN_INTERVAL = 0.08
MAX_ROUNDS = 16          # builds are decided long before this; caps file size
SAVE_EVERY = 250         # leagues between checkpoint writes
FAIL_ABORT = 25

_last = [0.0]

class FetchError(Exception):
    """Never got an answer. Same contract as the crawler: a transient failure must not be
    recorded as 'this league has no picks', which is the class of bug the bracket fix cured."""

def _get(path, tries=4):
    url = f"{API}/{path}"
    for attempt in range(tries):
        wait = REQ_MIN_INTERVAL - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8")
                if not raw or raw == "null":
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1)); continue
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(1.0 * (attempt + 1))
        except json.JSONDecodeError:
            return None
    raise FetchError(path)

def _load(p, d):
    f = os.path.join(DATA, p)
    if not os.path.exists(f) and f.endswith(".gz") and os.path.exists(f[:-3]):
        f = f[:-3]                       # pre-gzip corpus, if present
    if os.path.exists(f):
        try:
            with (gzip.open(f, "rt") if f.endswith(".gz") else open(f)) as fh: return json.load(fh)
        except (json.JSONDecodeError, OSError): pass
    return d

def _save(p, o):
    os.makedirs(DATA, exist_ok=True)
    f = os.path.join(DATA, p); t = f + ".tmp"
    with open(t, "w") as fh: json.dump(o, fh, separators=(",", ":"))
    os.replace(t, f)

def league_picks(lid):
    """-> {rid: [[round, pid], ...]}, and the pid->[name,pos] pairs seen."""
    drafts = _get(f"league/{lid}/drafts") or []
    if not drafts:
        return None, {}
    draft = max(drafts, key=lambda d: (d.get("settings") or {}).get("rounds") or 0)
    picks = _get(f"draft/{draft['draft_id']}/picks") or []
    if not picks:
        return None, {}
    by, names = {}, {}
    for pk in picks:
        if pk.get("is_keeper"):
            continue
        rid = pk.get("roster_id"); pid = pk.get("player_id")
        rnd = pk.get("round") or 0
        if rid is None or not pid or not rnd or rnd > MAX_ROUNDS:
            continue
        md = pk.get("metadata") or {}
        pos = md.get("position") or ""
        if pos not in ("QB", "RB", "WR", "TE"):
            continue
        nm = " ".join(x for x in [md.get("first_name"), md.get("last_name")] if x).strip()
        if nm:
            names[pid] = [nm, pos]
        by.setdefault(str(rid), []).append([rnd, pid])
    for v in by.values():
        v.sort(key=lambda x: x[0])
    return by, names

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-seconds", type=int, default=10500)
    ap.add_argument("--limit", type=int, default=0, help="stop after N leagues (testing)")
    args = ap.parse_args()

    corpus = _load(CORPUS, None)
    if not corpus or not corpus.get("teams"):
        print("no corpus — run build_redraft_strategy.py first"); sys.exit(1)
    if "lid" not in corpus["teams"][0]:
        print("corpus has no `lid` — this backfill needs the rebuilt corpus"); sys.exit(1)

    want = []
    seen = set()
    for t in corpus["teams"]:
        l = t["lid"]
        if l not in seen:
            seen.add(l); want.append(l)

    out = _load(OUT, {"players": {}, "leagues": {}})
    st = _load(STATE, {"done": [], "empty": []})
    done = set(st["done"]) | set(st["empty"])
    todo = [l for l in want if l not in done]
    print(f"corpus: {len(corpus['teams'])} teams / {len(want)} leagues | "
          f"already backfilled: {len(done)} | to do: {len(todo)}")

    t0 = time.time(); n = 0; fails = 0; consec = 0
    for lid in todo:
        if time.time() - t0 > args.max_seconds:
            print("time cap reached"); break
        if args.limit and n >= args.limit:
            break
        try:
            by, names = league_picks(lid)
        except FetchError as e:
            fails += 1; consec += 1
            if consec >= FAIL_ABORT:
                print(f"aborting — {consec} consecutive fetch failures (last {e})"); break
            continue
        consec = 0; n += 1
        if by:
            out["leagues"][lid] = by
            out["players"].update(names)
            st["done"].append(lid)
        else:
            st["empty"].append(lid)
        if n % SAVE_EVERY == 0:
            _save(OUT, out); _save(STATE, st)
            print(f"  ...{n}/{len(todo)} leagues, {len(out['leagues'])} with picks, "
                  f"{len(out['players'])} distinct players, {fails} deferred")
    _save(OUT, out); _save(STATE, st)
    tot = sum(len(v) for lg in out["leagues"].values() for v in lg.values())
    print(f"done: {len(out['leagues'])} leagues, {len(out['players'])} players, "
          f"{tot} roster-picks | deferred {fails} | "
          f"{os.path.getsize(os.path.join(DATA, OUT))/1e6:.1f} MB")

if __name__ == "__main__":
    main()
