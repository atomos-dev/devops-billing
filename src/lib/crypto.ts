/**
 * AES-256-GCM encryption/decryption module for provider credentials.
 * Uses Node.js built-in crypto — no external dependencies.
 *
 * Storage format: salt:iv:authTag:ciphertext (hex-encoded, colon-separated)
 * Key derivation: scrypt(AUTH_SECRET, salt, keyLen=32)
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
/** scrypt cost parameters: N=16384, r=8, p=1 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

/**
 * Derive a 256-bit key from the secret using scrypt.
 * Each call with a different salt produces a different key.
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

/** Get the encryption secret from environment, throw if missing */
function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("[Crypto] AUTH_SECRET environment variable is required for credential encryption");
  }
  return secret;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a colon-separated hex string: salt:iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const secret = getSecret();
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    salt.toString("hex"),
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

/**
 * Decrypt a ciphertext string produced by encrypt().
 * Throws if AUTH_SECRET doesn't match or data is corrupted.
 */
export function decrypt(ciphertext: string): string {
  const secret = getSecret();
  const parts = ciphertext.split(":");

  if (parts.length !== 4) {
    throw new Error("[Crypto] Invalid encrypted data format (expected salt:iv:authTag:ciphertext)");
  }

  const [saltHex, ivHex, authTagHex, encryptedHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const key = deriveKey(secret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
