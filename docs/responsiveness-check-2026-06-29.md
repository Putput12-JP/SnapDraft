# Vault Fantasy — Responsiveness Check

**Date:** 2026-06-29
**URL:** `http://localhost:4173/index.html`
**User:** Putput (Early Birds - X, Team Review page)
**Tool:** `jezweb/claude-skills@responsiveness-check` (Standard Mode, 8 breakpoints)

---

## Summary

Vault renders without horizontal scroll at every tested width (320 → 2560), but two real layout failures appear under 400px and touch targets across the mobile UI are consistently below the 44px guideline. The desktop side of the layout is solid through 1440. Above 1920 content stops growing and leaves large dead margins on ultra‑wide.

| Severity | Count | Where |
|---|---|---|
| Critical | 2 | 320 / 375 — Compare tab clipped, score overlaps helmet |
| High | 2 | 375 — Starter names ellipsize to single letter, "Yet to play" stacks vertically |
| Medium | 2 | 375 — Touch targets under 44px (5 controls), 2560 — ultra‑wide gutter waste |
| Low | 1 | 1280 — League pill truncates to "Early B…" |

---

## Per‑width findings

### 320px (iPhone SE)
- **Critical** — Compare tab extends to x=336 in a 320px viewport (clipped 16px). The tab strip does **not** scroll horizontally, so the user has no way to reach the tab without resizing.
- **Critical** — Matchup score "120.94 vs 106.43" (20px font) overlaps the Putput helmet badge on the left and the opponent avatar on the right. The W‑L mini‑stat ("0 0 · #4") also collides with the score numbers.
- No horizontal page overflow (`docW == viewW`).

### 375px (iPhone 14)
- **High** — Starter cards truncate player names to **one letter + ellipsis** ("D…", "M…", "C…", "S…"). Position/team labels also clip ("QB …", "RB …"). The user cannot identify players.
- **High** — "Yet to play" wraps to a vertical stack (one word per line: "Yet / to / play") inside the starter card.
- **Critical** carried over — score still overlaps helmet.
- **Medium** — 5 sub‑44px touch targets above the fold:
  - League dropdown ("Early Birds - X"): **148 × 31**
  - Theme/icon button (`.gn-ic`): **34 × 34**
  - Market segmented toggle: **59 × 24**
  - Mine segmented toggle: **46 × 24**
  - "Sync with Sleeper": **154 × 39**

### 768px (iPad portrait)
- **Major transition**: bottom mobile tab bar (Home / Research / center / League / Portfolio) is replaced by **top horizontal nav** (My Team, Portfolio, Research, My Rankings, Draft Vault).
- Description copy ("A comprehensive performance audit…") appears.
- Player names render fully ("D. Maye", "M. Stafford").
- Right rail (Win Probability, One Move, Biggest Swings, Bench Watch) **not yet shown**.

### 1024px (iPad landscape / small laptop)
- **Major transition**: right rail appears with Win Probability gauge, One Move, Biggest Swings, Bench Watch.
- Header gains Season Sim, League, Calc, "Bettin…" (clipped).
- League pill shows "Early B…" (clipped).

### 1280px (laptop)
- "Betting" renders in full. Theme + search icons appear in utility cluster.
- League pill shows "Early Birds - X" in full.
- Layout balanced, no issues.

### 1440px (desktop)
- "VAULT FANTASY" wordmark + nav icons appear in header.
- Content width unchanged — same as 1280, just more side air.

### 1920px (Full HD)
- Content stops growing. Right‑side dead space starts to look like a missing column.

### 2560px (4K / ultrawide)
- **Medium** — Content column hugs the left third of the screen, rail hugs the right; vast empty band in the middle and large right margin. No max‑width container is doing its job here, or the grid is column‑count constrained without growing.

---

## Transition table

| Transition | From | To | Switch range |
|---|---|---|---|
| Nav: bottom tabbar → top horizontal | 375 | 768 | ~600px |
| Right rail appears | 768 | 1024 | ~1000px |
| Header utility (Season Sim / League / Calc / Betting) appears | 1024 | 1280 | ~1100‑1200px |
| Brand wordmark + icon cluster appear | 1280 | 1440 | ~1400px |
| Content stops scaling, dead margins | 1440 | 2560 | ~1900px+ |

---

## Recommended fixes (priority order)

1. **320 / 375 matchup card — score vs helmet collision.** Either shrink the helmet to ~36px at <420px or stack score below team row instead of beside it. Currently the score text (`font-size: 20px`) starts at x=72 which is inside the badge's right edge.
2. **375 starter card — name truncation.** The card grid is too tight at this width. Options: (a) drop opponent column below player on narrow widths, or (b) increase the player name column flex/min‑width and trim the projection column instead.
3. **Tabs strip overflow at 320.** Either add `overflow-x: auto` with snap behavior, or collapse to a dropdown under 360px. Right now the third tab is silently unreachable.
4. **Mobile touch targets.** Bump segmented toggle (Market/Mine) and `.gn-ic` to a 44px hit‑slop (visual size can stay; use padding or pseudo‑element). The Sleeper sync button is 39px tall — one more pixel of padding fixes it.
5. **Ultra‑wide whitespace (≥1920).** Either widen the main column max‑width, add a second card column to the right rail, or center the whole shell with a max‑width and balanced gutters. Right now content reads "small" because it never grows past its laptop width.
6. **Polish:** "Yet to play" wrapping at 375 — switch to `white-space: nowrap` and either shrink/abbreviate ("YTP") or let the row scroll horizontally rather than wrapping vertically.

---

## Methodology

Single browser session, viewport resized to 320, 375, 768, 1024, 1280, 1440, 1920, 2560 (height 900). Above‑fold screenshot + page metric capture at each width. Checks: horizontal overflow, text overflow, nav transition, content stacking, image scaling, touch targets (<44px), whitespace balance, CTA visibility. Logged in as Putput, on the Team Review tab.
