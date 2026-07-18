// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — Sleeper write backend (Cloud Functions entrypoint).
// ═══════════════════════════════════════════════════════════════
//
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
// See README.md for setup (Blaze plan, SLEEPER_ENC_KEY secret, indexes).

export {
  connectSleeper,
  sleeperRequestCode,
  sleeperVerifyCode,
  disconnectSleeper,
  sleeperStatus,
} from "./connection";
export { executeSleeperAction, enqueueSleeperActions } from "./actions";
export { drainSleeperQueue } from "./queue";
