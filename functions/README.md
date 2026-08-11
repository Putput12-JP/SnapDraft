# Vault Sleeper Backend (Cloud Functions)

Server-side backend that lets Vault take actions on a user's behalf in **Sleeper**
— lineup changes, taxi/dev moves, waiver claims, trades, draft-queue edits — by
calling Sleeper's **private GraphQL API** (`https://sleeper.com/graphql`) with the
user's own Sleeper token.

Reverse-engineered 1:1 from the Sleeper web client. There is no official Sleeper
write API; this is the same private surface the Sleeper app itself uses.

## Why a backend (vs. calling Sleeper from the browser)

Statchasers serves the raw Sleeper token to the browser and calls Sleeper client-side.
We do better: **the token never leaves the server.** It's stored encrypted, and every
Sleeper call is made server-to-server from a Cloud Function. The browser only ever
sees connection *status*, never the token.

## Architecture

```
Browser (Firebase Auth)
  │  httpsCallable
  ▼
Cloud Functions ──► Firestore  sleeperTokens/{uid}   (AES-256-GCM, admin-only)
  │                 Firestore  users/{uid}/sleeperJobs/{id} (throttled queue)
  ▼
https://sleeper.com/graphql   (authorization: <user token>)
```

- **`connectSleeper({token, username})`** — user pastes their own Sleeper token +
  username; we resolve the userId via the public API and store the token encrypted.
  (No password, no captcha — the low-liability path.)
- **`disconnectSleeper()`** / **`sleeperStatus()`** — manage/inspect the connection.
- **`executeSleeperAction({action})`** — one action, immediate, per-user rate-limited.
  For a single interactive change (one lineup swap).
- **`enqueueSleeperActions({actions})`** — a batch; the scheduled `drainSleeperQueue`
  executes them spaced apart (throttled) so Sleeper never sees a burst. For
  "optimize all my leagues".

### Action shapes (`action.type`)
| type | params |
|---|---|
| `update_starters` | `leagueId, rosterId, starters[]` |
| `update_taxi` | `leagueId, rosterId, taxi[]` |
| `update_draft_queue` | `draftId, playerIds[]` |
| `accept_trade` | `leagueId, transactionId, leg` |
| `reject_trade` | `leagueId, transactionId, leg` |
| `submit_waiver_claim` | `leagueId, rosterId, adds{}, drops{}, settings{}` |
| `propose_trade` | `leagueId, rosterId, rosterIds[], adds{}, drops{}, draftPicks[], waiverBudget[]` |

`update_starters` is **live-verified**. `submit_waiver_claim` and `propose_trade`
have confirmed GraphQL signatures, but the key/value array **semantics** (esp. FAAB
bid encoding and player→roster mapping) should be dry-run confirmed before wiring to
a real submit button.

### Safety
- **Ownership check**: before any roster write we confirm the target `rosterId` is
  owned/co-owned by the connected Sleeper user (via the public rosters API).
- **Throttle**: per-user cooldown (`THROTTLE_GAP_MS`) on the instant path; spaced
  `runAfter` + paced drainer on the queue. Tune in `src/config.ts`.
- **Token at rest**: AES-256-GCM with a key in Firebase Secret Manager.

## Setup / Deploy

> Requires the **Blaze** (pay-as-you-go) plan — Cloud Functions can only make
> outbound calls to `sleeper.com` on Blaze, and the scheduler needs Cloud
> Scheduler/Pub-Sub. Free tier still covers typical usage.

```bash
# 0. from repo root
firebase use vault-fantasy          # or: firebase use --add

# 1. encryption key (32 bytes / 64 hex chars)
openssl rand -hex 32                 # copy the output
firebase functions:secrets:set SLEEPER_ENC_KEY   # paste it when prompted

# 2. install + build
cd functions && npm install && npm run build && cd ..

# 3. deploy rules + index (index build can take a few minutes)
firebase deploy --only firestore:rules,firestore:indexes

# 4. deploy functions
firebase deploy --only functions
```

⚠️ `firestore.rules` here is version-controlled and will **replace** whatever is in
the Firebase console. It preserves the existing auth-sync rule (`users/{uid}/kv/**`)
and adds token/queue lockdown — but review it against your console before deploying.

## ESPN (private leagues)

ESPN has no official API and no OAuth. Auth is the browser cookie pair
`SWID` + `espn_s2`. A **public** league reads straight from the browser; this
backend exists only to attach those cookies **server-side** so a **private**
league becomes readable (the browser can't send them cross-site).

Callables (read-only — ESPN writes are gated on the discovery protocol in
`docs/multi-platform-plan.md`, not built here):

```js
const connect = fns.httpsCallable('connectEspn');
// Verifies the pair against the league, then stores it AES-encrypted.
await connect({ swid: '{…}', s2: 'AEB…', leagueId: '31581238', season: '2026' });

const read = fns.httpsCallable('espnRead');
const { data } = (await read({ query: {
  type: 'league', leagueId: '31581238', season: '2026'
}})).data;                       // raw ESPN v3 JSON — mapped client-side

// espnStatus() -> { connected, verified, swidHint };  disconnectEspn()
```

**No new secret.** ESPN cookies are wrapped with the same `SLEEPER_ENC_KEY`
and stored at `espnTokens/{uid}` (locked down in `firestore.rules`). So
shipping ESPN is just a redeploy of functions + rules — no `secrets:set` step:

```bash
firebase deploy --only functions,firestore:rules
```

## Frontend wiring (later)

```js
const fns = firebase.app().functions(); // default region us-central1
const connect = fns.httpsCallable('connectSleeper');
await connect({ token: pastedToken, username: 'Putput' });

const exec = fns.httpsCallable('executeSleeperAction');
const res = await exec({ action: {
  type: 'update_starters', leagueId, rosterId, starters
}});
```

Watch queued job status by reading `users/{uid}/sleeperJobs/*` (client read-only).

## Local dev
```bash
cd functions && npm run serve   # emulators (set SLEEPER_ENC_KEY in the emulator env)
```
