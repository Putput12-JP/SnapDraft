// ═══════════════════════════════════════════════════════════════
// Sleeper passwordless auth (verification-code login).
// ═══════════════════════════════════════════════════════════════
// Reverse-engineered 1:1 from Sleeper's own web client (live-captured):
//   endpoint: https://api.sleeper.app/graphql
//   1) create_verification_code(email_or_phone, captcha)  -> sends a code
//   2) login(email_or_phone_or_username, password, captcha) -> { token }
//      where `password` is the 6-digit code the user received.
// One hCaptcha solve (sitekey 3bb6d565-5eb0-425f-acf8-64374f8bbc7b) is
// reused for both calls. No real password is ever involved.
//
// Framework-agnostic (no Firebase imports).

import { SleeperAuthError, SleeperApiError } from "./client";

export const SLEEPER_AUTH_GRAPHQL_URL = "https://api.sleeper.app/graphql";
/** Sleeper's hCaptcha sitekey — render the widget with this on the client. */
export const SLEEPER_HCAPTCHA_SITEKEY = "3bb6d565-5eb0-425f-acf8-64374f8bbc7b";

async function authGraphQL(
  op: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(SLEEPER_AUTH_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sleeper-graphql-op": op,
      },
      body: JSON.stringify({ operationName: op, query, variables }),
    });
  } catch (e) {
    throw new SleeperApiError(`Network error calling Sleeper auth: ${(e as Error).message}`);
  }

  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SleeperApiError(`Sleeper auth returned non-JSON (HTTP ${resp.status})`);
  }

  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
    // Sleeper reports bad code / captcha / rate limits as GraphQL errors.
    if (/captcha/i.test(msg)) throw new SleeperAuthError(`Captcha rejected: ${msg}`);
    if (/code|verification|invalid|incorrect|expired/i.test(msg)) {
      throw new SleeperAuthError(msg);
    }
    throw new SleeperApiError(msg || "Sleeper auth error");
  }
  if (!resp.ok) throw new SleeperApiError(`Sleeper auth HTTP ${resp.status}`);
  return (json?.data ?? {}) as Record<string, unknown>;
}

/**
 * Step 1 — ask Sleeper to send a verification code to the account's
 * registered email/phone. `identifier` may be an email or phone.
 */
export async function requestVerificationCode(
  identifier: string,
  captcha: string
): Promise<void> {
  await authGraphQL(
    "create_verification_code",
    `mutation create_verification_code($email_or_phone: String!, $captcha: String) {
  create_verification_code(email_or_phone: $email_or_phone, captcha: $captcha)
}`,
    { email_or_phone: identifier, captcha }
  );
}

/**
 * Step 2 — exchange the code for a Sleeper token. `identifier` may be an
 * email, phone, or username; `code` is the 6-digit value the user received
 * (submitted in Sleeper's `password` field). Returns the token string.
 */
export async function loginWithCode(
  identifier: string,
  code: string,
  captcha?: string
): Promise<string> {
  const data = await authGraphQL(
    "login",
    `query login($email_or_phone_or_username: String!, $password: String!, $captcha: String) {
  login(email_or_phone_or_username: $email_or_phone_or_username, password: $password, captcha: $captcha) {
    token
  }
}`,
    { email_or_phone_or_username: identifier, password: code, captcha: captcha ?? null }
  );
  const token = (data?.login as any)?.token;
  if (!token || typeof token !== "string") {
    throw new SleeperAuthError("Sleeper did not return a token — check the code and try again.");
  }
  return token;
}
