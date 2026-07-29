# The Trade Market model — training the Trade Engines on real trades

_Vault Fantasy · July 2026_

The Trade Engines (Matchmaker / Exploit Finder / Idea Generator) shipped on invented
constants: a flat ±18% "fair" band, a hand-written `PICK_VALUES` table, and an acceptance
score assembled from guessed penalties (−18 for asking a crown jewel, +10 for timeline fit).
None of it had ever seen a trade.

We already crawl ~110k real Sleeper leagues for ADP. Those leagues execute trades, and
Sleeper serves them for free. This doc records what we harvest, how the model is fit, what
it found, and which numbers to distrust.

---

## 1. The pipeline

`scripts/build_sleeper_trades.py` → `data/trade_market.json` + `data/trade_comps.json`,
refreshed by `.github/workflows/update-sleeper-trades.yml` every 6 hours.

**Discovery is free.** League IDs come straight out of the ADP crawler's
`data/sleeper_crawl_state.json` (82k dynasty + 27k redraft). No new graph walking.

**Harvest.** `GET /league/<lid>/transactions/<leg>` for leg 1..18. Two things make this
affordable:

- **Leg == NFL week, and every offseason trade lands in leg 1.** A league that hasn't
  kicked off costs 2 requests, not 18.
- Leagues whose season is entirely behind the recency window get blacklisted, so we never
  pay for them twice.

Roughly 1 league/second at a polite 850 req/min, ~4.7 trades per league.

**Normalization.** Each completed 2-team trade becomes two sides of asset IDs:

| Asset | ID |
|---|---|
| Player | Sleeper `player_id` |
| Pick | `P<yearsOut>R<round>` |

`yearsOut` is measured from the **next rookie draft as of the trade date**, not from the
literal season. Rookie drafts run in May, so a "2027 1st" traded in Aug 2026 and one traded
in Feb 2027 are the same asset. Keying on the season string would split it in two and halve
the sample on every pick in the corpus.

Excluded from the value fit (but still counted for shapes and timing): 3-team trades (no
two-sided balance equation), one-sided salary dumps, and trades containing FAAB (real value
we cannot price, which would teach the solver that someone gave a player away).

---

## 2. Fitting values

Every accepted trade is evidence that its two sides were priced about equally **by the
people who actually made it**. We hold a FantasyCalc prior and learn a multiplier on top,
in log space:

```
e = ln(Σ value of side B) − ln(Σ value of side A)
```

and nudge every asset on A up by `η·e·share`, every asset on B down by the same —
share-weighted, so a 5% throw-in doesn't absorb a stud's correction. The per-trade residual
is winsorized so one fleecing can't dominate, trades are recency-weighted on a 200-day
half-life, and multipliers are clamped to [⅓, 3].

**Shrinkage happens once, at the end**, not per epoch:

```
ln_m ← ln_m · n/(n + λ)        λ = 30 players, 8 picks
```

Shrinking inside the loop re-shrinks an already-shrunk estimate every pass, so the fixed
point ends up a property of the update rule rather than of the evidence. Applying it once
means the solver converges to what the trades say, and only then do we discount by how much
evidence there was. This is what keeps a player seen three times sitting at his prior while
a pick seen 650 times moves freely — and it is why **the model is deliberately boring early
and gets sharper as the corpus grows**.

The output is not another value column. It is the **gap** between what a calculator says and
what leagues pay, which only exists because we have both numbers.

---

## 3. What it found

From the first clean fit (2.2k dynasty-superflex trades — thin, treat as directional):

### `PICK_VALUES` was inflated by ~60%, and the fit is validated

The first fit put a 1st one year out at roughly **half** the hand table's number, which
looked like a solver bug. It wasn't. FantasyCalc publishes pick rows in the same value
list we already fetch — they carry no `sleeperId`, which is why they were being skipped —
so there is an independent, market-derived source to check against:

| Asset | FantasyCalc | Our fit | `PICK_VALUES` (hand) |
|---|---|---|---|
| 2027 1st Mid | 2957 | 2792 | 3800 |
| 2027 2nd | 1535 | 1521 | 1700 |
| 2028 1st | 2131 | 2018 | 3400 |
| 2029 1st | 1858 | 1729 | 3000 |

Our fit lands within **0.93–1.04×** of FantasyCalc on every pick. The two independent
real-trade sources agree with each other and disagree with the hand table, which is ~60%
high on future 1sts. **`PICK_VALUES` in `index.html` is the thing that was wrong.** It is
now only the fallback when the model hasn't loaded, and the pipeline's prior is
FantasyCalc's pick rows rather than a table we made up.

Against that corrected prior, real Sleeper leagues still pay a consistent small **discount**
for picks (multipliers 0.87–0.99 near-term, ~0.79 two years out) — managers discount unseen
picks a bit more than the calculator does, but nothing like 2×.

### Real trades are not fair

The median dynasty trade lands **~24% apart** on market values; the 90th percentile is 59%.
The old ±18% band was not merely arbitrary, it was tighter than the *median* real trade — so
the Matchmaker was rejecting shapes the market makes every day.

This is worth sitting with rather than smoothing away: most trades people actually make are
not "fair" by any calculator.

### The consolidation premium is real and large

