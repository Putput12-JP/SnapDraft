/* betting-math.js  ──────────────────────────────────────────────────────────
   VAULT · VaultBettingMath: pure odds mathematics (no network, no state).

   Faithful JS port of the open-source `betting` skill in
   github.com/machina-sports/sports-skills (MIT). The formulas match
   src/sports_skills/betting/_calcs.py; only the shape of the return values is
   made JS-idiomatic (plain objects / numbers instead of a Python status dict).

   What it adds to the Betting tab: it takes the over/under juice that
   VaultBetting already carries on every prop and turns it into a no-vig FAIR
   probability, then (given a second price you believe) an EV / Kelly call.

     · convert / toProb ...... format conversion (American ↔ decimal ↔ prob)
     · devig / devigTwoWay ... strip the book hold → fair probabilities
     · findEdge .............. fair vs market price → edge, EV, Kelly
     · kelly / kellyStake .... optimal (and fractional) bankroll sizing
     · evaluateBet .......... book odds + a market price → full profile
     · findArbitrage ........ guaranteed-profit check across outcomes
     · parlay ............... multi-leg combined prob, EV, Kelly (+correlation)
     · lineMovement ......... open→close shift, magnitude + sharp/steam class
     · fairFromRow .......... Vault helper: devig a VaultBetting prop row

   Every function returns null (never throws) on invalid input, so a caller can
   fall back the same way the Trade Engines do when the market model is missing.
   ──────────────────────────────────────────────────────────────────────────── */
