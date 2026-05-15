/**
 * Unit tests for the AES-256-GCM encryption/decryption module.
 * Tests real encryption without mocking — validates correctness, format,
 * randomness, and error handling of encrypt/decrypt.
 *
 * @file src/lib/__tests__/crypto.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encrypt, decrypt } from "../crypto";

describe("crypto", () => {
  const TEST_SECRET = "test-auth-secret-for-unit-tests";
  let originalSecret: string | undefined;

  beforeEach(() => {
    // Preserve any existing AUTH_SECRET so tests are side-effect-free
    originalSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    // Restore to original value (or remove if it wasn't set)
    if (originalSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalSecret;
    }
  });

  // ── Roundtrip ────────────────────────────────────────────────────────────

  it("roundtrip: decrypting an encrypted value returns the original plaintext", () => {
    const plaintext = "super-secret-password-123";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  // ── Randomness ───────────────────────────────────────────────────────────

  it("encrypting the same plaintext twice produces different ciphertexts", () => {
    const plaintext = "same-value";
    const first = encrypt(plaintext);
    const second = encrypt(plaintext);
    // Random salt + IV mean two encryptions must differ
    expect(first).not.toBe(second);
  });

  // ── Storage format ───────────────────────────────────────────────────────

  it("encrypted output has exactly 4 colon-separated parts", () => {
    const ciphertext = encrypt("some plaintext");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(4);
  });

  it("all 4 parts are non-empty hex strings", () => {
    const ciphertext = encrypt("some plaintext");
    const [salt, iv, authTag, encrypted] = ciphertext.split(":");
    const hexPattern = /^[0-9a-f]+$/i;
    expect(salt).toMatch(hexPattern);
    expect(iv).toMatch(hexPattern);
    expect(authTag).toMatch(hexPattern);
    expect(encrypted).toMatch(hexPattern);
  });

  it("salt is 16 bytes (32 hex chars)", () => {
    const [saltHex] = encrypt("x").split(":");
    expect(saltHex).toHaveLength(32);
  });

  it("iv is 12 bytes (24 hex chars)", () => {
    const [, ivHex] = encrypt("x").split(":");
    expect(ivHex).toHaveLength(24);
  });

  it("authTag is 16 bytes (32 hex chars)", () => {
    const [, , authTagHex] = encrypt("x").split(":");
    expect(authTagHex).toHaveLength(32);
  });

  // ── Missing AUTH_SECRET ──────────────────────────────────────────────────

  it("encrypt throws when AUTH_SECRET is not set", () => {
    delete process.env.AUTH_SECRET;
    expect(() => encrypt("value")).toThrow(/AUTH_SECRET/);
  });

  it("decrypt throws when AUTH_SECRET is not set", () => {
    const ciphertext = encrypt("value");
    delete process.env.AUTH_SECRET;
    expect(() => decrypt(ciphertext)).toThrow(/AUTH_SECRET/);
  });

  // ── Wrong key ────────────────────────────────────────────────────────────

  it("decrypt throws when AUTH_SECRET is different from the one used to encrypt", () => {
    const ciphertext = encrypt("sensitive data");
    // Switch to a different secret before decrypting
    process.env.AUTH_SECRET = "a-completely-different-secret";
    // AES-GCM authentication tag verification will fail
    expect(() => decrypt(ciphertext)).toThrow();
  });

  // ── Malformed ciphertext ─────────────────────────────────────────────────

  it("decrypt throws on ciphertext with fewer than 4 parts", () => {
    expect(() => decrypt("onlytwoparts:here")).toThrow(/Invalid encrypted data format/);
  });

  it("decrypt throws on ciphertext with more than 4 parts", () => {
    expect(() => decrypt("a:b:c:d:e")).toThrow(/Invalid encrypted data format/);
  });

  it("decrypt throws on completely random garbage input", () => {
    expect(() => decrypt("notvalidatall")).toThrow();
  });

  it("decrypt throws when the authTag portion is corrupted", () => {
    const ciphertext = encrypt("tamper me");
    const parts = ciphertext.split(":");
    // Replace authTag (index 2) with zeroed bytes of the same length
    parts[2] = "0".repeat(parts[2].length);
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("decrypt throws when the encrypted payload is corrupted", () => {
    const ciphertext = encrypt("tamper me");
    const parts = ciphertext.split(":");
    // Flip the first byte of the encrypted payload
    const flipped = ((parseInt(parts[3].slice(0, 2), 16) ^ 0xff) >>> 0)
      .toString(16)
      .padStart(2, "0");
    parts[3] = flipped + parts[3].slice(2);
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("roundtrip works with an empty string", () => {
    const ciphertext = encrypt("");
    expect(decrypt(ciphertext)).toBe("");
  });

  it("roundtrip works with a large string (100 KB)", () => {
    const large = "A".repeat(100 * 1024);
    expect(decrypt(encrypt(large))).toBe(large);
  });

  it("roundtrip works with unicode and special characters", () => {
    const unicode = "Hello 世界 🌍 \u0000 \n\t <>\"'&%$#@!";
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  it("roundtrip works with a string containing colons (the separator character)", () => {
    // Colons inside the plaintext must not confuse the split-by-colon parser
    const withColons = "salt:iv:authTag:ciphertext";
    expect(decrypt(encrypt(withColons))).toBe(withColons);
  });
});
