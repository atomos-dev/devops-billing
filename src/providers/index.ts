/**
 * Provider loader — creates BillingProvider instances from DB settings
 * with .env fallback. Uses PROVIDER_REGISTRY for metadata and
 * PROVIDER_FACTORIES for instantiation.
 *
 * Priority: DB credentials > .env credentials; DB enabled state > .env enabled.
 */
import type { BillingProvider } from "./types";
import { AwsProvider } from "./aws";
import { DigitalOceanProvider } from "./digitalocean";
import { AlibabaProvider } from "./alibaba";
import { PROVIDER_REGISTRY } from "./registry";
import { getEffectiveCredentials, isProviderEnabled } from "@/services/settings";

// ── Provider factory registry ───────────────────────────────────────────────

/** Typed config interfaces for each provider constructor */
interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  resourceRegions: string[];
}

interface DoConfig {
  apiToken: string;
}

interface AlibabaConfig {
  accessKeyId: string;
  accessKeySecret: string;
  site: string;
  regionId: string;
}

/**
 * Factory functions that instantiate BillingProvider from a generic config.
 * Add new entries here when registering a new cloud provider.
 */
const PROVIDER_FACTORIES: Record<string, (config: Record<string, unknown>) => BillingProvider> = {
  aws: (config) => new AwsProvider(config as unknown as AwsConfig),
  digitalocean: (config) => new DigitalOceanProvider(config as unknown as DoConfig),
  "alibaba-cloud": (config) => new AlibabaProvider(config as unknown as AlibabaConfig),
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create provider instances for all enabled and configured providers.
 * Reads settings from DB first, then falls back to .env.
 * No parameters needed — config source is determined internally.
 */
export function createProviders(): Map<string, BillingProvider> {
  const providers = new Map<string, BillingProvider>();

  for (const [providerKey, meta] of Object.entries(PROVIDER_REGISTRY)) {
    if (!isProviderEnabled(providerKey)) continue;

    const creds = getEffectiveCredentials(providerKey);
    if (!creds) continue;

    const factory = PROVIDER_FACTORIES[providerKey];
    if (!factory) {
      console.warn(`[Providers] No factory registered for: ${providerKey}`);
      continue;
    }

    try {
      const config = meta.toProviderConfig(creds);
      providers.set(providerKey, factory(config));
    } catch (error) {
      console.error(`[Providers] Failed to create ${providerKey}:`, error);
    }
  }

  return providers;
}

// Re-export for convenience
export { PROVIDER_REGISTRY } from "./registry";
export type { BillingProvider } from "./types";
