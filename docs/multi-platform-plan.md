# Multi-platform plan — ESPN writes + Yahoo across all of Vault

Written 2026-07-21. Covers two questions: can ESPN support real actions the way
Sleeper does, and what does full Yahoo support look like across every Vault
feature.

Both answers share a prerequisite (Phase 0), so it leads.

---

## Where Vault stands today

**Sleeper** — full read + write. Public REST for reads, private `sleeper.com/graphql`
for writes with the user's pasted token, stored encrypted in Firestore and drained
through a throttled server-side executor (`functions/src/`).

**ESPN** — reads only, and more of them than you might remember:

| Capability | Status | Anchor |
|---|---|---|
| Connect league by ID | ✅ | `vpEspnIdConnect` — index.html:8765 |
| League settings → Sleeper shape | ✅ | `vpMapEspnLeague` — index.html:8803 |
| Rosters / teams / starters | ✅ | `buildEspnContext` — index.html:13303 |
| Live draft mirror (30s poll) | ✅ | `syncEspnDraft` — index.html:9646 |
| ESPN live-draft ADP column | ✅ | index.html:5178 |
| Private leagues (SWID + espn_s2) | ⚠️ UI exists, needs server proxy | index.html:3937 |
| Any write | ❌ | `canPush: !_pfEspn` — index.html:20497 |

`canPush` is the single gate. `_tcLeagues()` filters on it, so ESPN leagues are
invisible in Lineup Command, Trade Center, Waiver Command and Taxi Manager.

**Yahoo** — nothing.

---

## Phase 0 — Platform adapter (prerequisite for both)

Right now platform handling is `vpPlat(l)==='espn'` branches scattered inline:
index.html:13238, :13339, :13369, :13404, :14826, :8919, :8940, :9710. A third
platform triples that surface. Do this first or every later phase gets worse.

### 0.1 Replace the `canPush` boolean with a capability object

```js
// Per-platform, per-league. Rendered off, not inferred.
caps: {
  read:        true,          // always
  writeLineup: false,
  writeAddDrop:false,
  writeWaiver: false,
  writeTrade:  false,
  faab:        true,          // vs rolling waiver priority
  taxi:        false,         // Sleeper-only concept
  ir:          true,
  liveDraft:  'push'|'poll'|'none',
  corsDirect:  true,          // can the browser call it, or must it proxy?
}
```

Every Command page renders its buttons off `caps`, and shows a platform-specific
fallback CTA ("Open in ESPN") where a cap is missing. This is the change that
makes read-only ESPN shippable *and* makes Yahoo a drop-in later.

### 0.2 Formalise the adapter

The shape already exists implicitly — `_getLeagueRostersUsers` (index.html:13336)
is a two-branch resolver today. Promote it:

```js
VaultPlatform.register('espn', {
  label:'ESPN', badge:'E', color:'#d50a0a',
  detect: lg => String(lg.league_id).startsWith('espn_'),
  caps: lg => ({...}),
  readLeague, readRosters, readMatchups, readFreeAgents, readTransactions,
  readDraft,
  pidToName, nameToPid,                    // id-space bridge
  fmtCtx: lg => ({dyn, sf, teams, ppr}),   // feeds fcCtxForLeague
  write: { lineup?, addDrop?, waiver?, trade? },
});
```

### 0.3 Keep names as the universal id space

`globalPidToName` / `normName` is why ESPN reads already work — every value,
grade and projection in Vault keys on name, not on a platform id. Each adapter
only owns its own pid↔name bridge. Do not let a second id space leak upward.

Note `_tcCtxFor` (index.html:19381) now memoises format context per `league_id`
and calls `fcCtxForLeague`, which reads Sleeper-shaped `roster_positions` /
`scoring_settings.rec` / `total_rosters`. Each adapter must produce that shape —
`vpMapEspnLeague` already does for roster positions; scoring needs adding.

---

## Part 1 — ESPN writes: is there a way in?

