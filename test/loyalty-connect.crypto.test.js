import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOYALTY_CONNECT_URL, loyaltyConnectUrl } from "../app/loyalty-connect/config.server.js";
import { decrypt, encrypt, EncryptionKeyMissing, parseKey, tryDecrypt } from "../app/loyalty-connect/crypto.server.js";
import { retryAfterMs } from "../app/loyalty-connect/client.server.js";

describe("encryption at rest (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh IV every time", () => {
    const a = encrypt("cs_sec_TESTONLY", "label", key);
    const b = encrypt("cs_sec_TESTONLY", "label", key);
    expect(a).not.toBe(b);
    expect(a.startsWith("lc1:")).toBe(true);
    expect(a).not.toContain("cs_sec");
    expect(decrypt(a, "label", key)).toBe("cs_sec_TESTONLY");
  });

  it("refuses another key, another label, or a changed value", () => {
    const v = encrypt("secret", "tenant:1", key);
    expect(() => decrypt(v, "tenant:1", randomBytes(32))).toThrow();
    expect(() => decrypt(v, "tenant:2", key)).toThrow();
    const parts = v.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join(":"), "tenant:1", key)).toThrow();
    expect(tryDecrypt(parts.join(":"), "tenant:1", key)).toBeUndefined();
    expect(tryDecrypt(null, "tenant:1", key)).toBeUndefined();
  });

  it("needs a 32-byte key, as hex or base64", () => {
    expect(() => encrypt("x", "l", undefined)).toThrow(EncryptionKeyMissing);
    expect(parseKey(key.toString("hex"))).toEqual(key);
    expect(parseKey(key.toString("base64"))).toEqual(key);
    expect(parseKey("too-short")).toBeUndefined();
    expect(parseKey("")).toBeUndefined();
  });
});

describe("configuration", () => {
  it("LOYALTY_CONNECT_URL: an https origin, else the default", () => {
    expect(loyaltyConnectUrl({})).toBe(DEFAULT_LOYALTY_CONNECT_URL);
    expect(loyaltyConnectUrl({ LOYALTY_CONNECT_URL: "https://connect.example.com/" })).toBe("https://connect.example.com");
    expect(loyaltyConnectUrl({ LOYALTY_CONNECT_URL: "http://localhost:8080" })).toBe("http://localhost:8080");
    const quiet = console.error;
    console.error = () => undefined;
    try {
      expect(loyaltyConnectUrl({ LOYALTY_CONNECT_URL: "https://connect.example.com/api" })).toBe(DEFAULT_LOYALTY_CONNECT_URL);
      expect(loyaltyConnectUrl({ LOYALTY_CONNECT_URL: "http://connect.example.com" })).toBe(DEFAULT_LOYALTY_CONNECT_URL);
    } finally {
      console.error = quiet;
    }
  });

  it("Retry-After: seconds or a date, else 60 seconds", () => {
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs(null)).toBe(60_000);
    expect(retryAfterMs("garbage")).toBe(60_000);
    expect(retryAfterMs(new Date(Date.parse("2026-10-27T10:05:00Z")).toUTCString(), Date.parse("2026-10-27T10:00:00Z"))).toBe(300_000);
  });
});
