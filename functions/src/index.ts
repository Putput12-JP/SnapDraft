// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — fantasy-platform backend (Cloud Functions entrypoint).
// ═══════════════════════════════════════════════════════════════
//
// ── Sleeper ──
// Connection management:
//   connectSleeper({ token, username })   -> Connection
//   disconnectSleeper()                   -> { connected: false }
//   sleeperStatus()                       -> Connection   (never returns token)
//
// Writes:
//   executeSleeperAction({ action })      -> { ok, data }  (instant, throttled)
//   enqueueSleeperActions({ actions })    -> { ok, jobIds } (batch, drained)
//
// Background:
//   drainSleeperQueue                     -> scheduled queue drainer
//
// ── Yahoo ──
// Unlike Sleeper, Yahoo's API is official and OAuth2-based — but it sends no
// CORS headers, so EVERY Yahoo call including reads proxies through here.
// That's why the Yahoo surface has a cached read callable and Sleeper doesn't.
//
//   yahooAuthUrl()                   -> { url, state }  start consent
//   yahooExchangeCode({code,state})  -> Connection      finish consent
//   yahooDisconnect() / yahooStatus()
//   yahooRead({ query, force })      -> { data, cached }
//   executeYahooAction({ action })   -> { ok, response }
//
// See README.md for setup (Blaze plan, SLEEPER_ENC_KEY secret, indexes) and
// docs/multi-platform-plan.md for the platform rollout.

export {
  connectSleeper,
  sleeperRequestCode,
  sleeperVerifyCode,
  disconnectSleeper,
  sleeperStatus,
} from "./connection";
export { executeSleeperAction, enqueueSleeperActions, sleeperRead } from "./actions";
export { drainSleeperQueue } from "./queue";

export {
  yahooAuthUrl,
  yahooExchangeCode,
  yahooDisconnect,
  yahooStatus,
  yahooRead,
  executeYahooAction,
} from "./yahoo/callables";
