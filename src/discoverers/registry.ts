/**
 * Discoverer registry — maps billing service names to ResourceDiscoverer
 * implementations and classifies account-level services.
 */
import type { ResourceDiscoverer } from "./types";

// ── AWS Discoverers ─────────────────────────────────────────────────────────
import { Ec2Discoverer } from "./aws/ec2";
import { RdsDiscoverer } from "./aws/rds";
import { ElbDiscoverer } from "./aws/elb";
import { S3Discoverer } from "./aws/s3";
import { NatGatewayDiscoverer } from "./aws/nat-gateway";
import { EipDiscoverer } from "./aws/eip";

// ── DO Discoverers ──────────────────────────────────────────────────────────
import { ExistingResourcesDiscoverer } from "./digitalocean/existing-resources";
import { ManagedDbDiscoverer } from "./digitalocean/managed-db";
import { VolumeDiscoverer } from "./digitalocean/volume";

// ── Alibaba Cloud Discoverers ──────────────────────────────────────────────
import { AlibabaComputeDiscoverer } from "./alibaba-cloud/compute";

/** All registered discoverers, grouped by provider */
const DISCOVERER_REGISTRY: Record<string, ResourceDiscoverer[]> = {
  aws: [
    new Ec2Discoverer(),
    new RdsDiscoverer(),
    new ElbDiscoverer(),
    new S3Discoverer(),
    new NatGatewayDiscoverer(),
    new EipDiscoverer(),
  ],
  digitalocean: [
    new ExistingResourcesDiscoverer(),
    new ManagedDbDiscoverer(),
    new VolumeDiscoverer(),
  ],
  "alibaba-cloud": [
    new AlibabaComputeDiscoverer(),
  ],
};

/**
 * AWS services billed at the account level — no enumerable resources to discover.
 * Listed on the scan page as "account-level" rather than "unsupported".
 */
export const ACCOUNT_LEVEL_SERVICES = new Set([
  "AmazonCloudWatch",
  "AWS Key Management Service",
  "Amazon Simple Email Service",
  "Amazon Simple Notification Service",
  "Amazon API Gateway",
  "AWS Glue",
]);

/** Get all discoverers for a given provider key */
export function getDiscoverersForProvider(provider: string): ResourceDiscoverer[] {
  return DISCOVERER_REGISTRY[provider] ?? [];
}

/** Get all discoverers across all providers */
export function getAllDiscoverers(): ResourceDiscoverer[] {
  return Object.values(DISCOVERER_REGISTRY).flat();
}

interface BillingServiceEntry {
  provider: string;
  service: string;
}

interface MatchResult {
  matched: Array<{ service: string; provider: string; discoverer: ResourceDiscoverer }>;
  unmatched: Array<{ service: string; provider: string; reason: "no_discoverer" | "account_level" }>;
}

/**
 * Match billing service names to registered discoverers.
 * Falls back to returning ALL discoverers when billingServices is empty
 * (new install, no billing data yet).
 */
export function matchBillingServices(billingServices: BillingServiceEntry[]): MatchResult {
  if (billingServices.length === 0) {
    const allDiscoverers = getAllDiscoverers();
    return {
      matched: allDiscoverers.map((d) => ({
        service: d.billingServiceNames[0] ?? d.serviceKey,
        provider: d.provider,
        discoverer: d,
      })),
      unmatched: [],
    };
  }

  const matched: MatchResult["matched"] = [];
  const unmatched: MatchResult["unmatched"] = [];
  const alreadyMatched = new Set<string>();

  for (const { provider, service } of billingServices) {
    const providerDiscoverers = getDiscoverersForProvider(provider);
    const discoverer = providerDiscoverers.find(
      (d) => !alreadyMatched.has(d.serviceKey) && d.billingServiceNames.includes(service)
    );

    if (discoverer) {
      alreadyMatched.add(discoverer.serviceKey);
      matched.push({ service, provider, discoverer });
    } else if (ACCOUNT_LEVEL_SERVICES.has(service)) {
      unmatched.push({ service, provider, reason: "account_level" });
    } else {
      unmatched.push({ service, provider, reason: "no_discoverer" });
    }
  }

  return { matched, unmatched };
}
