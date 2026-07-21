# Redraft Strategy — Data Sourcing & Dashboard Plan

_Research date: 2026-07-20. Goal: a "Redraft Strategy" page in the Draft Vault built on
real historical draft-outcome data, à la StatChasers' Redraft Draft Strategy Analysis —
but our own original dashboard, and eventually wired into the live draft experience._

---

## 1. How StatChasers sources it (reverse-engineered)

Their public page `statchasers.com/redraft-draft-strategy/` is currently a **marketing
placeholder** — hero + tagline only, no live dashboard in the DOM (the interactive tool
lives gated inside their "Redraft Command" product). The tagline states the method:

> "Analyze thousands of redraft teams across multiple seasons and league formats to find
> the draft builds that consistently win leagues."

StatChasers is a **Sleeper-ecosystem** tool (Redraft/Dynasty/Commissioner Command). Their
"thousands of redraft teams across multiple seasons" comes from the exact same place our
ADP crawler already pulls from: **the public Sleeper league graph**. They crawl completed
redraft leagues, join each team's **draft** to its **season outcome**, bucket teams into
structural archetypes, and report which builds actually made playoffs / won. Same rookie-
hit-rates methodology they advertise ("real draft outcomes since 2017"), applied to redraft.

**Takeaway:** there is no proprietary data moat here. It's Sleeper crawl + outcome join +
archetype classification. We can source identical (and fresher) data ourselves.

---

## 2. What we already have

`scripts/build_sleeper_adp.py` runs a bounded BFS snowball over the Sleeper league graph on
a 6h cron. Current state (as of research date):

- **14,424 redraft leagues** already discovered and banked in `sleeper_crawl_state.json`
- **119,086 users** in the frontier, 1,442 crawled — the snowball reaches far
- 52,622 dynasty leagues also banked (dynasty-strategy variant is a free follow-on)

**But the ADP corpus is the wrong shape for strategy analysis:**

1. It's **pruned to a 210-day window** → holds mostly current-offseason (2026) drafts. Prior
   completed seasons (2022–2025) get discarded.
2. Picks are **flattened for ADP**: `draft → {player_id: pick_no}`. It throws away *which
   team* drafted *which player* and *which round* — so you cannot reconstruct a roster build.
3. It stores **no outcomes** (wins, playoff finish) — ADP doesn't need them.

So the strategy tool needs a **separate ingest pipeline**, not a tweak to the ADP one. The
crawl *frontier* and the banked league IDs are reusable fuel; the ingest + storage are new.

---

## 3. Feasibility — confirmed against the live Sleeper API

Probed a real completed 2022 redraft league end-to-end. Everything needed is public & keyless:

| Need | Sleeper endpoint | Fields we use |
|---|---|---|
| Team builds | `GET /draft/{id}/picks` | `roster_id`, `draft_slot`, `round`, `pick_no`, `is_keeper`, `player_id`, `metadata.position` |
| Regular-season result | `GET /league/{id}/rosters` | per `roster_id`: `wins`, `losses`, `ties`, `fpts`, `fpts_against`, `ppts` (max/potential pts → lineup efficiency) |
| Playoff / championship | `GET /league/{id}/winners_bracket` | bracket tree → made-playoffs, final placement, champion (by `roster_id`) |
| Format & rules | `GET /league/{id}` | `playoff_week_start`, `playoff_teams`, `roster_positions` (1QB vs SF), scoring settings (PPR/half/std) |
| Prior seasons | `GET /league/{id}` → `previous_league_id` | walk back the chain to 2024→2023→2022 completed instances |

The join key is `roster_id` (consistent across draft picks ↔ rosters ↔ bracket within a
league). `is_keeper` lets us drop keeper picks; we can skip leagues that are keeper-heavy so
"build" reflects the actual draft.

**Conclusion: fully sourceable. No blockers.**

---

## 4. Proposed pipeline — `scripts/build_redraft_strategy.py`

A new cron script (own budget, safe to run alongside the ADP one; can share the frontier
file read-only).

**Ingest, per completed redraft league (walk `previous_league_id` back through finished seasons):**
1. Pull draft picks, rosters, winners_bracket, settings.
2. Reconstruct each of the N teams:
   - positional pick sequence (e.g. `RB,WR,WR,RB,QB,TE,…` by round)
   - draft slot (1..N), format (1QB/SF), scoring (std/half/ppr), team count
   - **outcome**: regular-season win%, points-for percentile in league, made-playoffs (bool),
     final placement, champion (bool)
