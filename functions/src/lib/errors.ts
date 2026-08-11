// Map internal typed errors -> client-facing HttpsError codes.
import { HttpsError } from "firebase-functions/v2/https";
import { ValidationError } from "../sleeper/mutations";
import { SleeperAuthError, SleeperApiError } from "../sleeper/client";
import { OwnershipError, NotConnectedError } from "../executor";
import { ValidationError as YahooValidationError } from "../yahoo/mutations";
import { YahooAuthError, YahooApiError } from "../yahoo/auth";
import { YahooOwnershipError, YahooNotConnectedError } from "../yahoo/executor";
import { EspnAuthError, EspnApiError } from "../espn/client";

export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof ValidationError) return new HttpsError("invalid-argument", e.message);
  if (e instanceof OwnershipError) return new HttpsError("permission-denied", e.message);
  if (e instanceof NotConnectedError)
    return new HttpsError("failed-precondition", e.message);
  if (e instanceof SleeperAuthError)
    return new HttpsError("unauthenticated", `Sleeper connection invalid — reconnect. (${e.message})`);
  if (e instanceof SleeperApiError) return new HttpsError("unavailable", e.message);

  // ── Yahoo ──
  if (e instanceof YahooValidationError) return new HttpsError("invalid-argument", e.message);
  if (e instanceof YahooOwnershipError) return new HttpsError("permission-denied", e.message);
  if (e instanceof YahooNotConnectedError)
    return new HttpsError("failed-precondition", e.message);
  if (e instanceof YahooAuthError)
    return new HttpsError("unauthenticated", `Yahoo connection invalid — reconnect. (${e.message})`);
  // Yahoo surfaces actionable rejections ("Player is on waivers", "Roster is
  // illegal") as API errors, so this message is meant to reach the user.
  if (e instanceof YahooApiError) return new HttpsError("unavailable", e.message);

  // ── ESPN ──
  if (e instanceof EspnAuthError)
    return new HttpsError("unauthenticated", `ESPN connection expired — reconnect. (${e.message})`);
  if (e instanceof EspnApiError) return new HttpsError("unavailable", e.message);

  return new HttpsError("internal", (e as Error)?.message ?? "Unexpected error");
}
