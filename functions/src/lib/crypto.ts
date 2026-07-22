// ═══════════════════════════════════════════════════════════════
// AES-256-GCM encryption for Sleeper tokens at rest.
// ═══════════════════════════════════════════════════════════════
// A Sleeper token is effectively full account access, so we never
// store it in plaintext. It is encrypted with a key held in Firebase
// Secret Manager (SLEEPER_ENC_KEY) and only decrypted in-memory inside
// a Cloud Function at the moment a Sleeper call is made.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export interface Encrypted {
  ct: string; // ciphertext (base64)
  iv: string; // init vector (base64)
  tag: string; // auth tag (base64)
}

function keyBuffer(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error(
      `SLEEPER_ENC_KEY must be 64 hex chars (32 bytes); got ${key.length} bytes`
    );
  }
  return key;
}

export function encryptToken(plaintext: string, hexKey: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(hexKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64") };
}

export function decryptToken(enc: Encrypted, hexKey: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBuffer(hexKey),
    Buffer.from(enc.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(enc.ct, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
