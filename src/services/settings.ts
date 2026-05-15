/**
 * Settings service — CRUD operations for provider configuration.
 * Handles encrypted credential storage, .env fallback detection,
 * and configSource determination.
 */
import { db } from "@/db";
import { providerSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "@/lib/crypto";
import { PROVIDER_REGISTRY, type CredentialField } from "@/providers/registry";

/** View model returned by the GET API (credentials redacted) */
export interface ProviderSettingView {
  provider: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  configSource: "database" | "env" | "none";
  lastTestedAt: string | null;
  lastTestResult: boolean | null;
  credentialFields: (CredentialField & { hasValue: boolean; value?: string })[];
}

/** Raw DB row type */
type ProviderSettingRow = typeof providerSettings.$inferSelect;

// ── Env config helpers ──────────────────────────────────────────────────────

/** Map from provider key to the env-var names that hold its credentials */
const ENV_KEYS: Record<string, { enabled: string; keys: string[] }> = {
  aws: {
    enabled: "AWS_ENABLED",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_RESOURCE_REGIONS"],
  },
  digitalocean: {
    enabled: "DO_ENABLED",
    keys: ["DO_API_TOKEN"],
  },
  "alibaba-cloud": {
    enabled: "ALICLOUD_ENABLED",
    keys: ["ALICLOUD_ACCESS_KEY", "ALICLOUD_SECRET_KEY", "ALICLOUD_REGION"],
  },
};

/** Check if env vars provide credentials for a given provider */
function hasEnvCredentials(provider: string): boolean {
  const cfg = ENV_KEYS[provider];
  if (!cfg) return false;
  // At least one credential env var is set
  return cfg.keys.some((k) => !!process.env[k]);
}

/** Check whether the provider is enabled via env (default: enabled if not explicitly "false") */
function isEnvEnabled(provider: string): boolean {
  const cfg = ENV_KEYS[provider];
  if (!cfg) return false;
  const val = process.env[cfg.enabled];
  // undefined (not set) → default enabled; "false" → disabled
  return val !== "false";
}

/**
 * Build a credential map from env vars for a specific provider.
 * Returns null if no env credentials are found.
 */
function getEnvCredentials(provider: string): Record<string, string> | null {
  if (provider === "aws") {
    const id = process.env.AWS_ACCESS_KEY_ID;
    const secret = process.env.AWS_SECRET_ACCESS_KEY;
    if (!id || !secret) return null;
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      region: process.env.AWS_REGION || "us-east-1",
      resourceRegions: process.env.AWS_RESOURCE_REGIONS || process.env.AWS_REGION || "us-east-1",
    };
  }
  if (provider === "digitalocean") {
    const token = process.env.DO_API_TOKEN;
    if (!token) return null;
    return { apiToken: token };
  }
  if (provider === "alibaba-cloud") {
    const id = process.env.ALICLOUD_ACCESS_KEY;
    const secret = process.env.ALICLOUD_SECRET_KEY;
    if (!id || !secret) return null;
    const site = process.env.ALICLOUD_SITE || "international";
    return {
      accessKeyId: id,
      accessKeySecret: secret,
      site,
      regionId: process.env.ALICLOUD_REGION || (site === "china" ? "cn-hangzhou" : "ap-southeast-1"),
    };
  }
  return null;
}

// ── DB operations ───────────────────────────────────────────────────────────

/** Get a single provider's DB record */
export function getProviderSetting(provider: string): ProviderSettingRow | undefined {
  return db.select().from(providerSettings).where(eq(providerSettings.provider, provider)).get();
}

/** Get decrypted credentials from DB. Returns null if no DB credentials stored. */
export function getDecryptedCredentials(provider: string): Record<string, string> | null {
  const row = getProviderSetting(provider);
  if (!row?.credentials) return null;
  try {
    return JSON.parse(decrypt(row.credentials));
  } catch (error) {
    console.error(`[Settings] Failed to decrypt credentials for ${provider}:`, error);
    return null;
  }
}

/**
 * Determine the effective credential source for a provider.
 * Priority: DB credentials > env credentials > none
 */
export function getConfigSource(provider: string): "database" | "env" | "none" {
  const row = getProviderSetting(provider);
  if (row?.credentials) return "database";
  if (hasEnvCredentials(provider)) return "env";
  return "none";
}

/**
 * Get the effective credentials for a provider (DB first, then env fallback).
 * Returns null if no credentials available from either source.
 */