3. Classify each team into a **structural archetype** from early-round positional capital
   (data-driven thresholds, not vibes):
   - **Zero RB** (0 RB in rounds 1–2, ≤1 in 1–4), **Hero RB** (1 RB in rd 1–2, then WR heavy),
     **Robust/Anchor RB** (≥2 RB in rounds 1–3), **Elite TE early** (TE in rd 1–3),
     **Early QB** (QB in rd 1–4 / by QB1-6 in SF), **Balanced**, **WR-heavy**, etc.
4. Store a **compact per-team record** (not raw picks) to keep the corpus small:
   `{season, teams, slot, fmt, scoring, archetype, firstRB_rd, firstWR_rd, firstQB_rd,
     firstTE_rd, rbCount_r1_6, wrCount_r1_6, winPct, ptsPct, madePlayoffs, placement, champ}`

**Outputs (`data/`), served like the ADP files:**
- `redraft_strategy_archetypes.json` — per (scoring × format × teams): each archetype's
  team count, playoff rate, championship rate, avg win%, avg points percentile, +/- vs league baseline
- `redraft_strategy_position_rounds.json` — "round you took your first RB/WR/QB/TE" → playoff
  rate; playoff-team vs non-playoff-team round distributions (heatmap data)
- `redraft_strategy_by_slot.json` — playoff rate & best archetype **by draft slot** (answers
  "what wins from the 1.05?")
- `redraft_strategy_stats.json` — provenance strip (teams analyzed, leagues, seasons, updated)

**Corpus:** `redraft_strategy_corpus.json` (compact team records) + a `redraft_strategy_state.json`
checkpoint (leagues already ingested) so cron runs accrete. Bounded per-run budget + wall clock,
mirroring the ADP script.

---

## 5. The dashboard — original Vault design (not a clone)

Lives under **Draft Vault**. Differentiators vs StatChasers: it's **slot-aware, format-aware,
and eventually live-draft aware**, and it uses our own onyx/steel-frost DS + Grade Keys language.

**Page: "Redraft Strategy"** (Draft Vault sub-nav)

Controls (top): **Scoring** (Std/Half/PPR) · **Format** (1QB/SF) · **Teams** (8/10/12/14) ·
**Your draft slot** (1..N). Everything below reacts to these.

Sections:
1. **The Winning Builds** — archetype leaderboard: cards ranked by playoff rate, each showing
   championship rate, avg win%, points percentile, and lift-vs-baseline (gradient stat-card
   treatment, meaning-coded: green = beats field, red = trails). "N teams analyzed."
2. **When to draft each position** — heatmap: round (x) × position (first pick of that pos, y),
   colored by playoff rate; overlay playoff-team vs field median markers. Answers "the winners
   took their first RB in round ___."
3. **From your slot** — given the selected draft slot, the archetype that historically wins
   most from *that* seat + the typical first 3–4 positions winners took there.
4. **Provenance strip** — "X,XXX redraft teams · Y leagues · 2022–2025 · updated …" (reuses the
   ADP Explorer provenance pattern).

Optional v2: **Build Simulator** — user clicks a positional sequence and sees the matching
archetype's historical outcome in real time.

---

## 5b. The Personal Decoder — "How your league was actually won" ✅ BUILT

The hook that makes all of the above personal, and the thing no competitor offers.

Enter a Sleeper username → pull that user's **completed 2025 redraft leagues** → rebuild
every manager's draft from `/draft/{id}/picks` → name each leaguemate's build → identify the
champion → and check the winning build against the 14,708-team corpus.