### The honest read of the evidence

Every published ESPN client is **read-only**: `cwendt94/espn-api` (Python),
`mkreiser/ESPN-Fantasy-Football-API` (JS), `ffscrapr` (R). Nobody has published
a working write client. The community endpoint lists document `lm-api-reads.…`
and say nothing about a writes host.

That is *not* proof it's impossible. It's proof nobody published it — which was
also true of Sleeper's `sleeper.com/graphql` before we did the work. The
difference is worth naming precisely:

- **Sleeper's** web client is a SPA hitting one private GraphQL endpoint with a
  bearer token. One endpoint, one auth header, uniform op shapes. That's why it
  fell quickly.
- **ESPN's** fantasy web client is also a browser SPA. Its lineup-set, add/drop
  and trade calls *are* ordinary HTTPS requests visible in DevTools. There is no
  native-app-only path and no client-side signing that we know of. The auth is
  cookie-based (`SWID` + `espn_s2`), which we already collect in the UI.

So the mechanism is almost certainly reachable. What's missing is **observation**,
not access.

### The blocker you named, and why it isn't one

> "I don't have an active ESPN league to test with."

Create one. It's free, takes about two minutes, and it's July — peak ESPN league
creation season, so 2026 leagues are fully live right now. Make it a **private
solo league where you are commissioner**:

