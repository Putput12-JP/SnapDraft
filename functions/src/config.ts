// ═══════════════════════════════════════════════════════════════
// Shared configuration & constants
// ═══════════════════════════════════════════════════════════════

/** Sleeper's private GraphQL endpoint — the same one the Sleeper app uses. */
export const SLEEPER_GRAPHQL_URL = "https://sleeper.com/graphql";

/** Sleeper's public, read-only REST API (no auth needed). */
export const SLEEPER_PUBLIC_API = "https://api.sleeper.app/v1";

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
/** Per-user job queue. Clients may READ their own jobs (status UI) but not write them. */
export const JOBS_SUBCOLLECTION = "sleeperJobs"; // users/{uid}/sleeperJobs/{jobId}

/** Secret (Firebase Secret Manager) holding the 32-byte AES key as 64 hex chars. */
export const ENC_KEY_SECRET = "SLEEPER_ENC_KEY";