Each league renders as: a verdict line (*"Jared93 won it from the 2nd slot with a Hero RB
build — opened Ja'Marr Chase, Chase Brown, Brock Bowers. League-wide in 2025, Hero RB ran
−1.6 below the field — not proven."*), a second line diagnosing **your own** team, and a full
standings table with every manager's archetype and 4-pick opening.

Why it matters: it converts an aggregate research page into a personal post-mortem, and it
lands the corpus's credibility ("your champ's build is *actually* below average") in the one
context a user cares most about — their own league.

**Runs entirely client-side.** The Sleeper API is public, keyless and CORS-open (verified
from a `file://` origin), so no backend or stored token is required. ~5 requests per league.

⚠️ `classifyJS()` in the page is a hand port of `classify()` in the Python pipeline. They must
stay in sync or the personal and aggregate views will disagree about the same draft.

## 5c. A 2026 projection model — design

### The trap to avoid

The obvious build is "rank the archetypes on last season and recommend the winner." Our own
data says that is actively harmful. Playoff lift by season, PPR:

| Build | 2023 | 2024 | 2025 |
|---|---|---|---|
| Robust RB | +10.5 | +0.7 | +14.0 |
| Balanced | −6.2 | **+4.9** | −1.9 |
| Zero RB | −1.7 | −2.0 | −9.0 |

A "last year's winner" model going into 2025 would have recommended **Balanced** — which
finished 4th of 5. Only Zero RB is stable (consistently bad). **Do not extrapolate archetype
rank.**

### The reframe

Archetypes don't win; **value relative to price** wins. Robust RB won 2025 because running
backs beat their ADP that year, not because RB-heavy is inherently correct. So the model
should project *where the value sits against this year's board*, then derive which build
harvests it. Archetype becomes an output, not an input.

### Architecture

**1 · Price — where players actually go.** `data/adp_sleeper_redraft_{1qb,sf}.json`: 362
players from 416 real 2026 drafts, each with `adp`, `stdev`, `hi`, `lo`. The spread matters
as much as the mean — it is what makes a simulated board fall differently every run.

**2 · Value — what each player returns.** The gap. Options, cheapest first:
  - *ADP-implied*: historical "points scored by ADP slot, by position" curves. Needs a
    historical join we don't have yet (see Missing).
  - *Own projection* off `data/nflverse_stats_*.json` (1999–2025, 27 seasons).
  - *External projections* via the existing lineup-feed cron sources.

**3 · Board — Monte Carlo the draft.** For a given slot and strategy, simulate thousands of
drafts: 11 opponents pick near ADP with noise drawn from each player's own `stdev`, plus
positional need. Your team follows the candidate strategy. Output is a distribution of
rosters, not one roster — which is the honest shape of a draft.

**4 · Outcome — points → playoff odds.** The piece we uniquely already have. `_pts_curve()`
in the pipeline maps points-percentile decile → observed playoff rate across 14,708 real
teams. That is an *empirical* bridge from projected roster strength to playoff probability,
calibrated on actual league outcomes rather than assumed.

**5 · Prior — shrink toward history.** Blend the simulation against historical base rates,
weighted by each archetype's measured `stability`: `durable` findings carry a strong prior,
`mixed` ones lean on the simulation. This stops the model from over-reacting to one season.

### Output

A **slot × strategy grid** — 12 slots × 5 core strategies, each cell a projected playoff
probability with a confidence band. That answers "what should I run, and from where" directly,
and the by-slot cut is the part no competitor publishes.

### The credibility gate: backtest before shipping

Train on 2023–2024, predict 2025, and measure calibration against what actually happened.
Three seasons is enough to run this once. **If it cannot beat "just predict the field
baseline," it does not ship.** A projection tool that dresses up noise is worse than no tool,
and this dataset is exactly the one that would expose it.

### What is missing

1. **2026 player projections** (the real gap).
2. **Historical player→pick→points joins.** The strategy corpus stores positions per round but
   drops `player_id` to stay compact, so we cannot currently ask "what did the RB taken at
   pick 18 actually score." Retaining `player_id` per pick for past seasons and joining to
   nflverse is the one pipeline change that unlocks layer 2.
3. Weekly variance / replacement-level definitions per format.

## 6. Live Draft Vault integration (phase 2)

Once the archetype classifier exists, run it on the *user's in-progress* draft:
- "Your build so far reads **Hero RB** — that archetype has a **58% playoff rate** in 12-team
  half-PPR (vs 50% field)."
- "Teams that won from here usually took **WR next** in this round."
- A live "build health" chip next to the draft board, reusing Grade Keys / gradient language.

This is the payoff: the strategy page teaches, the live hook applies it during the actual draft.

---

## 7. Phasing

- **P0 (data):** `build_redraft_strategy.py` ingest + archetype classifier + 4 output files;
  seed a first corpus from the 14,424 banked redraft leagues (walk to completed seasons).
- **P1 (page):** standalone concept mock (inline tokens, per house rules) → Redraft Strategy
  page shipped under Draft Vault, wired to the JSON outputs.
- **P2 (cron):** add to the existing GitHub Action cadence; provenance grows over time.
- **P3 (live):** archetype chip + "what winners did next" in the live draft board.

---

## 8. Open questions for Jacob

1. **Scope of seasons** — how far back to walk? (2022–2025 is ~4 seasons; more = slower crawl,
   staler player pool but more signal.)
2. **Archetype taxonomy** — start with the ~7 standard ones above, or a specific set you want?
3. **Primary success metric** — playoff rate, championship rate, or points-for percentile as the
   headline number? (Playoff rate is the most robust; championship rate is noisier but sexier.)
4. **Redraft vs dynasty** — build redraft first (this plan), dynasty-startup strategy as a
   follow-on off the same pipeline (52k dynasty leagues already banked)?