window.VaultBettingMath = (function () {
  'use strict';

  const MIN_AMERICAN = 100;
  const r = (x, n) => { const f = 10 ** n; return Math.round(x * f) / f; };

  /* ── primitives: American / decimal ↔ implied probability ───────────────── */
  // American prices run +100 and up (dogs) or -100 and down (favorites); the
  // band between inverts the sign convention, so a value there is not a price.
  const validAmerican = (...v) => v.every(x =>
    Number.isFinite(x) && (x <= -MIN_AMERICAN || x >= MIN_AMERICAN));

  function americanToProb(odds) {
    if (odds < 0) return -odds / (-odds + 100);
    if (odds > 0) return 100 / (odds + 100);
    return 0.5; // unreachable for validated input; avoids a divide-by-zero
  }
  function probToAmerican(prob) {
    if (prob <= 0 || prob >= 1) return 0;
    return prob >= 0.5 ? -(prob / (1 - prob)) * 100 : ((1 - prob) / prob) * 100;
  }
  const decimalToProb = odds => (odds <= 0 ? 0 : 1 / odds);
  const probToDecimal = prob => (prob <= 0 ? 0 : 1 / prob);

  // Unified: any supported format → implied probability (0-1), or null.
  function toProb(odds, format) {
    const o = Number(odds);
    if (!Number.isFinite(o)) return null;
    switch ((format || 'american').toLowerCase()) {
      case 'american':    return validAmerican(o) ? americanToProb(o) : null;
      case 'decimal':     return o > 1 ? decimalToProb(o) : null;
      case 'probability': return o > 0 && o < 1 ? o : null;
      default:            return null;
    }
  }

  /* ── 1. convert ─────────────────────────────────────────────────────────── */
  function convert(odds, fromFormat) {
    const prob = toProb(odds, fromFormat);
    if (prob == null) return null;
    return {
      impliedProbability: r(prob, 6),
      american: r(probToAmerican(prob), 1),
      decimal: r(probToDecimal(prob), 4),
      fromFormat: (fromFormat || 'american').toLowerCase(),
      inputOdds: Number(odds),
    };
  }

  /* ── 2. devig (multiplicative / proportional method) ────────────────────── */
  // fairProb[i] = rawProb[i] / sum(rawProbs)
  function devig(oddsList, format) {
    const list = Array.isArray(oddsList)
      ? oddsList.map(Number)
      : String(oddsList).split(',').map(s => Number(s.trim()));
    if (list.length < 2 || list.some(x => !Number.isFinite(x))) return null;

    const raw = list.map(o => toProb(o, format));
    if (raw.some(p => p == null || p <= 0)) return null;

    const overround = raw.reduce((a, b) => a + b, 0);
    const fair = raw.map(p => p / overround);
    return {
      outcomes: list.map((odds, i) => ({
        outcome: i,
        inputOdds: odds,
        impliedProb: r(raw[i], 6),
        fairProb: r(fair[i], 6),
        fairAmerican: r(probToAmerican(fair[i]), 1),
      })),
      overround: r(overround, 6),
      vigPct: r((overround - 1) * 100, 2),
      format: (format || 'american').toLowerCase(),
    };
  }

  // Two-way convenience for a single prop: over/under American odds in, a
  // no-vig fair probability for each side out. This is the one you want on the
  // props grid; it says how likely the OVER really is once the juice is gone.
  function devigTwoWay(overOdds, underOdds, format) {
    const d = devig([overOdds, underOdds], format);
    if (!d) return null;
    return { over: d.outcomes[0], under: d.outcomes[1], vigPct: d.vigPct, overround: d.overround };
  }

  /* ── 3. findEdge (fair prob vs a price you can bet) ──────────────────────── */
  function findEdge(fairProb, marketProb) {
    const fp = Number(fairProb), mp = Number(marketProb);
    if (!(fp > 0 && fp < 1) || !(mp > 0 && mp < 1)) return null;
    const edge = fp - mp;
    const evPerDollar = fp / mp - 1;             // ROI per $1 staked
    const kelly = mp < 1 ? edge / (1 - mp) : 0;
    return {
      edge: r(edge, 6),
      edgePct: r(edge * 100, 2),
      evPerDollar: r(evPerDollar, 6),
      kellyFraction: r(kelly, 6),
      fairProb: fp,
      marketProb: mp,
      recommendation: edge > 0 ? 'bet' : 'no bet',
      rating: edge > 0 ? 'positive edge' : edge === 0 ? 'no edge' : 'negative edge',
    };
  }

  /* ── 4. kelly ───────────────────────────────────────────────────────────── */
  // f* = (fair - market) / (1 - market)
  function kelly(fairProb, marketProb) {
    const fp = Number(fairProb), mp = Number(marketProb);
    if (!(fp > 0 && fp < 1) || !(mp > 0 && mp < 1)) return null;
    const edge = fp - mp;
    return {
      kellyFraction: r(edge / (1 - mp), 6),
      edge: r(edge, 6),
      evPerDollar: r(fp / mp - 1, 6),
      fairProb: fp,
      marketProb: mp,
      netOdds: r(1 / mp - 1, 4),
      recommendation: edge > 0 ? 'bet' : 'no bet',
    };
  }
  // Practical sizing: dollar stake at a fraction of full Kelly (default half).
  // Full Kelly is famously twitchy; half-Kelly is the usual real-world dial.
  function kellyStake(fairProb, marketProb, opts) {
    const k = kelly(fairProb, marketProb);
    if (!k) return null;
    const bankroll = Number((opts && opts.bankroll) ?? 0);
    const mult = Number((opts && opts.multiplier) ?? 0.5);
    const frac = Math.max(0, k.kellyFraction) * mult;
    return { ...k, multiplier: mult, stakeFraction: r(frac, 6), stake: r(bankroll * frac, 2) };
  }

  /* ── 5. evaluateBet (devig the book, then edge vs a market price) ────────── */
  function evaluateBet(opts) {
    opts = opts || {};
    const d = devig(opts.bookOdds, opts.bookFormat);
    if (!d) return null;
    const idx = Number(opts.outcome || 0);
    if (idx < 0 || idx >= d.outcomes.length) return null;
    const fairProb = d.outcomes[idx].fairProb;
    const edge = findEdge(fairProb, Number(opts.marketProb));
    if (!edge) return null;
    return {
      devig: d,
      edge,
      recommendation: edge.kellyFraction > 0 ? 'bet' : 'no bet',
      summary: `Fair: ${(fairProb * 100).toFixed(1)}% | Market: ${(edge.marketProb * 100).toFixed(1)}% | `
             + `Edge: ${edge.edgePct.toFixed(2)}% | Kelly: ${edge.kellyFraction.toFixed(4)} | `
             + `EV: ${(edge.evPerDollar * 100).toFixed(2)}%`,
    };
  }

  /* ── 6. findArbitrage (prices summing under 1.0 = guaranteed profit) ─────── */
  function findArbitrage(marketProbs, labels) {
    const probs = Array.isArray(marketProbs)
      ? marketProbs.map(Number)
      : String(marketProbs).split(',').map(s => Number(s.trim()));
    if (probs.length < 2 || probs.some(p => !(p > 0 && p < 1))) return null;

    const lab = labels
      ? (Array.isArray(labels) ? labels.map(String) : String(labels).split(',').map(s => s.trim()))
      : null;
    if (lab && lab.length !== probs.length) return null;

    const total = probs.reduce((a, b) => a + b, 0);
    const arb = total < 1;
    return {
      arbitrageFound: arb,
      totalImplied: r(total, 6),
      arbitragePct: r(arb ? (1 / total - 1) * 100 : 0, 2),  // guaranteed ROI
      overroundPct: r((total - 1) * 100, 2),
      allocations: probs.map((p, i) => {
        const a = { outcome: i, marketProb: p, allocationPct: r((p / total) * 100, 2) };
        if (lab) a.label = lab[i];
        return a;
      }),
    };
  }

  /* ── 7. parlay (combined fair prob, EV, Kelly; optional correlation) ─────── */
  function parlay(opts) {
    opts = opts || {};
    const legs = Array.isArray(opts.legs)
      ? opts.legs.map(Number)
      : String(opts.legs).split(',').map(s => Number(s.trim()));
    if (legs.length < 1 || legs.some(p => !(p > 0 && p < 1))) return null;

    const fmt = (opts.oddsFormat || 'american').toLowerCase();
    const impliedProb = toProb(opts.parlayOdds, fmt);
    if (impliedProb == null) return null;

    let corr = Number(opts.correlation ?? 0);
    if (!(corr >= 0 && corr <= 0.5)) return null;

    // Independent legs multiply. Correlation blends toward the weakest leg
    // (min prob), a light copula-free approximation for same-game parlays.
    let independent = 1;
    for (const p of legs) independent *= p;
    const combined = (corr > 0 && legs.length >= 2)
      ? independent + corr * (Math.min(...legs) - independent)
      : independent;

    const edge = combined - impliedProb;
    return {
      numLegs: legs.length,
      legs: legs.map((p, i) => ({ leg: i, fairProb: p, fairAmerican: r(probToAmerican(p), 1) })),
      combinedFairProb: r(combined, 6),
      fairParlayAmerican: r(probToAmerican(combined), 1),
      fairParlayDecimal: r(probToDecimal(combined), 4),
      offeredParlayAmerican: fmt === 'american' ? Number(opts.parlayOdds) : r(probToAmerican(impliedProb), 1),
      offeredParlayDecimal: fmt === 'decimal' ? Number(opts.parlayOdds) : r(probToDecimal(impliedProb), 4),
      impliedParlayProb: r(impliedProb, 6),
      edge: r(edge, 6),
      edgePct: r(edge * 100, 2),
      evPerDollar: r(impliedProb > 0 ? combined / impliedProb - 1 : 0, 6),
      isPlusEv: edge > 0,
      kellyFraction: r(impliedProb < 1 ? edge / (1 - impliedProb) : 0, 6),
      correlationApplied: corr,
      recommendation: edge > 0 ? 'bet' : 'no bet',
    };
  }

  /* ── 8. lineMovement (open→close shift, magnitude + classification) ──────── */
  function lineMovement(opts) {
    opts = opts || {};
    const hasMl = opts.openOdds != null && opts.closeOdds != null;
    const hasSpread = opts.openLine != null && opts.closeLine != null;
    if (!hasMl && !hasSpread) return null;

    const marketType = (opts.marketType || 'moneyline').toLowerCase();
    const data = { marketType };
    let probShift = 0, mlDir = null, spreadDir = null;
    let openOdds, closeOdds, openLine, closeLine, lineChange;

    if (hasMl) {
      openOdds = Number(opts.openOdds); closeOdds = Number(opts.closeOdds);
      if (!validAmerican(openOdds, closeOdds)) return null;
      const op = americanToProb(openOdds), cp = americanToProb(closeOdds);
      probShift = cp - op;
      mlDir = probShift > 0 ? 'shortened' : probShift < 0 ? 'lengthened' : 'no movement';
      data.moneyline = {
        openOdds, closeOdds,
        openImpliedProb: r(op, 6), closeImpliedProb: r(cp, 6),
        probShift: r(probShift, 6), probShiftPct: r(probShift * 100, 2),
        direction: mlDir,
        movedToward: probShift > 0 ? 'favorite' : probShift < 0 ? 'underdog' : 'none',
      };
    }

    if (hasSpread) {
      openLine = Number(opts.openLine); closeLine = Number(opts.closeLine);
      if (!Number.isFinite(openLine) || !Number.isFinite(closeLine)) return null;
      lineChange = closeLine - openLine;
      if (marketType === 'total') {
        spreadDir = lineChange > 0 ? 'total moved up' : lineChange < 0 ? 'total moved down' : 'no movement';
      } else {
        // spread: more negative = favorite laying more points
        spreadDir = lineChange < 0 ? 'moved toward favorite' : lineChange > 0 ? 'moved toward underdog' : 'no movement';
      }
      data.spread = { openLine, closeLine, lineChange: r(lineChange, 2), direction: spreadDir };
    }

    // Magnitude, from ML prob shift when present, else the line delta.
    let magnitude;
    if (hasMl) {
      const a = Math.abs(probShift);
      magnitude = a < 0.02 ? 'small' : a < 0.05 ? 'moderate' : 'large';
    } else {
      const a = Math.abs(lineChange);
      if (marketType === 'total') magnitude = a <= 1 ? 'small' : a <= 3 ? 'moderate' : 'large';
      else magnitude = a <= 0.5 ? 'small' : a <= 2 ? 'moderate' : 'large';
    }
    data.magnitude = magnitude;

    // Classification. ML + spread moving opposite ways = reverse line movement.
    let classification;
    if (hasMl && hasSpread) {
      const mlFav = mlDir === 'shortened', spFav = spreadDir === 'moved toward favorite';
      if (mlFav !== spFav && mlDir !== 'no movement' && spreadDir !== 'no movement') classification = 'reverse_line_movement';
      else classification = magnitude === 'large' ? 'steam_move' : magnitude === 'moderate' ? 'sharp_action' : 'minor_adjustment';
    } else {
      classification = magnitude === 'large' ? 'steam_move' : magnitude === 'moderate' ? 'sharp_action' : 'minor_adjustment';
    }
    data.classification = classification;

    const LABELS = {
      steam_move: 'Large, one-directional move suggesting coordinated sharp money.',
      sharp_action: 'Moderate move suggesting professional action.',
      minor_adjustment: 'Small adjustment, normal market balancing.',
      reverse_line_movement: 'Moneyline and spread moving in opposite directions, possible sharp vs public split.',
    };
    const parts = [];
    if (hasMl) parts.push(`Moneyline moved from ${openOdds > 0 ? '+' : ''}${openOdds} to ${closeOdds > 0 ? '+' : ''}${closeOdds} (${(probShift * 100 >= 0 ? '+' : '')}${(probShift * 100).toFixed(2)}% probability shift)`);
    if (hasSpread) parts.push(`${marketType === 'total' ? 'Total' : 'Spread'} moved from ${openLine} to ${closeLine} (${lineChange >= 0 ? '+' : ''}${lineChange.toFixed(1)})`);
    parts.push(LABELS[classification] || '');
    data.interpretation = parts.filter(Boolean).join(' ');
    return data;
  }

  /* ── Vault helper: devig a VaultBetting prop row ─────────────────────────── */
  // Accepts a row from window.VaultBetting.propRows(). Prefers the best
  // available over/under price (row.best), falls back to the row's headline
  // over/under, and returns the no-vig fair probability + fair line for the
  // over. Optionally, pass a `yourProb` (e.g. a model number) to also get the
  // edge/EV/Kelly of betting the over at the current best price.
  function fairFromRow(row, yourProb) {
    if (!row) return null;
    const overOdds = (row.best && row.best.over && row.best.over.over) ?? row.over;
    const underOdds = (row.best && row.best.under && row.best.under.under) ?? row.under;
    if (overOdds == null || underOdds == null) return null;
    const dv = devigTwoWay(overOdds, underOdds, 'american');
    if (!dv) return null;
    const out = {
      line: row.line ?? null,
      overOdds, underOdds,
      vigPct: dv.vigPct,
      fairProbOver: dv.over.fairProb,
      fairProbUnder: dv.under.fairProb,
      fairAmericanOver: dv.over.fairAmerican,
      fairAmericanUnder: dv.under.fairAmerican,
    };
    if (yourProb != null) {
      const marketProb = americanToProb(Number(overOdds));
      out.edge = findEdge(Number(yourProb), marketProb);
    }
    return out;
  }

  return {
    // primitives
    americanToProb, probToAmerican, decimalToProb, probToDecimal, toProb, convert,
    // core
    devig, devigTwoWay, findEdge, kelly, kellyStake, evaluateBet,
    findArbitrage, parlay, lineMovement,
    // Vault glue
    fairFromRow,
  };
})();
