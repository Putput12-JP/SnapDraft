// ═══════════════════════════════════════════════════════════════
// Shared configuration & constants
// ═══════════════════════════════════════════════════════════════

/** Sleeper's private GraphQL endpoint — the same one the Sleeper app uses. */
export const SLEEPER_GRAPHQL_URL = "https://sleeper.com/graphql";

/** Sleeper's public, read-only REST API (no auth needed). */
export const SLEEPER_PUBLIC_API = "https://api.sleeper.app/v1";

// ── Yahoo ─────────────────────────────────────────────────────
// Unlike Sleeper and ESPN, Yahoo's Fantasy API is official and documented,
// but it sends no CORS headers — the browser cannot call it at all. So
// EVERY Yahoo call, reads included, proxies through these functions. That
// is why Yahoo (and only Yahoo) needs a server-side response cache: a
// roster paint that costs nothing on Sleeper costs an invocation here.

/** Yahoo Fantasy Sports API v2 root. Append `?format=json` on reads. */
export const YAHOO_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
/** OAuth2 authorization endpoint (user-facing consent screen). */
export const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
/** OAuth2 token endpoint — authorization_code and refresh_token grants. */
export const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
/** NFL game key. Yahoo also accepts per-season numeric ids; "nfl" tracks current. */
export const YAHOO_NFL_GAME_KEY = "nfl";

/**
 * Where Yahoo sends the user back after consent. Must match the redirect
 * URI registered on the Yahoo app EXACTLY (scheme, host, path, no trailing
 * slash drift) or the token exchange fails with invalid_grant.
 */
export const YAHOO_REDIRECT_URI = "https://vaultfantasy.com/yahoo-callback.html";

/** Access tokens live 1h; refresh this many ms early to avoid racing expiry. */
export const YAHOO_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Yahoo pages free-agent/player queries at 25 per request — hard API cap. */
export const YAHOO_PLAYER_PAGE_SIZE = 25;
/** Max pages one free-agent scan will walk (25 * 12 = 300 players deep). */
export const YAHOO_MAX_PLAYER_PAGES = 12;

// ── Throttling ────────────────────────────────────────────────
// Sleeper's private API will rate-limit / flag accounts that fire
// bursts of writes. We deliberately space writes out. These govern
// both the single-action executor (per-user cooldown) and the batch
// queue drainer (gap between successive Sleeper calls).

/** Minimum gap between two Sleeper writes for the same user (ms). */
export const THROTTLE_GAP_MS = 3000;
/** Extra random jitter added on top of the gap (ms), 0..JITTER. */
export const THROTTLE_JITTER_MS = 2000;
/** Max Sleeper calls a single queue-drain invocation will make. */
export const MAX_CALLS_PER_DRAIN = 40;
/** Max attempts before a queued job is marked permanently failed. */
export const MAX_JOB_ATTEMPTS = 3;

// ── Firestore collections ─────────────────────────────────────
/** Admin-only doc holding the encrypted Sleeper token. Clients CANNOT read this. */
export const TOKENS_COLLECTION = "sleeperTokens"; // sleeperTokens/{uid}
/** Admin-only doc holding the encrypted Yahoo OAuth tokens. Clients CANNOT read this. */
export const YAHOO_TOKENS_COLLECTION = "yahooTokens"; // yahooTokens/{uid}
/** Cached Yahoo API responses, keyed by uid + resource. Server-only. */
export const YAHOO_CACHE_SUBCOLLECTION = "yahooCache"; // users/{uid}/yahooCache/{key}
/** Per-user job queue. Clients may READ their own jobs (status UI) but not write them. */
export const JOBS_SUBCOLLECTION = "sleeperJobs"; // users/{uid}/sleeperJobs/{jobId}
/** Admin-only rate-limit counters. Clients CANNOT read or write these. */
export const RATE_LIMITS_COLLECTION = "rateLimits"; // rateLimits/{bucket__hash}

/** Secret (Firebase Secret Manager) holding the 32-byte AES key as 64 hex chars. */
// Named for Sleeper historically; it is the app-wide key at rest and now also
// wraps Yahoo's OAuth tokens. Left as-is because rotating a Secret Manager name
// means re-granting and redeploying every function that binds it.
export const ENC_KEY_SECRET = "SLEEPER_ENC_KEY";
/** Secret holding the Yahoo app's Consumer Key (client_id). */
export const YAHOO_CLIENT_ID_SECRET = "YAHOO_CLIENT_ID";
/** Secret holding the Yahoo app's Consumer Secret. Never leaves the server. */
export const YAHOO_CLIENT_SECRET_SECRET = "YAHOO_CLIENT_SECRET";

// ── Callable hardening ────────────────────────────────────────

/**
 * Require a valid App Check token on every callable.
 *
 * Leave false until the client side is live, then flip and redeploy:
 *   1. Firebase console → App Check → Apps → register the web app with
 *      reCAPTCHA v3, which gives you a SITE key.
 *   2. Paste that key as VF_APPCHECK_SITE_KEY in auth/firebase-config.js
 *      and ship it. The client starts sending tokens immediately; nothing
 *      is rejected yet, because enforcement is still off here.
 *   3. Watch App Check → APIs → Cloud Functions for a few days. Once the
 *      "verified" share is ~100%, set this to true and `npm run deploy`.
 *
 * Flipping this before step 2 is deployed locks every user out of Sleeper.
 */
export const ENFORCE_APP_CHECK = false;

/**
 * Ceiling on concurrent instances per callable. The real purpose is
 * billing: without it a burst (malicious or a runaway client loop) scales
 * out unbounded on Blaze. Solo-scale traffic never approaches this.
 */
export const MAX_INSTANCES = 10;

// ── Rate limits ───────────────────────────────────────────────
// Budgets per window. `PerTarget` keys on the email/phone a code would be
// sent to rather than the caller, so spinning up fresh Vault accounts
// doesn't buy more attempts against the same victim.

export const LIMITS = {
  /** Codes one account may request, across all targets. */
  requestCodePerUser: { max: 5, windowMs: 60 * 60 * 1000 },
  /** Codes anyone may cause to be sent to ONE email/phone. Anti-bombing. */
  requestCodePerTarget: { max: 3, windowMs: 60 * 60 * 1000 },
  /** Code submissions. A 6-digit code is 1M combos — cap the guessing. */
  verifyCodePerUser: { max: 10, windowMs: 15 * 60 * 1000 },
  /** Token pastes / reconnects. */
  connectPerUser: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Read queries proxied to Sleeper with the user's token. */
  readPerUser: { max: 120, windowMs: 60 * 1000 },
  /** Batch submissions (each may carry up to MAX_BATCH actions). */
  enqueuePerUser: { max: 20, windowMs: 60 * 60 * 1000 },
  /** Single immediate writes, on top of the existing 3s cooldown. */
  actionPerUser: { max: 300, windowMs: 60 * 60 * 1000 },
  /**
   * Yahoo reads. Higher ceiling than Sleeper's because on Yahoo this path
   * carries ordinary page paints, not just the handful of authenticated
   * reads the public API can't serve. The cache absorbs most repeats, so a
   * user who trips this is looping, not browsing.
   */
  yahooReadPerUser: { max: 300, windowMs: 60 * 1000 },
  /** Yahoo OAuth exchanges (connect / reconnect). */
  yahooConnectPerUser: { max: 10, windowMs: 60 * 60 * 1000 },
} as const;
