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

### 2. Sliding indicator — `.rail > .pill`

Tab strips get **one shared bar that travels**, never an indicator that blinks
between tabs. Wired automatically by `vaultRails()` (bottom of `index.html`) for
`.la-tabs` and `#page-teams .lr-tabs`. A new strip opts in by matching that
selector, or by calling `window.vaultRails()` after it renders.

Three traps this code already handles — preserve them if you touch it:

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

## CSS cascade

`index.html` carries large late override blocks, several using `!important`
(e.g. the `.la-tab` restyle ~L2022). **Before editing any CSS, find which rule
actually wins** — the obvious edit is frequently dead code. New motion/draft CSS
must land *after* the `dv-shadcn-restyle` block.

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