- You're the only manager, so no real person is affected by a bad test write.
- As commissioner you can set waivers to FAAB *and* run a second league on
  rolling priority — that's the only way to test both waiver models, and it's a
  real gap in the current Waiver Command UI (it's FAAB-only).
- You can force roster states that are hard to find in the wild: full roster,
  IR-blocked, empty bench, mid-week lock.
- You control the draft, so `syncEspnDraft` gets a real live-draft target
  instead of a completed one.
- Set it private and you also get to exercise the SWID/espn_s2 server path,
  which is currently UI-only.

Make **two** leagues (one FAAB/PPR/1QB redraft, one 10-team/half-PPR, ideally
one with a superflex slot). That doubles as the fixture set for the
format-aware value work that just shipped.

This single step converts ESPN from "unknowable" to "a normal afternoon of
DevTools work."

### The discovery protocol

Exactly what we did for Sleeper, in order:

1. Log into `fantasy.espn.com` in a normal browser on the test league.
2. Open DevTools → Network → filter XHR/Fetch. **Preserve log.**
3. Perform one action at a time and capture the request in isolation:
   - swap a starter with a bench player → Save
   - add a free agent (no drop) — needs an open roster spot
   - add + drop together
   - place a waiver claim with a FAAB bid
   - place a claim in the rolling-priority league
   - propose a trade to the second team, then accept/reject it as that team
   - move a player to IR, and back
4. For each: right-click → **Copy as cURL**. That captures method, host, path,
   every header, and the exact body. Save all of them verbatim to
   `docs/espn-write-captures/`.
5. Replay each cURL from the terminal, unchanged. If it succeeds, the request is
   fully specified by cookies + headers + body — no client-side signing.
6. Then minimise: strip headers one at a time until it breaks. What's left is
   the real contract, and that's what the adapter implements.

Step 5 is the go/no-go. If a raw cURL replay works, ESPN writes are a build task.
If it fails, look for a CSRF/nonce token in a prior document fetch — recoverable,
just one more read in the chain.

### What we expect to find (to be verified, not assumed)

Based on the shape of the v3 API, the likely picture is a POST to a
`transactions` path under the league resource, with the action carried as a type
discriminator in the JSON body (lineup change, add, drop, add/drop, waiver claim
with bid, trade proposal), plus ESPN's `x-fantasy-*` headers and the two cookies.
**Do not build against this paragraph.** It is a hypothesis to confirm in step 4.

### Architecture, if the go/no-go passes

The backend already generalises. `functions/src/` splits cleanly into
platform-agnostic plumbing (`connection.ts`, `queue.ts`, `executor.ts`,
`actions.ts`) and a platform folder (`sleeper/{auth,client,queries,mutations}.ts`).
Add `espn/{auth,client,mutations}.ts` in the same shape and make `actions.ts`
dispatch on a `platform` field.

What carries over unchanged: AES-encrypted credential storage, the per-user
throttle (`THROTTLE_GAP_MS` + jitter), the batch queue and drainer, rate limits
in `LIMITS`, App Check, the ownership checks.

What's new and ESPN-specific:

- **Credential model.** Two cookies, not one token. Store the pair encrypted in
  a parallel `espnTokens/{uid}` collection.
- **Expiry.** `espn_s2` is long-lived but rotates on password change and logout.
  Needs a "reconnect ESPN" flow with clear expiry detection (401 → mark stale →
  prompt), which is more user-facing friction than Sleeper's token.
- **Waiver duality.** FAAB *and* rolling priority. Waiver Command's UI assumes
  FAAB (`cx-faab` bar, bid input at index.html:19860). Needs a priority variant
  driven by `caps.faab`.
- **No taxi.** ESPN has no taxi squad. Taxi Manager stays Sleeper-only via
  `caps.taxi`.

### Risk, stated plainly

ESPN writes are undocumented and unsanctioned. They can break without notice,
and a bad burst against a user's account carries more consequence than a read
does. Mitigations: reuse the existing throttle rather than loosening it for a
new platform, keep every write behind an explicit user confirmation, and make
the failure mode a clear "couldn't reach ESPN — do it in the app" rather than a
silent retry.

### The fallback, and it's a good one

If step 5 fails, or you decide the maintenance risk isn't worth it: **ship ESPN
read-only and say so in the UI.** With Phase 0's `caps` object this is mostly
free, and it's genuinely valuable on its own:

- Waiver Command: full best-available scan, upgrade deltas, FAAB context →
  "Open in ESPN" instead of "Claim"
- Lineup Command: the optimizer runs and shows the exact swaps → user makes them
- Trade Center: full trade evaluation on ESPN rosters → propose in ESPN
- Portfolio, League tab, Draft Vault, values, grades: already work

The only new build is an ESPN free-agent source to replace the Sleeper
`/rosters` diff in `_wcLoadLeague` (index.html:19675) — ESPN exposes a player
pool filtered by availability via the `x-fantasy-filter` header.

**Recommendation:** create the test leagues, spend one afternoon on the
discovery protocol, and let the cURL replay decide. Build Tier 1 (read-only)
regardless — it's the fallback and the foundation, and it ships either way.

---

## Part 2 — Yahoo across all of Vault

### Why Yahoo is technically the easiest and operationally the hardest

Yahoo has a **real, official, documented, supported** Fantasy Sports API with
full write support. No reverse engineering, no cookie scraping, no risk of a
silent breaking change. That's a much better foundation than either Sleeper or
ESPN.

The costs are different in kind:

1. **OAuth2, properly.** Registered app with client id/secret, a real redirect
   flow, access tokens that expire hourly, refresh tokens to rotate. Vault has
   never done this — Sleeper is paste-a-token, ESPN would be paste-cookies.
2. **No CORS.** Yahoo's API does not permit browser-origin requests. **Every
   Yahoo call — reads included — must go through Cloud Functions.** This is the
   single biggest architectural consequence and it drives everything below.
3. **Verbose payloads.** XML by default (`?format=json` available), deeply
   nested, with its own key scheme: `{game_key}.l.{league_id}` for leagues,
   `.t.{team_id}` for teams, `{game_key}.p.{player_id}` for players.

### 2.1 Server-side-first architecture

Sleeper and ESPN both read directly from the browser and only proxy writes.
Yahoo can't. So Yahoo needs a **read proxy with a cache**, which Vault doesn't
have yet.

```
functions/src/yahoo/
  auth.ts        OAuth2: authorize URL, code exchange, refresh, revoke
  client.ts      signed fetch + auto-refresh on 401 + JSON coercion
  queries.ts     leagues, settings, rosters, scoreboard, players, transactions
  mutations.ts   lineup PUT, add/drop POST, waiver claim, trade propose/respond
  cache.ts       Firestore-backed response cache, per-resource TTL
```

New callables mirroring the Sleeper set:

```
yahooAuthUrl()                  -> { url, state }
yahooExchangeCode({ code })     -> Connection
yahooDisconnect()               -> { connected:false }
yahooStatus()                   -> Connection      (never returns tokens)
yahooRead({ resource, params }) -> cached JSON
executeYahooAction({ action })  -> { ok, data }
enqueueYahooActions({ actions })
```

`executor.ts` and `queue.ts` are reused as-is — they're already
platform-agnostic. `actions.ts` gains a `platform` discriminator.

**Caching is mandatory, not an optimisation.** Every roster paint that was a
free browser fetch on Sleeper becomes a billed function invocation on Yahoo.
Suggested TTLs, in Firestore keyed by `{uid}/{resource}`:

| Resource | TTL |
|---|---|
| League settings | 24h |
| Teams / standings | 1h |
| Rosters | 5 min (0 immediately after a write) |
| Scoreboard / matchups | 5 min in-season |
| Free agent pool | 15 min |
| Transactions | 10 min |
| Player universe | 24h |

Invalidate on write, same as `pfMarkRosterDirty` does for Sleeper.

### 2.2 Auth flow

Vault is a static site on `vaultfantasy.com` (GitHub Pages) with Firebase
Functions behind it. Redirect URI should point at an HTTPS callback the app
controls — either a Function or a `/yahoo-callback` page on the domain that
posts the code back to `yahooExchangeCode`. Never let the client see the client
secret or the refresh token; `yahooStatus()` returns connection metadata only,
exactly as `sleeperStatus()` does.

Tokens stored encrypted in `yahooTokens/{uid}` using the existing AES helper and
`SLEEPER_ENC_KEY` pattern (rename the secret to `VAULT_ENC_KEY` while you're in
there, or add a second one). Access tokens expire hourly — `client.ts` refreshes
transparently and only surfaces a reconnect prompt when the refresh itself fails.

### 2.3 Data mapping

Everything downstream stays name-keyed. The adapter's job is to produce
Sleeper-shaped objects, exactly as `buildEspnContext` (index.html:13303) already
does for ESPN.

| Vault concept | Yahoo source |
|---|---|
| League list | `/users;use_login=1/games;game_keys=nfl/leagues` |
| League settings | `/league/{key}/settings` |
| `roster_positions` | settings → roster positions (QB/RB/WR/TE/W-R-T/Q-W-R-T→SUPER_FLEX/BN/IR) |
| `total_rosters` | settings → num_teams |
| `scoring_settings.rec` | settings → stat modifiers, stat_id 11 (receptions) |
| dynasty vs redraft | settings → keeper/dynasty flags; heuristic fallback like `_isDynastyLeague` |
| Teams / users | `/league/{key}/teams` |
| Roster + starters | `/team/{key}/roster;week=N` — `selected_position` gives the slot |
| Matchups | `/league/{key}/scoreboard;week=N` |
| Free agents | `/league/{key}/players;status=A;sort=AR` |
| Transactions | `/league/{key}/transactions` |
| Draft results | `/league/{key}/draftresults` |
| FAAB | team → `faab_balance`; league → waiver type |

Player key `{game_key}.p.{id}` → name via the player resource, cached 24h. That
becomes `yahooPidToName`, sitting alongside `globalPidToName`.

Superflex detection: Yahoo's flex slot is `Q/W/R/T` — that maps to
`SUPER_FLEX`, which `fcCtxForLeague` (index.html:15339) already keys on. Get
this right or every Yahoo SF league gets 1QB values, which is the exact bug that
just got fixed for Sleeper.

### 2.4 Writes

All four Command-page actions are officially supported:

- **Lineup** — `PUT /team/{key}/roster` with each player's target
  `selected_position` for the week.
- **Add / drop / add-drop** — `POST /league/{key}/transactions`.
- **Waiver claim** — same transactions collection, with a FAAB bid where the
  league uses FAAB. Yahoo also supports rolling priority, so the same
  `caps.faab` split ESPN needs applies here.
- **Trades** — propose via transactions; accept / reject / cancel via
  `PUT /transaction/{key}`.

Payloads are XML. Keep a small builder in `mutations.ts` rather than string
concatenation at call sites, and mirror the `sleeper/mutations.ts` pattern:
one exported action type per operation, validated params, ownership check
against the user's own team key.

### 2.5 Feature-by-feature rollout

Ordered so each phase ships something usable.

**Phase Y1 — Connect + read (leagues visible everywhere)**
- OAuth flow + `yahooStatus` + connect panel in the platform picker
  (index.html:3819 already has the two-platform layout; add a third)
- `yahooRead` + cache + league/roster/settings mapping
- Lights up with no further work: **Portfolio**, **League tab** (power rankings,
  draft grades, movers), **My Team / Roster Preview**, **Trade Calculator**,
  **Research**, **My Rankings**, **Player Profiles**, **Advanced Stats**,
  **Season Sim** — all of these consume the Sleeper-shaped league context, not
  the platform.
- `caps.write*` all false → Command pages show Yahoo leagues in advisory mode.

**Phase Y2 — Free agents + Waiver Command (read)**
- Yahoo FA pool feeds `_wcLoadLeague`
- Full best-available scan and upgrade deltas, "Open in Yahoo" CTA
- FAAB vs rolling-priority UI split (shared with ESPN)

**Phase Y3 — Writes**
- Lineup push → Lineup Command fully live
- Add/drop + waiver claim → Waiver Command fully live
- Trade propose/accept/reject → Trade Center fully live
- Taxi Manager stays hidden (`caps.taxi:false` — Yahoo has no taxi squad)

**Phase Y4 — Draft**
- Yahoo has no public live-draft websocket. Poll `/league/{key}/draftresults`
  on the same cadence as ESPN (30s) into the same board — `syncEspnDraft`
  (index.html:9646) is the template; `caps.liveDraft:'poll'`.
- Yahoo ADP as a fourth source in the ADP Explorer alongside FFC/ESPN/Sleeper
  (index.html:5178).

**Phase Y5 — Cross-platform polish**
- Portfolio spanning Sleeper + ESPN + Yahoo in one view (`fcValueFor` already
  takes an explicit ctx per league, so this works today)
- Platform badges everywhere a league is listed (`vp-plat-badge` at
  index.html:8940 already does two — generalise)
- Per-platform filter chips (index.html:4035)

### 2.6 What stays Sleeper-only

Be explicit in the UI rather than degrading silently:

- **Taxi Manager** — Sleeper concept; ESPN and Yahoo have no equivalent
- **Real-time draft** — Sleeper pushes; ESPN and Yahoo poll
- **Pending trade offers before acceptance** — Sleeper needs the authed GraphQL
  read; Yahoo exposes pending trades officially, ESPN unknown until discovery

---

## Sequencing

| # | Work | Unblocks |
|---|---|---|
| 1 | Phase 0 adapter + `caps` | everything |
| 2 | ESPN read-only in Command pages | immediate user value, zero risk |
| 3 | Create ESPN test leagues + discovery protocol | the ESPN write go/no-go |
| 4 | ESPN writes *(iff step 3 passes)* | ESPN parity |
| 5 | Yahoo Y1–Y2 | Yahoo leagues visible + advisory |
| 6 | Yahoo Y3–Y5 | Yahoo parity |

Steps 1 and 2 are worth doing this week regardless of how 3 and 4 land.
