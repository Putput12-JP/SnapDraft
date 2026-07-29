# Vault Fantasy — project instructions

## Motion system

Vault has one motion vocabulary. **Any new page, feature, or component uses these
primitives — do not hand-roll a transition.** Tokens and the three primitive
classes live in `vault-ds.css` §19; `index.html` links that file, so they are
available everywhere without extra CSS.

### Tokens (`vault-ds.css` `:root`)

| Token | Use |
|---|---|
| `--ease-out` | entrances, expanders, anything that moves in |
| `--ease-sheet` | bottom sheets (iOS/Vaul curve) |
| `--ease-rail` | **travel** — a thing moving between two known points |
| `--ease-spring` | **arrival** — press release, pop-in (overshoots past its endpoint) |
| `--dur-press` 80ms / `--dur-release` 500ms | the asymmetric press pair |
| `--dur-rail` 400ms | pill / indicator travel |
| `--press-chip/btn/card/row` | `.88 / .94 / .975 / .99` |

Rules:
- Things that **move between two points** use `--ease-rail`. Things that
  **arrive in place** use `--ease-spring`. Swapping these is what makes
  hand-rolled motion feel off.
- **Overshoot is only ever safe on `transform`.** Never put `--ease-spring` on
  `width`, `height`, or anything else that triggers layout.
- Colour/opacity feedback at ≤150ms may keep plain `ease`.
- Never use bare `ease`/`ease-out` on movement.

### 1. Press — `.press` + `.press-{chip,btn,card,row}`

Snap down fast, spring back slow. The asymmetry *is* the effect:

```css
.press        { transition:transform var(--dur-release) var(--ease-spring); }
.press:active { transform:scale(var(--press-scale));
                transition:transform var(--dur-press) ease-out; }
```

`.v-btn` already has this built in — plain buttons need nothing.

**Press depth is inverse to element size.** A 90px chip losing 12% moves 11px and
feels crisp; a 600px card losing 12% moves 72px and looks broken. Pick the
matching `--press-*` step, don't reuse `.88` everywhere.

Do **not** put a scale press on a `<tr>` — transforms on table rows are
unreliable. Use the div-based row (e.g. `.prow-mobile`), not `.prow`.

### 2. Sliding indicator — `.vrail > .v-pill`

Tab strips get **one shared bar that travels**, never an indicator that blinks
between tabs. Wired by `vaultRails()` (bottom of `index.html`) from a `RAILS`
config — add a strip there rather than writing new indicator CSS. Three skins:

| Skin | Use |
|---|---|
| `--bar` | 2px underline (`.la-tabs`, `.lr-tabs`) |
| `--fill` | solid capsule behind the active item (segmented filters, main nav) |
| `--soft` | translucent tint; item keeps its own colour (mobile dock) |

Per-strip config keys: `colour` (take the position colour from the item's
label), `c` / `ink` (pin both), `bg` (custom pill background, e.g. keeping an
existing gradient), `inset`, `radius`, `on` (custom active selector).

**Match by class FAMILY, not by modifier.** `RAILS` ends with a catch-all entry
listing `.rh-seg, .res-seg, .dvc-seg, .tc-seg, .vcaps, …` so a new
`.rh-seg whatever` variant is covered automatically. Entries are matched in
order and `wire()` is WeakSet-guarded, so the specific coloured/position
entries must stay *above* the catch-all to claim their strips first. Wiring
one modifier at a time is how Advanced Stats' SEASON strip got missed while
POSITION worked.

Four things are deliberately **excluded** — do not "fix" them:
`.lc-mt-menu` / `.rh-mt-menu` / `#dv-dd-menu` (vertical dropdown *menus* — a
travelling pill is the wrong idiom for a popup list), `.d-fc-dots` (carousel
dots), and `#vp-platforms` (`flex-direction:column`; the pill only animates
`left`/`width`, so it cannot track a vertical strip).

To find anything still uncovered, scan the DOM for elements whose children are
all buttons and where exactly one has `.on` — that audit is what took coverage
from 9 strips to 27.

**Contrast is theme-dependent.** Position colours *invert* between themes —
vapor/onyx use light positions (`--qb:#ff6680`), light mode uses dark ones
(`--qb:#c52d3a`). Never hardcode the ink; use `--pos-ink`, which flips per
theme. Same trap on the nav: it is pinned to `--primary`/`--on-primary`, which
are already a matched pair in every theme.

Traps this code already handles — preserve them if you touch it:

0. **The pill can outlive its styling hook.** The pill paints its own
   background, but the ink and background-neutralising rules key on
   `.vrail--*`. If anything rewrites the strip's `className`, you get the
   native text colour on top of the pill — invisible dark-on-dark in light
   mode. `place()` re-asserts the classes on every run for exactly this reason.

