# Yahoo setup — the manual steps

The backend plumbing is built and compiles. It cannot run until a Yahoo app
exists, because OAuth needs a client id/secret that only you can create.
Three steps, ~10 minutes.

---

## 1. Register the Yahoo app

Go to <https://developer.yahoo.com/apps/create/> (sign in with the Yahoo
account you want to develop under — it does NOT have to be the account whose
leagues you test with).

| Field | Value |
|---|---|
| Application Name | `Vault Fantasy` |
| Application Type | **Web Application** |
| Redirect URI(s) | `https://vaultfantasy.com/yahoo-callback.html` |
| API Permissions | **Fantasy Sports** → **Read/Write** |

Two things that will waste an afternoon if you get them wrong:

- **The redirect URI must match character for character.** `http` vs `https`,
  a trailing slash, `www.` — any drift and the token exchange fails with
  `invalid_grant` and no useful message. It must equal `YAHOO_REDIRECT_URI`
  in [functions/src/config.ts](../functions/src/config.ts).
- **Pick Read/Write, not Read.** A read-only grant looks fine until the first
  lineup push returns 403, and changing the permission means every user
  re-consents.

Yahoo does not allow `localhost` redirect URIs on web apps. To exercise the
flow locally, either register a second app with a tunnel URL (ngrok/cloudflared)
as its redirect, or test the OAuth leg on the deployed site and develop
everything downstream against a connected account.

Save the **Client ID (Consumer Key)** and **Client Secret (Consumer Secret)**.

---

## 2. Store the credentials as Firebase secrets

```bash
cd functions
firebase functions:secrets:set YAHOO_CLIENT_ID       # paste the Consumer Key
firebase functions:secrets:set YAHOO_CLIENT_SECRET   # paste the Consumer Secret
```

The client secret is never sent to the browser — `yahooAuthUrl` builds the
consent URL server-side and `yahooExchangeCode` does the token swap. Nothing
in `auth/vault-yahoo.js` ever sees it.

The existing `SLEEPER_ENC_KEY` doubles as the app-wide AES key and now also
encrypts the Yahoo tokens at rest, so there is nothing new to create there.

---

## 3. Deploy

```bash
cd functions && npm run build && npm run deploy
firebase deploy --only firestore:rules
```

Optional but recommended — set a Firestore **TTL policy** on:

- `users/{uid}/yahooCache` → field `expiresAt`

The cache already refuses to serve entries past their TTL, so this is purely
about not paying to store dead rows forever.

---

## 4. Smoke test, in order

Each step isolates one failure mode; running them out of order makes a broken
redirect URI look like a broken token exchange.

1. **Consent URL** — call `VaultYahoo.beginConnect()` from the console on the
   deployed site. The popup should reach Yahoo's consent screen showing
   "Vault Fantasy" and Fantasy Sports read/write. If it 400s here, the
   client id or redirect URI is wrong.
2. **Exchange** — approve. The popup should flash "Yahoo connected" and
   close. `VaultYahoo.status()` should then return `{connected:true, guid:…}`.
   A failure here with `invalid_grant` is almost always the redirect URI.
3. **Read** — `await VaultYahoo.myLeagues()`. Should return your Yahoo NFL
   leagues. Call it twice: the second response should come back
   `cached: true`.
4. **Refresh** — the access token lives one hour. Either wait, or temporarily
   drop `expiresAt` in the `yahooTokens/{uid}` doc to a past timestamp, then
   read again. It should succeed transparently. Confirm the doc's `refresh`
   ciphertext CHANGED — Yahoo rotates the refresh token on every use, and
   silently keeping the old one breaks the connection on the *next* refresh,
   an hour later, far from the cause.
5. **Ownership guard** — call `VaultYahoo.setLineup()` with a team key from a
   league you're not in. Expect `permission-denied`, not a Yahoo error.
6. **Write** — a real lineup push on a test team, then
   `VaultYahoo.roster(teamKey, week)` and confirm it reflects the change
   immediately (the write invalidates the cached roster).

---

## What exists now

Backend, all compiling and unit-checked:

| File | Role |
|---|---|
| `functions/src/yahoo/auth.ts` | OAuth2 URL building, code exchange, refresh, HMAC state |
| `functions/src/yahoo/client.ts` | Authenticated fetch, transparent refresh, error mapping |
| `functions/src/yahoo/queries.ts` | Allowlisted read registry + per-resource cache TTLs |
| `functions/src/yahoo/mutations.ts` | Write registry + XML builders + cache invalidation map |
| `functions/src/yahoo/cache.ts` | Firestore response cache (prefix invalidation) |
| `functions/src/yahoo/executor.ts` | Session handling, ownership check, the one call path |
| `functions/src/yahoo/callables.ts` | The six exported callables |
| `functions/src/lib/yahooTokens.ts` | Encrypted grant storage + write throttle |
| `auth/vault-yahoo.js` | Frontend wrapper (`window.VaultYahoo`) |
| `yahoo-callback.html` | OAuth redirect target (relays code to the opener) |

Reused unchanged: the AES helper, the rate limiter, App Check, and the
`toHttpsError` mapping.

## What's next

1. **Phase 0 adapter** — `caps` object replacing `canPush`, so Yahoo leagues
   can appear in the Command pages in advisory mode before any writes ship.
   See [multi-platform-plan.md](multi-platform-plan.md).
2. **Yahoo → Sleeper-shaped mapping** — Yahoo's JSON is a positional-object
   tree, not clean arrays. Needs a parser producing the same league context
   `buildEspnContext` already produces for ESPN.
3. **Superflex detection** — Yahoo's `Q/W/R/T` slot must map to `SUPER_FLEX`
   or every Yahoo SF league inherits the 1QB-pricing bug fixed in `dcfca81`.
