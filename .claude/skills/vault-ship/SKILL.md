---
name: vault-ship
description: >-
  Vault's pre-ship checklist. Run it before committing or pushing any change to
  index.html or vault-ds.css. Enforces the four rules that have bitten this repo
  before: the VAULT_CHANGELOG entry for user-facing changes, the vault-ds.css
  cache-bust, a desktop plus mobile visual review of the running app, and the
  rebase-before-push-straight-to-main flow (Pages deploys from main; hourly cron
  commits race you). Trigger on "ship", "ship it", "push", "commit and push",
  "ready to deploy", "let's ship this", or any request to push index.html live.
---

# vault-ship

Vault is a live app: `main` auto-deploys to GitHub Pages, and a cron writes data
commits hourly. A push that skips a step below ships a visible regression to real
users or gets clobbered by cron. Work the checklist top to bottom. Do not push
until every applicable box is real, not assumed.

## 0. Know what changed

```bash
git status && git --no-pager diff --stat
```

Classify the diff, because it decides which steps apply:
- **User-facing** (anything a player sees or does) requires step 1.
- **Touched `vault-ds.css`** requires step 2.
- **Touched any UI** requires step 3.
- Pure backend / cron / script / docs work can skip 1-3 and go to step 4.

## 1. Changelog (user-facing changes only)

Every change that alters what a user sees or does gets a `VAULT_CHANGELOG` entry.
This is a hard project rule, not a nicety.

- Find the array: it is defined in `index.html` right after `_sdSetAdp`.
- **Prepend** (newest first) a new object to the TOP:
  ```js
  { ts:'YYYY-MM-DDTHH:MM', tag:'New'|'Improved'|'Fixed', title:'…',
    items:['plain-English bullet', …] }
  ```
- Write for **players, not developers**. No file names, function names, or
  internal jargon. "Switch drafts faster", never "added #dv-change-draft handler".
- `ts` must be **monotonically increasing** (later than the current top entry) or
  the "New" badge logic (stored in `localStorage` as `vault-changelog-seen`)
  breaks.
- Skip purely internal work (refactors, perf plumbing, motion-trap fixes) a user
  would never notice. Those live in git, not the changelog.

## 2. Cache-bust vault-ds.css (only if you edited it)

`vault-ds.css` caches hard. A visitor pairing fresh `index.html` markup with a
stale stylesheet gets invisible loading states and broken primitives (`.spinner`,
`.press`, `.rail`, `.vseg`).

- The `<link>` is around `index.html:242`:
  `<link href="vault-ds.css?v=20260728d-vseg" rel="stylesheet">`
- Bump the `?v=` to a fresh value. Format is `YYYYMMDD` + a letter + optional tag,
  e.g. `?v=20260902a-<what-changed>`. The date must not go backwards.
- If you did NOT touch `vault-ds.css`, leave the version alone.

## 3. Visual review of the running app (any UI change)

Do not trust the file diff. Run the app and look at it, on both breakpoints.

1. Start the review server (from `.claude/launch.json`):
   `preview_start` with `{name: "vault-review"}` (port 4193). `vault-static`
   (4173) also works.
2. Load real data: the Sleeper username **Putput**.
3. **Bust the stylesheet cache in the browser too.** A reload often keeps the old
   `vault-ds.css`. Append a throwaway query to the `<link>` href, or hard-reload,
   before trusting what you see.
4. Screenshot **desktop and mobile** (`resize_window` mobile preset, then reload
   so load-time device gates re-run). Confirm the actual change, and that nothing
   adjacent broke.
5. If you touched a tab strip / segmented control / nav, sanity-check motion:
   after a real click, `pill.getAnimations()` should show live `left,width`
   transitions and `.rail-noanim` never stuck on. The preview tab may not paint,
   so `rAF` / `ResizeObserver` / `IntersectionObserver` never fire there; do not
   conclude code is broken from that alone.

Send the desktop and mobile screenshots to the user before pushing. This is the
"inspect before push" gate.

## 4. Hand off the file

After editing `index.html`, confirm it is saved locally so it is ready to drop
into Claude Design. Offer the file to the user (`SendUserFile`) when the change is
a deliverable they will re-import.

## 5. Push (straight to main, rebased)

Only when the user has said to ship. Never branch: Pages deploys from `main`.

```bash
git add -A
git commit -m "<area>: <player-facing summary>"
git pull --rebase
```

- **Rebase before pushing.** A cron writes data commits roughly hourly; without a
  rebase your push is rejected or you create a merge bubble.
- **On a cron conflict in generated data, regenerate — do not hand-merge.** Rerun
  the generating script and re-commit; merging two machine outputs by hand corrupts
  the file.
- Then:
  ```bash
  git push origin main
  ```

Commit-message footer (attribution for this session):

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## Fast path

Backend / script / docs only, no UI and no `vault-ds.css`: skip 1-3, do 0 then 5.
UI change: all six steps.