0b. **A re-rendered strip cannot animate unless you seed it.** Most of these
   strips rebuild from a template literal on every click, so you get a
   brand-new pill with no `left` — and an element that has never had a
   position has nothing to transition *from*, so it teleports. `place()`
   keeps a `lastGeom` map keyed by a stable strip signature and re-seeds the
   fresh pill at the old position (transitions off, forced reflow) before
   moving it. **Verify travel by checking `pill.getAnimations()` after a real
   click** — final geometry being correct proves nothing, and the preview tab
   never paints so sampled positions stay frozen either way.

1. **`offsetWidth === 0`.** Pages are toggled with `display:none`, so a strip
   positioned on load pegs the bar at width 0 and makes it snake into place the
   first time the page opens. The bar parks at `opacity:0` until the strip has a
   real width.
2. **Never `requestAnimationFrame` for correctness.** A backgrounded or
   non-painting tab never runs rAF, which would strand `.rail-noanim` and kill
   the travel permanently. Flush with a forced reflow (`void el.offsetWidth`)
   instead — same reason `openPlayerStats()` does.
   *`ResizeObserver`/`IntersectionObserver` are also paint-driven; do not rely on
   them as the only trigger.* The nav hook + delegated click are the real nets.
3. **The bar must live inside the strip.** It is positioned against `.rail`, so
   on an `overflow-x:auto` strip it scrolls with the tabs. Move it outside and it
   desyncs the moment anyone swipes. Also keep it at `bottom:0`, not `-1px` —
   `overflow-x:auto` makes `overflow-y` compute to `auto`, which clips anything
   below the padding box.

### 3. Loading — `.spinner`

**Never render a rotating text glyph.** `⟳` is a font character: it renders
differently per platform and wobbles as it spins because the glyph isn't centred
in its em box. Use `.spinner` (`.xs/.sm/.md/.lg`, plus `.red`/`.value`), or
`.v-loading` for a centred block wait state.

- `linear` is correct for a spin; an eased spin looks like it's struggling.
- Colours come from `--accent2` / `--s3`. Never hardcode a hex.
- **A spinner is for a discrete action with an unknown wait** (connecting,
  pushing). **A skeleton (`.skel`) is for content arriving into a shape you
  already know** — player lists, stat tables, league grids. Prefer the skeleton
  for lists; it removes the layout jump when data lands.

The three remaining `⟳` in `index.html` are intentional and must stay: the
`#resync-btn` resting icon, the "Connect Sleeper" empty state, and the
"Shuffle ideas" / "Refresh FC" labels. They are icons, not wait states.

### 4. In-button wait state

Every Sleeper write funnels through `pfLcModal`'s `#pf-lc-modal-confirm`. It
locks its own width, cross-fades the label out for an arc, and strokes a
checkmark on success before closing. New write actions should go through that
modal rather than rolling their own busy button — and keep the `dataset.busy`
guard, since `disabled = true` alone leaves a double-write window open across
the first `await`.

### Reduced motion

Every primitive degrades in the `prefers-reduced-motion:reduce` blocks that sit
directly under each one. **Add new motion to the existing block**, don't create
another — there are already several scattered through `index.html`.

## Segmented controls — `.vseg`

There is **one** segmented control. It lives in `vault-ds.css` §20; the box, the
type ramp and the hit area all come from there. **A new filter strip is
`<div class="vseg">` with `<button>` children and no CSS of its own.**

Vault used to carry 28 of these — `.rh-seg`, `.dvc-seg`, `.mr-seg`, `.adp-seg`,
`.tc-seg`, `.bt-seg`, `.lr-srctoggle` and the rest — each with its own surface,
border, radius, padding and active fill. Those class names still exist in markup
(JS queries them, several are built from template literals) but they are now
**aliases onto `.vseg`**, listed in §20. Don't add a new alias; use `.vseg`.

- **The pill owns "active".** `vaultRails()` paints the active background, so
  `.vseg` sets no background on `.on`. A strip that paints its own gives you a
  chip inside a chip. The only fill is the `:not(.vrail)` fallback, which
  switches itself off the moment the rail wires. **Wire the strip in `RAILS`**
  rather than styling `.on`.
- **Variants, not new boxes:** `.sm` / `.lg` size, `.fluid` even split,
  `.scroll` overflow, `.free` no container (mobile caps, profile tabs),
  `.bar` underline tabs.
- **Retint with the vars.** A scoped skin sets `--vseg-bg` / `--vseg-border` /
  `--vseg-ink` — see `#page-betting .bt-seg`, which is one line. Re-declaring
  the box is how the fragmentation started.
- **Mobile hit area is handled.** Segments are 36px visually under 768px with a
  transparent `::after` extending them to 44px. Don't add `min-height:44px` to
  the button — that grows the strip to 50px, which is what the old
  `button.sbtn, button.la-tab` touch rule did.
