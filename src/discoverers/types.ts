/**
 * Resource Discoverer type definitions.
 * Defines the adapter interface for cloud resource discovery and
 * the credential/result types used across all discoverers.
 */

/** Credentials discriminated by provider */
export type ProviderCredentials =
  | {
      provider: "aws";
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      resourceRegions: string[];
    }
  | {
      provider: "digitalocean";
      apiToken: string;
    }
  | {
      provider: "alibaba-cloud";
      accessKeyId: string;
      accessKeySecret: string;
      site: string;
      regionId: string;
    };

/** A single discovered cloud resource */
export interface DiscoveredResource {
  provider: "aws" | "digitalocean" | "alibaba-cloud";
  resourceId: string;
  resourceName: string;
  resourceType: string;
  region: string;
  spec: string | null;
  tags: Record<string, string>;
  status: string;
  monthlyBaseCost: number | null;
  /** Transfer pool per resource (TiB), from provider API */
  bandwidthAllowanceTib?: number;
  /** Public IPv4 address(es), comma-separated if multiple */
  publicIp?: string;
  /** Private IPv4 address(es), comma-separated if multiple */
  privateIp?: string;
}

/**
 * Adapter interface for cloud resource discovery.
 * Each implementation discovers resources for one service type
 * (e.g., EC2, RDS, S3) and maps to one or more billing service names.
 */
export interface ResourceDiscoverer {
  /** Unique key identifying this discoverer (e.g., 'ec2', 'rds', 's3') */
  readonly serviceKey: string;
  /** Provider this discoverer belongs to */
  readonly provider: "aws" | "digitalocean" | "alibaba-cloud";
  /** Billing service names this discoverer covers (matched against billItems.service) */
  readonly billingServiceNames: string[];
  /** Resource types this discoverer produces (defaults to [serviceKey] if not set) */
  readonly resourceTypes?: string[];
  /** Execute resource discovery; must complete within timeout or be aborted */
  discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]>;
}

/** Per-discoverer execution result stored in resource_scans.details JSON */
export interface DiscovererResult {
  serviceKey: string;
  status: "success" | "failed" | "timeout";
  resourcesFound: number;
  durationMs: number;
  error?: string;
}

/** Parsed shape of resource_scans.details JSON */
export interface ScanDetails {
  discoverers: DiscovererResult[];
  unmatchedServices: Array<{
    service: string;
    provider: string;
    reason: "no_discoverer" | "account_level";
  }>;
}