In real 1-for-N trades, the side sending the package pays a **median 1.32× the total value**
it receives. Consolidating into one better player costs about a third more than the raw
numbers suggest. A symmetric ±band is structurally incapable of seeing this.

It shows up cleanly in the surplus CDFs: a manager consolidating accepts a **median −19%**
surplus, one splitting demands **+23%**.

### Package shapes are nothing like uniform

| Shape | Share |
|---|---|
| 1-for-1 | 25% |
| 1-for-2 | 24% |
| 2-for-2 | 13% |
| 2-for-3 | 10% |
| 1-for-3 | 9% |

The Idea Generator was sampling its four shapes uniformly. Lopsided-count deals are the
majority of the market. 80% of dynasty superflex trades involve at least one pick.

### Player-level dislocations are actionable

Aging producers trade **above** their dynasty book value (Keenan Allen 1.23×, Joe Flacco
1.22×) — dynasty calculators crush old players harder than real managers do. Hyped rookie
QBs trade **below** it (Tyler Shough 0.83×, Shedeur Sanders 0.88×). That gap is the entire
basis of the new market-dislocation exploits.

---

## 4. What the engines now do differently

| | Before | After |
|---|---|---|
| **Fair band** | flat ±18% | median real gap (Matchmaker), p75 (Ideas) |
| **Acceptance** | 50 + 2.2×surplus, guessed penalties | percentile in the CDF of surpluses real managers accepted, conditioned on shape class |
| **Pick values** | hand table | fitted, with Early/Mid/Late kept as a ratio |
| **Matchmaker** | fairness + fit | + the receipt: real packages other leagues sent for this player |
| **Exploit Finder** | timing only (age ≥ 27, contender/rebuilder) | + market dislocation: where real prices and the calculator disagree |
| **Idea Generator** | 4 shapes, uniform | shapes drawn at their real frequency |

The two shape-derived acceptance penalties are **halved** once the fitted base is in play,
because the surplus CDF is already conditioned on shape class and charging twice buries
every package deal. The roster-context terms (crown jewel, timeline, positional need) stay
at full strength — the corpus cannot see those.

Everything degrades cleanly: every getter returns `null` until `trade_market.json` lands, and
callers fall back to the old constants. A cold cache costs nothing.

---

## 5. Known limits

- **Sample.** Day one is ~2k trades per bucket. Player multipliers are heavily shrunk and
  mostly sit at the prior; picks (hundreds of samples each) are already trustworthy. The
  cron adds ~4k trades per run.
- **Redraft buckets are empty** until the crawl reaches enough redraft leagues; they borrow
  dynasty and the provenance line says so.
- **No rejected offers.** We only see trades that cleared, so "acceptance" is really *"how
  generous is this versus deals that got done"* — a percentile, not a probability. It is
  honest as a ranking signal and should not be read as a literal likelihood.
- **No pick tiering.** Sleeper's feed carries no draft slot, so the fit knows "a 2027 1st"
  but not an early vs late one. Early/Mid/Late is preserved as a ratio off the hand table.
- **Roster state at trade time is unknown.** We can't reconstruct who was contending when a
  trade happened, so contender/rebuilder effects are still inferred live, not fitted.
- **Pick monotonicity is enforced, not learned.** A further-out pick is capped at the value
  of the same round nearer. At n=66 the raw fit briefly had a 2028 1st above a 2027 1st.
- **The solver targets an even split, but real trades aren't even.** Picks are 51.6% of the
  assets on the package side of a lopsided trade versus 24.0% on the single side, and the
  package side pays a measured 1.32×. Forcing `ΣA = ΣB` therefore deflates whatever
  habitually sits on the paying side — i.e. picks. The effect sizes at roughly 5%, and the
  FantasyCalc cross-check above says the fitted values are already within 7% of an
  independent market, so correcting it now would likely push *away* from the truth. The
  principled fix, if the corpus ever justifies it, is to make the residual
  `ln ΣB − ln ΣA − ln(expected ratio for that shape)` and estimate the offsets jointly.

## 5b. Fairness is not the same as a good trade

The engines can only *price* a deal; that is not the same as endorsing it. A package can
sit dead-centre of the fair band and still be an obviously bad idea — the case that exposed
this was a 2028 1st offered for T.J. Hockenson: near-even on value, and absurd on the field,
because Hockenson's redraft value is 178 (below the engines' own startable-body floor of
200) behind four better tight ends already on the roster.

So value tests are necessary and not sufficient. Two roster-side gates now sit in front of
every proposal, and both live at a single choke point on purpose — writing them per-shape is
what let the split shape offer a real 1st for a receiver with a redraft value of 6:

- `_incomingOk()` — a contender never receives players who can't crack a lineup; a rebuilder
  may, but only young ones.
- `_improvesLineup()` — "fills a need" has to mean he beats what you already start there.

## 6. Not covered

The **Win-Now Trade Ideas** engine (mobile Trade tab, `renderWinNow`) is a separate engine
and still carries its own hardcoded "max 18% dynasty delta". It picks up the new pick values
through `TC.val()` but not the fitted band or acceptance model. The three engines in this
doc are desktop-only — `renderLeagueMobile` renders Win-Now instead.
