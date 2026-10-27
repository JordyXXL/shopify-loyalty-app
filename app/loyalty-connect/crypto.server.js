/**
 * Encryption at rest for Loyalty Connect: the source keys of a tenant and the queued messages (an order message holds the customer's
 * e-mail address until it is delivered). AES-256-GCM with a random 96-bit IV per value and an "associated data" label, so a value
 * encrypted for one purpose (or one tenant) does not decrypt as another.
 *
 *   LOYALTY_CONNECT_ENCRYPTION_KEY   32 random bytes, as 64 hex characters or base64 (44 characters with padding).
 *                                    Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Stored form: "lc1:<iv>:<tag>:<ciphertext>" (base64url). Changing the key makes the stored values unreadable: the tenant then has
 * to enter its keys again, and queued messages are dropped as undeliverable.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "lc1";

export class EncryptionKeyMissing extends Error {
  constructor() {
    super("LOYALTY_CONNECT_ENCRYPTION_KEY is not set (32 bytes as 64 hex characters or base64)");
    this.name = "EncryptionKeyMissing";
  }
}

/** The 32-byte key from a hex or base64 string, or undefined when it is not exactly 32 bytes. */
export function parseKey(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return undefined;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : undefined;
}

/** The key from the environment (read on every call, so tests and a restart pick up a change). */
export function encryptionKey(env = process.env) {
  return parseKey(env.LOYALTY_CONNECT_ENCRYPTION_KEY);
}

export const encryptionReady = (env = process.env) => Boolean(encryptionKey(env));

export function encrypt(plain, label, key = encryptionKey()) {
  if (!key) throw new EncryptionKeyMissing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(label), "utf8"));
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

/** The plain text, or throws (missing key, another key, another label, or a changed value). */
export function decrypt(stored, label, key = encryptionKey()) {
  if (!key) throw new EncryptionKeyMissing();
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("not a Loyalty Connect encrypted value");
  const [, iv, tag, ct] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(String(label), "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** decrypt(), or undefined when that is not possible. */
export function tryDecrypt(stored, label, key = encryptionKey()) {
  if (!stored) return undefined;
  try {
    return decrypt(stored, label, key);
  } catch {
    return undefined;
  }
}