- **Buttons that also exist standalone** (`.sbtn`, `.fbtn`, `.la-tab`) have
  their chrome stripped by a `!important` reset in §20. The standalone rules for
  those classes are guarded — `#page-draft .controls :not(.dvc-seg) > .sbtn`,
  `.sbtn:not(.dv-mode):not(.sort-mode)` — because they are ID-scoped
  `!important` and would otherwise out-specify the primitive. If you add a
  standalone rule for one of these classes, guard it the same way.

Excluded on purpose, same list as `RAILS`: `.lh-tabsel` (mobile dropdown),
`.bottom-tab-bar` and `.nav.desktop-nav` (nav, pinned to `--primary`),
`#vp-platforms` (vertical).

## CSS cascade

`index.html` carries large late override blocks, several using `!important`.
**Before editing any CSS, find which rule actually wins** — the obvious edit is
frequently dead code. New motion/draft CSS must land *after* the
`dv-shadcn-restyle` block.

Three things that cost real time here:

- **Count specificity properly before assuming you win.**
  `.rh-scope .rh-seg.pos .rh-segbtn.on` is (0,5,0), not (0,4,0) — the scope
  class counts. Several of these strips are scoped that way. Note that
  `vault-ds.css` is a `<link>` in `<head>`, so every `<style>` block in
  `index.html` wins any tie against it — a DS primitive only takes effect once
  the competing declarations are deleted, not merely out-written.
- **A losing `var()` does not fall through.** A declaration that wins the
  cascade but is invalid at computed-value time (e.g. `color:var(--pc)` where
  `--pc` is unset) makes the property `unset`/inherit — it does *not* defer to
  the next declaration. A near-miss lands on an inherited value, not yours.
- **`-webkit-text-fill-color` beats `color`.** `[data-theme="onyx"] .mr-seg
  button.on` sets it `!important`, so setting `color` alone there is silently a
  no-op. Set both.
- `!important` beats specificity, so it outranks an ID selector like
  `#P .mr-seg.posseg button.on` without needing a longer selector.

## Trade Engines — the constants are measured, don't invent new ones

Matchmaker / Exploit Finder / Idea Generator used to run on made-up numbers: a
flat ±18% "fair" band, a hand-written `PICK_VALUES` table, and acceptance odds
assembled from guessed penalties. Those are now **fitted from real Sleeper league
trades** — `scripts/build_sleeper_trades.py` → `data/trade_market.json`, read
through `window.VaultTradeMarket`. Methodology, findings and limits:
`docs/trade-market-model.md`.

**If you need a threshold in these engines, get it from the model.** The ones
that exist: `TC._band()` / `_bandWide()` (fair gap), `VaultTradeMarket
.acceptance()` (surplus percentile), `.pickValue()`, `.edge()`, `.liquidity()`,
`.shapeWeights()`, `.comps()`. Adding another hardcoded constant next to these
is how the old engines got the way they were.

- **Every getter returns `null` until the file lands**, and every caller falls
  back to the old constant. Keep that — it is why a cold cache or a failed
  fetch costs nothing. Don't make a getter return `0`; "not in the model" and
  "measured as zero" are different claims.
- **Report the bucket actually used, not the one asked for.** The model is fit
  four ways (dyn/rdr × sf/1qb) and a thin bucket borrows dynasty's. `stats()`
  exposes `asked` / `bucket` / `borrowed` for exactly this, and the provenance
  line says so out loud.
- **A bucket needs `MIN_TRADES_BUCKET` before it publishes.** A published
  bucket beats borrowing, so a 50-trade bucket is worse than none — it briefly
  shipped a consolidation premium below 1, which is backwards.
- Pick assets key on **years out from the next rookie draft (May)**, never on
  the season string, or the same pick becomes two assets across the offseason.
- These three engines are **desktop-only**. `renderLeagueMobile()` renders
  `renderWinNow()` instead, which is a separate engine still carrying its own
  hardcoded 18% band.

## Verifying UI work

Run the app and look at it; don't rely on the file diff. `.claude/launch.json`
has the static servers. Two gotchas:

- **`vault-ds.css` caches hard.** A reload often keeps the old stylesheet — bust
  the `<link>` href with a query string before trusting what you see.
  **When you change `vault-ds.css`, bump the `?v=` on its `<link>` in
  `index.html`.** `index.html` markup depends on classes defined there
  (`.spinner`, `.press`, `.rail`), so a visitor pairing fresh markup with a
  cached stylesheet gets invisible loading states.
- The preview tab may not paint, so `rAF`, `ResizeObserver` and
  `IntersectionObserver` callbacks never fire there. `MutationObserver`
  (microtask) still does. Don't conclude code is broken from that alone.

Load Sleeper user **Putput** for realistic data.