export function getEffectiveCredentials(provider: string): Record<string, string> | null {
  const dbCreds = getDecryptedCredentials(provider);
  if (dbCreds) return dbCreds;
  return getEnvCredentials(provider);
}

/**
 * Determine if a provider is effectively enabled.
 * DB record takes priority; otherwise fall back to env.
 */
export function isProviderEnabled(provider: string): boolean {
  const row = getProviderSetting(provider);
  if (row) return row.enabled;
  return isEnvEnabled(provider) && hasEnvCredentials(provider);
}

// ── CRUD operations ─────────────────────────────────────────────────────────

/** Get all provider settings for the Settings UI (credentials redacted) */
export function getAllProviderSettings(): ProviderSettingView[] {
  const views: ProviderSettingView[] = [];

  for (const [providerKey, meta] of Object.entries(PROVIDER_REGISTRY)) {
    // Single DB query per provider — reuse row for all downstream logic
    const row = getProviderSetting(providerKey);
    const configSource: "database" | "env" | "none" =
      row?.credentials ? "database" : hasEnvCredentials(providerKey) ? "env" : "none";
    const enabled = row ? row.enabled : (isEnvEnabled(providerKey) && hasEnvCredentials(providerKey));

    // Resolve credentials using row directly (avoid re-querying)
    let effectiveCreds: Record<string, string> | null = null;
    if (row?.credentials) {
      try {
        effectiveCreds = JSON.parse(decrypt(row.credentials));
      } catch {
        effectiveCreds = null;
      }
    } else if (configSource === "env") {
      effectiveCreds = getEnvCredentials(providerKey);
    }

    const credentialFields = meta.credentialFields.map((field) => {
      const val = effectiveCreds?.[field.key];
      const hasValue = !!val;
      // Only expose value for non-password fields
      const result: CredentialField & { hasValue: boolean; value?: string } = {
        ...field,
        hasValue,
      };
      if (field.type !== "password" && hasValue) {
        result.value = val;
      }
      return result;
    });

    views.push({
      provider: providerKey,
      displayName: meta.displayName,
      enabled,
      configured: configSource !== "none",
      configSource,
      lastTestedAt: row?.lastTestedAt ?? null,
      lastTestResult: row?.lastTestResult ?? null,
      credentialFields,
    });
  }

  return views;
}

/** Create or update provider settings. Supports partial credential updates. */
export function upsertProviderSetting(
  provider: string,
  data: { enabled?: boolean; credentials?: Record<string, string> | null }
): ProviderSettingRow {
  const meta = PROVIDER_REGISTRY[provider];
  if (!meta) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const existing = getProviderSetting(provider);

  // Handle credential merging
  let encryptedCredentials: string | null | undefined;
  if (data.credentials === null) {
    // Explicit null → clear DB credentials (fallback to .env)
    encryptedCredentials = null;
  } else if (data.credentials) {
    // Merge with existing: empty string or missing key = keep existing value
    const currentCreds = existing?.credentials
      ? JSON.parse(decrypt(existing.credentials)) as Record<string, string>
      : {};

    const merged: Record<string, string> = { ...currentCreds };
    for (const [key, value] of Object.entries(data.credentials)) {
      if (value !== "") {
        merged[key] = value;
      }
    }

    encryptedCredentials = encrypt(JSON.stringify(merged));
  }
  // undefined means don't change credentials

  if (existing) {
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (encryptedCredentials !== undefined) updates.credentials = encryptedCredentials;

    db.update(providerSettings)
      .set(updates)
      .where(eq(providerSettings.id, existing.id))
      .run();

    return db.select().from(providerSettings).where(eq(providerSettings.id, existing.id)).get()!;
  }

  // Insert new row
  return db
    .insert(providerSettings)
    .values({
      provider,
      displayName: meta.displayName,
      enabled: data.enabled ?? false,
      credentials: encryptedCredentials ?? null,
    })
    .returning()
    .get();
}

/** Update connection test result for a provider */
export function updateTestResult(provider: string, success: boolean): void {
  const existing = getProviderSetting(provider);
  const now = new Date().toISOString();

  if (existing) {
    db.update(providerSettings)
      .set({ lastTestedAt: now, lastTestResult: success, updatedAt: now })
      .where(eq(providerSettings.id, existing.id))
      .run();
  } else {
    // Auto-create row if provider is in registry
    const meta = PROVIDER_REGISTRY[provider];
    if (meta) {
      db.insert(providerSettings)
        .values({
          provider,
          displayName: meta.displayName,
          enabled: false,
          lastTestedAt: now,
          lastTestResult: success,
        })
        .run();
    }
  }
}
