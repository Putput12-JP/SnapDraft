#!/usr/bin/env python3
"""
Build ADP/Value JSON files from FantasyCalc's free public API.

FantasyCalc sources values from REAL Sleeper, MFL, and Fleaflicker trades
— hundreds of thousands of trades, updated continuously. This is as close
to "live Sleeper ADP" as exists in a free, browser-accessible API.

Endpoint:
  GET https://api.fantasycalc.com/values/current?isDynasty={bool}&numQbs={1|2}&numTeams={N}&ppr={0|0.5|1}

Generates files for combinations of:
- isDynasty: true (dynasty) | false (redraft)
- numQbs: 1 (1QB) | 2 (Superflex)
- numTeams: 8 | 10 | 12 | 14
- ppr: 0 (Standard) | 0.5 (Half-PPR) | 1 (Full PPR)

Output: data/adp_{format}_{teams}team.json with same schema as before so
the frontend keeps working unchanged.

USAGE:
  python3 scripts/build_adp_data.py --all
  python3 scripts/build_adp_data.py --format ppr --teams 12
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://api.fantasycalc.com/values/current"

# Frontend format key -> (display label, isDynasty, numQbs, ppr, output basename)
# These map to the existing 6 buttons in the Vault frontend, so no changes needed there.
FORMATS = {
    'standard':  ('Standard',        False, 1, 0,   'standard'),
    'ppr':       ('PPR',             False, 1, 1,   'ppr'),
    'halfppr':   ('Half-PPR',        False, 1, 0.5, 'halfppr'),
    'superflex': ('Superflex / 2QB', False, 2, 1,   'superflex'),
    'dynasty':   ('Dynasty Startup', True,  1, 1,   'dynasty'),
    # FantasyCalc's "dynasty" already factors rookies into the same set.
    # For dynasty rookie-only view, we filter from the dynasty SF list to keep only rookies (years_of_experience == 0).
    'rookie':    ('Dynasty Rookie',  True,  2, 1,   'rookie'),
}

TEAM_SIZES = [8, 10, 12, 14]
USER_AGENT = "Vault-Fantasy/1.0 (+https://putput12-jp.github.io/Vault-Fantasy)"


def fetch_values(is_dynasty, num_qbs, num_teams, ppr, timeout=60):
    """Fetch values from FantasyCalc for a specific combo."""
    ppr_str = str(ppr) if isinstance(ppr, int) else f"{ppr:g}"
    url = f"{API_BASE}?isDynasty={'true' if is_dynasty else 'false'}&numQbs={num_qbs}&numTeams={num_teams}&ppr={ppr_str}"
    print(f"  GET {url}", flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def normalize_name(name):
    return ''.join(c.lower() for c in (name or '') if c.isalnum())


def transform(raw, label, ffc_format_key, teams, format_key):
    """Convert FantasyCalc payload into Vault-friendly schema.

    Maps overallRank → adp so existing frontend code works unchanged.
    """
    transformed = []
    name_index = {}
    for entry in raw:
        player = entry.get('player', {})
        name = (player.get('name') or '').strip()
        if not name:
            continue
        overall_rank = entry.get('overallRank')
        if overall_rank is None:
            continue

        # For rookie view, filter to first-year players only
        if format_key == 'rookie':
            yoe = player.get('maybeYoe')
            if yoe is None or yoe > 0:
                continue

        out = {
            'name': name,
            'pos': player.get('position', ''),
            'team': player.get('maybeTeam') or '',
            'age': player.get('maybeAge'),
            # Map overall rank -> adp so existing UI displays sensibly
            'adp': float(overall_rank),
            'value': entry.get('value'),
            'positionRank': entry.get('positionRank'),
            'trend30Day': entry.get('trend30Day'),
            'redraftValue': entry.get('redraftValue'),
            'sleeperId': player.get('sleeperId'),
            'years_of_experience': player.get('maybeYoe'),
        }
        transformed.append(out)
        name_index[normalize_name(name)] = float(overall_rank)

    # Re-rank within filtered subset (especially for rookies) so adp is dense 1..N
    if format_key == 'rookie':
        transformed.sort(key=lambda x: x['adp'])
        for i, p in enumerate(transformed, start=1):
            p['adp'] = float(i)
            name_index[normalize_name(p['name'])] = float(i)
    else:
        transformed.sort(key=lambda x: x['adp'])

    return {
        'format': ffc_format_key,
        'format_label': label,
        'teams': teams,
        'source': 'fantasycalc.com (real Sleeper/MFL/Fleaflicker trades)',
        'count': len(transformed),
        'players': transformed,
        'name_to_adp': name_index,
    }


# ── Real draft ADP from Fantasy Football Calculator ─────────────────
# FantasyCalc (above) gives trade-VALUE ranks, not true draft position.
# Fantasy Football Calculator (a different site) publishes real fractional
# ADP from thousands of live redraft drafts, incl. a round.pick string
# ("1.02"), a high/low range, stdev and bye. No CORS, so we merge it here
# (server-side) into the redraft files; the browser reads our CORS-ok data.
FFC_API = "https://fantasyfootballcalculator.com/api/v1/adp"
# our format_key -> FFC endpoint slug. Redraft 1QB only: FFC has no dynasty ADP,
# and our 'superflex' file doubles as the dynasty-SF ADP source, so we leave it
# on FantasyCalc to avoid mixing redraft ADP into a dynasty context.
FFC_FMT = {'standard': 'standard', 'ppr': 'ppr', 'halfppr': 'half-ppr'}


def fetch_ffc(ffc_slug, teams, year, timeout=60):
    url = f"{FFC_API}/{ffc_slug}?teams={teams}&year={year}"
    print(f"  GET {url}", flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def enrich_ffc(transformed, format_key, teams):
    """Merge Fantasy Football Calculator's real ADP into a redraft file.
    Adds adpReal (fractional) / adpFmt ("1.02") / adpHigh / adpLow / adpStdev
    / adpDrafts / bye per matched player. Returns match count (0 = skipped)."""
    ffc_slug = FFC_FMT.get(format_key)
    if not ffc_slug:
        return 0
    year = datetime.date.today().year
    data = None
    for y in (year, year - 1):  # current season, fall back to last
        try:
            d = fetch_ffc(ffc_slug, teams, y)
            if d.get('players'):
                data = d
                break
        except Exception as e:
            print(f"  → FFC {ffc_slug} {y} err: {e}", file=sys.stderr, flush=True)
    if not data:
        return 0
    idx = {normalize_name(p.get('name')): p for p in data['players']}
    matched = 0
    for p in transformed['players']:
        f = idx.get(normalize_name(p['name']))
        if not f:
            continue
        p['adpReal'] = f.get('adp')
        p['adpFmt'] = f.get('adp_formatted')
        p['adpHigh'] = f.get('high')
        p['adpLow'] = f.get('low')
        p['adpStdev'] = f.get('stdev')
        p['adpDrafts'] = f.get('times_drafted')
        if f.get('bye'):
            p['bye'] = f.get('bye')
        matched += 1
    meta = data.get('meta', {}) or {}
    transformed['adp_real_source'] = (
        f"fantasyfootballcalculator.com · {meta.get('total_drafts', '?')} drafts "
        f"({meta.get('start_date', '?')}–{meta.get('end_date', '?')})"
    )
    return matched


# ── ESPN live draft ADP ──────────────────────────────────────────────
# ESPN's (undocumented but stable) fantasy read API exposes ownership data
# incl. averageDraftPosition from real ESPN drafts. Like FFC there's no CORS,
# so we merge server-side. Redraft only; ESPN has no half-PPR league default,
# so half-PPR reuses the PPR draft pool.
ESPN_API = ("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
            "seasons/{year}/segments/0/leaguedefaults/{league}?view=kona_player_info")
ESPN_FMT = {'standard': 1, 'ppr': 3, 'halfppr': 3}


def fetch_espn(league_id, year, timeout=60):
    url = ESPN_API.format(year=year, league=league_id)
    print(f"  GET {url}", flush=True)
    filt = json.dumps({'players': {'limit': 400,
                                   'sortAdp': {'sortPriority': 1, 'sortAsc': True}}})
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT,
                                               'x-fantasy-filter': filt,
                                               'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


_espn_cache = {}  # league_id -> name index (ESPN ADP is team-count independent)


def enrich_espn(transformed, format_key):
    """Merge ESPN live draft ADP into a redraft file. Adds adpEspn (fractional
    overall pick) per matched player. Returns match count (0 = skipped)."""
    league = ESPN_FMT.get(format_key)
    if not league:
        return 0
    idx = _espn_cache.get(league)
    if idx is None:
        year = datetime.date.today().year
        data = None
        for y in (year, year - 1):  # current season, fall back to last
            try:
                d = fetch_espn(league, y)
                if d.get('players'):
                    data = d
                    break
            except Exception as e:
                print(f"  → ESPN league {league} {y} err: {e}", file=sys.stderr, flush=True)
        if not data:
            return 0
        idx = {}
        for entry in data['players']:
            pl = entry.get('player') or {}
            adp = (pl.get('ownership') or {}).get('averageDraftPosition')
            name = (pl.get('fullName') or '').strip()
            if name and adp:
                idx[normalize_name(name)] = adp
        _espn_cache[league] = idx
    matched = 0
    for p in transformed['players']:
        adp = idx.get(normalize_name(p['name']))
        if adp is None:
            continue
        p['adpEspn'] = round(adp, 1)
        matched += 1
    transformed['adp_espn_source'] = f"espn.com fantasy · live draft ADP · {len(idx)} players"
    return matched


# ── ADP history / trend snapshotting ────────────────────────────────
# FantasyCalc only exposes a 30-day *value* trend, not positional-ADP
# movement over 7/30/90 days. To power the board's 7/30/90-day change view
# we snapshot each day's ADP (overall rank) into a rolling history file and
# diff against the most recent snapshot that is at least N days old.

HISTORY_WINDOWS = (7, 30, 90)
HISTORY_KEEP_DAYS = 120  # prune snapshots older than this


def _player_key(p):
    """Stable identity for a player across daily snapshots."""
    sid = p.get('sleeperId')
    if sid:
        return f"s{sid}"
    return f"n{normalize_name(p.get('name'))}"


def annotate_trends(transformed, out_dir, basename, teams, today=None):
    """Append today's ADP snapshot to the rolling history file and annotate
    each player with adpDelta7 / adpDelta30 / adpDelta90 (None until enough
    history exists). Positive = player moved UP the board (rank got smaller).
    """
    today = today or datetime.date.today()
    hist_path = os.path.join(out_dir, f'adp_history_{basename}_{teams}team.json')

    hist = {'snapshots': []}
    if os.path.exists(hist_path):
        try:
            with open(hist_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and isinstance(loaded.get('snapshots'), list):
                hist = loaded
        except (ValueError, OSError):
            pass  # corrupt/missing history — start fresh

    today_iso = today.isoformat()
    ranks_today = {_player_key(p): p['adp'] for p in transformed['players']}
    # Also snapshot FFC real draft ADP and ESPN ADP (fractional pick numbers)
    # when present, so the frontend can show true ADP movement over time.
    real_today = {_player_key(p): p['adpReal'] for p in transformed['players']
                  if p.get('adpReal') is not None}
    espn_today = {_player_key(p): p['adpEspn'] for p in transformed['players']
                  if p.get('adpEspn') is not None}

    # Replace any existing snapshot for today, then prune old ones.
    snaps = [s for s in hist['snapshots'] if s.get('date') != today_iso]
    snap = {'date': today_iso, 'ranks': ranks_today}
    if real_today:
        snap['ranksReal'] = real_today
    if espn_today:
        snap['ranksEspn'] = espn_today
    snaps.append(snap)
    cutoff = (today - datetime.timedelta(days=HISTORY_KEEP_DAYS)).isoformat()
    snaps = [s for s in snaps if s.get('date', '') >= cutoff]
    snaps.sort(key=lambda s: s.get('date', ''))
    hist['snapshots'] = snaps

    # For each window, find the most recent snapshot that is >= N days old.
    past_for_window = {}
    past_real_for_window = {}
    past_espn_for_window = {}
    for n in HISTORY_WINDOWS:
        boundary = (today - datetime.timedelta(days=n)).isoformat()
        eligible = [s for s in snaps if s.get('date', '') <= boundary]
        past_for_window[n] = eligible[-1]['ranks'] if eligible else None
        # FFC / ESPN ADP for the same window (older snapshots may predate them)
        real_eligible = [s for s in eligible if s.get('ranksReal')]
        past_real_for_window[n] = real_eligible[-1]['ranksReal'] if real_eligible else None
        espn_eligible = [s for s in eligible if s.get('ranksEspn')]
        past_espn_for_window[n] = espn_eligible[-1]['ranksEspn'] if espn_eligible else None

    for p in transformed['players']:
        key = _player_key(p)
        for n in HISTORY_WINDOWS:
            past = past_for_window[n]
            delta = None
            if past is not None and key in past:
                # positive => rank decreased => moved up the board
                delta = round(past[key] - p['adp'], 1)
            p[f'adpDelta{n}'] = delta
            past_real = past_real_for_window[n]
            rdelta = None
            if past_real is not None and p.get('adpReal') is not None and key in past_real:
                # positive => real ADP got earlier => player is rising
                rdelta = round(past_real[key] - p['adpReal'], 1)
            p[f'adpRealDelta{n}'] = rdelta
            past_espn = past_espn_for_window[n]
            edelta = None
            if past_espn is not None and p.get('adpEspn') is not None and key in past_espn:
                edelta = round(past_espn[key] - p['adpEspn'], 1)
            p[f'adpEspnDelta{n}'] = edelta

    os.makedirs(out_dir, exist_ok=True)
    with open(hist_path, 'w') as f:
        json.dump(hist, f, separators=(',', ':'))
    return hist_path


def build_one(format_key, teams, out_dir):
    if format_key not in FORMATS:
        raise ValueError(f"Unknown format: {format_key}")
    label, is_dynasty, num_qbs, ppr, basename = FORMATS[format_key]
    out_path = os.path.join(out_dir, f'adp_{basename}_{teams}team.json')
    print(f"\n[{format_key} · {teams}-team]", flush=True)
    try:
        raw = fetch_values(is_dynasty, num_qbs, teams, ppr)
    except urllib.error.HTTPError as e:
        print(f"  → ERROR {e.code}: {e.reason}", file=sys.stderr, flush=True)
        return ('err', 0)

    transformed = transform(raw, label, format_key, teams, format_key)
    if not transformed['players']:
        print(f"  → SKIP (empty player list)", flush=True)
        return ('skip', 0)

    # Merge real draft ADP from Fantasy Football Calculator (redraft formats).
    try:
        m = enrich_ffc(transformed, format_key, teams)
        if m:
            print(f"  → FFC real ADP merged for {m} players", flush=True)
    except Exception as e:
        print(f"  → WARN: FFC enrich failed: {e}", file=sys.stderr, flush=True)

    # Merge ESPN live draft ADP (redraft formats).
    try:
        m = enrich_espn(transformed, format_key)
        if m:
            print(f"  → ESPN ADP merged for {m} players", flush=True)
    except Exception as e:
        print(f"  → WARN: ESPN enrich failed: {e}", file=sys.stderr, flush=True)

    # Snapshot today's ADP and annotate 7/30/90-day movement.
    try:
        annotate_trends(transformed, out_dir, basename, teams)
    except Exception as e:
        print(f"  → WARN: trend snapshot failed: {e}", file=sys.stderr, flush=True)

    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(transformed, f, separators=(',', ':'))
    size_kb = os.path.getsize(out_path) / 1024
    print(f"  → {out_path} · {transformed['count']} players · {size_kb:.1f} KB", flush=True)
    return ('ok', size_kb)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--all', action='store_true',
                   help='Build all combos (6 formats × 4 team sizes = 24 files)')
    p.add_argument('--format', choices=list(FORMATS.keys()),
                   help='Specific format to build')
    p.add_argument('--teams', type=int, choices=TEAM_SIZES,
                   help='Specific team size')
    p.add_argument('--out-dir', default='data',
                   help='Output directory (default: data)')
    p.add_argument('--sleep', type=float, default=1.0,
                   help='Seconds to wait between requests (default: 1.0)')
    args = p.parse_args()

    if not args.all and not args.format:
        print("ERROR: specify --all or --format FORMAT", file=sys.stderr)
        sys.exit(1)

    combos = []
    if args.all:
        for fk in FORMATS:
            for t in TEAM_SIZES:
                combos.append((fk, t))
    elif args.format and args.teams:
        combos.append((args.format, args.teams))
    elif args.format:
        for t in TEAM_SIZES:
            combos.append((args.format, t))

    results = []
    for fk, teams in combos:
        try:
            status, size = build_one(fk, teams, args.out_dir)
            results.append((fk, teams, status, size))
        except Exception as e:
            print(f"  → ERROR: {e}", file=sys.stderr, flush=True)
            results.append((fk, teams, 'err', 0))
        time.sleep(args.sleep)

    print("\n" + "=" * 60)
    print("SUMMARY (source: FantasyCalc — real Sleeper/MFL/Fleaflicker trades)")
    print("=" * 60)
    print(f"{'Format':<12}{'Teams':<8}{'Status':<10}{'KB':<8}")
    total_kb = 0
    ok_count = 0
    for fk, teams, status, kb in results:
        marker = '✓' if status == 'ok' else ('-' if status == 'skip' else '✗')
        print(f"{fk:<12}{teams:<8}{marker} {status:<8}{kb:<8.1f}")
        total_kb += kb
        if status == 'ok':
            ok_count += 1
    print(f"\nGenerated {ok_count}/{len(results)} files · {total_kb:.1f} KB total")

    if any(r[2] == 'err' for r in results):
        sys.exit(1)


if __name__ == '__main__':
    main()
