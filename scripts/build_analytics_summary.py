#!/usr/bin/env python3
"""
Build data/analytics_summary.json from the GA4 Data API.

Feeds the self-hosted admin dashboard (analytics.html). Same "fetch a static
JSON, fall back gracefully" contract as every other Vault data feed: if the
GA4 credentials aren't configured this script exits 0 WITHOUT writing, so a
missing secret never clobbers an existing file or breaks the cron.

Activation (one-time, in the repo's GitHub Actions secrets):
  GA4_PROPERTY_ID  numeric GA4 property id, e.g. "371XXXXXX"
                   (GA4 Admin -> Property Settings -> Property ID; NOT the
                    G-XXXX measurement id)
  GA4_SA_JSON      full JSON key of a Google Cloud service account that has
                   been granted "Viewer" on that GA4 property
                   (GA4 Admin -> Property Access Management -> add the service
                    account's email as Viewer)

Local run:  GA4_PROPERTY_ID=... GA4_SA_JSON="$(cat sa.json)" python3 scripts/build_analytics_summary.py
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "analytics_summary.json")

# The custom events wired into index.html (vfTrack). Order here drives the
# "Top events" list; unknown events GA4 returns are ignored.
CUSTOM_EVENTS = [
    "league_viewed", "draft_connected", "trade_idea_applied",
    "season_sim_run", "sleeper_connected", "sleeper_write",
    "share_card_created", "landing_from_share",
]

RANGE_DAYS = 30


def _client_and_property():
    """Return (BetaAnalyticsDataClient, 'properties/<id>') or (None, None) if unconfigured."""
    prop = os.environ.get("GA4_PROPERTY_ID", "").strip()
    sa_json = os.environ.get("GA4_SA_JSON", "").strip()
    if not prop:
        print("GA4_PROPERTY_ID not set — skipping (no file written).")
        return None, None
    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.oauth2 import service_account
    except ImportError:
        print("google-analytics-data not installed — skipping.", file=sys.stderr)
        return None, None

    if sa_json:
        try:
            info = json.loads(sa_json)
        except json.JSONDecodeError as e:
            print(f"GA4_SA_JSON is not valid JSON: {e}", file=sys.stderr)
            return None, None
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/analytics.readonly"]
        )
        client = BetaAnalyticsDataClient(credentials=creds)
    else:
        # Fall back to Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).
        client = BetaAnalyticsDataClient()

    prop_path = prop if prop.startswith("properties/") else f"properties/{prop}"
    return client, prop_path


def _run(client, prop, dims, metrics, start, end, order_metric=None, limit=None):
    from google.analytics.data_v1beta.types import (
        RunReportRequest, DateRange, Dimension, Metric, OrderBy,
    )
    req = RunReportRequest(
        property=prop,
        date_ranges=[DateRange(start_date=start, end_date=end)],
        dimensions=[Dimension(name=d) for d in dims],
        metrics=[Metric(name=m) for m in metrics],
        limit=limit or 250,
    )
    if order_metric:
        req.order_bys = [OrderBy(metric=OrderBy.MetricOrderBy(metric_name=order_metric), desc=True)]
    return client.run_report(req)


def _scalar(client, prop, metric, start, end):
    r = _run(client, prop, [], [metric], start, end)
    if not r.rows:
        return 0
    return int(float(r.rows[0].metric_values[0].value))


def _delta(cur, prev):
    if not prev:
        return None
    return round((cur - prev) / prev * 100, 1)


def build():
    client, prop = _client_and_property()
    if client is None:
        return None

    today = datetime.now(timezone.utc).date()
    cur_start = f"{RANGE_DAYS - 1}daysAgo"
    cur_end = "today"
    prev_start = f"{2 * RANGE_DAYS - 1}daysAgo"
    prev_end = f"{RANGE_DAYS}daysAgo"

    # --- KPI scalars (current vs previous period) ---
    def kpi(metric):
        cur = _scalar(client, prop, metric, cur_start, cur_end)
        prev = _scalar(client, prop, metric, prev_start, prev_end)
        return {"value": cur, "delta_pct": _delta(cur, prev)}

    active_users = kpi("activeUsers")
    sessions = kpi("sessions")

    # --- event counts by name (current + previous, for deltas) ---
    def event_counts(start, end):
        r = _run(client, prop, ["eventName"], ["eventCount"], start, end,
                 order_metric="eventCount")
        return {row.dimension_values[0].value: int(float(row.metric_values[0].value))
                for row in r.rows}

    ev_cur = event_counts(cur_start, cur_end)
    ev_prev = event_counts(prev_start, prev_end)

    def ev_kpi(name):
        cur = ev_cur.get(name, 0)
        return {"value": cur, "delta_pct": _delta(cur, ev_prev.get(name, 0))}

    kpis = {
        "active_users": active_users,
        "sessions": sessions,
        "drafts_connected": ev_kpi("draft_connected"),
        "sleeper_writes": ev_kpi("sleeper_write"),
        "landings_from_share": ev_kpi("landing_from_share"),
    }

    # --- Top events (our custom set, current period) ---
    events = []
    for name in CUSTOM_EVENTS:
        n = ev_cur.get(name, 0)
        if n:
            events.append({"name": name, "n": n, "delta_pct": _delta(n, ev_prev.get(name, 0))})
    events.sort(key=lambda e: e["n"], reverse=True)

    # --- Daily sessions (last 30d) ---
    r = _run(client, prop, ["date"], ["sessions", "activeUsers"], cur_start, cur_end)
    daily = sorted(
        [{"date": row.dimension_values[0].value,
          "sessions": int(float(row.metric_values[0].value)),
          "users": int(float(row.metric_values[1].value))} for row in r.rows],
        key=lambda d: d["date"],
    )

    # --- Devices ---
    r = _run(client, prop, ["deviceCategory"], ["sessions"], cur_start, cur_end,
             order_metric="sessions")
    devices = [{"name": row.dimension_values[0].value.title(),
                "v": int(float(row.metric_values[0].value))} for row in r.rows]

    # --- Activation funnel (approximated from event/session counts) ---
    visited = sessions["value"]
    engine = ev_cur.get("trade_idea_applied", 0) + ev_cur.get("season_sim_run", 0)
    funnel = [
        {"name": "Visited Vault", "n": visited},
        {"name": "Viewed a league", "n": ev_cur.get("league_viewed", 0)},
        {"name": "Used an engine (trade / sim)", "n": engine},
        {"name": "Connected Sleeper", "n": ev_cur.get("sleeper_connected", 0)},
        {"name": "Pushed a write to Sleeper", "n": ev_cur.get("sleeper_write", 0)},
    ]

    # --- Share loop ---
    created = ev_cur.get("share_card_created", 0)
    landings = ev_cur.get("landing_from_share", 0)
    share = {
        "created": created,
        "landings": landings,
        # landings-per-100-shares; a rough virality read, not a strict per-user rate
        "landings_per_100": round(landings / created * 100, 1) if created else None,
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "range_days": RANGE_DAYS,
        "configured": True,
        "kpis": kpis,
        "sessions_daily": daily,
        "events": events,
        "devices": devices,
        "funnel": funnel,
        "share": share,
    }


def main():
    summary = build()
    if summary is None:
        return 0  # unconfigured — leave any existing file untouched
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"Wrote {OUT_PATH}: {summary['kpis']['sessions']['value']} sessions, "
          f"{len(summary['events'])} events, {summary['share']['landings']} share landings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
