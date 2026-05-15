/**
 * Unit tests for the discoverer registry (src/discoverers/registry.ts).
 *
 * Validates provider lookups, billing-service-to-discoverer matching,
 * account-level service classification, and empty-input fallback behavior.
 */
import { describe, it, expect } from "vitest";
import {
  getDiscoverersForProvider,
  getAllDiscoverers,
  matchBillingServices,
  ACCOUNT_LEVEL_SERVICES,
} from "../registry";

// ---------------------------------------------------------------------------
// getDiscoverersForProvider
// ---------------------------------------------------------------------------

describe("getDiscoverersForProvider", () => {
  it("returns AWS discoverers with provider === 'aws'", () => {
    const discoverers = getDiscoverersForProvider("aws");
    expect(discoverers.length).toBeGreaterThan(0);
    for (const d of discoverers) {
      expect(d.provider).toBe("aws");
    }
  });

  it("returns DigitalOcean discoverers with provider === 'digitalocean'", () => {
    const discoverers = getDiscoverersForProvider("digitalocean");
    expect(discoverers.length).toBeGreaterThan(0);
    for (const d of discoverers) {
      expect(d.provider).toBe("digitalocean");
    }
  });

  it("returns an empty array for an unknown provider", () => {
    const discoverers = getDiscoverersForProvider("gcp");
    expect(discoverers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchBillingServices — known service matching
// ---------------------------------------------------------------------------

describe("matchBillingServices", () => {
  it("matches 'Amazon Relational Database Service' to the rds discoverer", () => {
    const result = matchBillingServices([
      { provider: "aws", service: "Amazon Relational Database Service" },
    ]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].discoverer.serviceKey).toBe("rds");
    expect(result.matched[0].provider).toBe("aws");
    expect(result.unmatched).toHaveLength(0);
  });

  it("matches 'Amazon Elastic Compute Cloud - Compute' to the ec2 discoverer", () => {
    const result = matchBillingServices([
      { provider: "aws", service: "Amazon Elastic Compute Cloud - Compute" },
    ]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].discoverer.serviceKey).toBe("ec2");
  });

  it("matches multiple services across providers", () => {
    const result = matchBillingServices([
      { provider: "aws", service: "Amazon Simple Storage Service" },
      { provider: "digitalocean", service: "Droplets" },
    ]);

    expect(result.matched).toHaveLength(2);
    expect(result.matched[0].discoverer.serviceKey).toBe("s3");
    expect(result.matched[1].discoverer.serviceKey).toBe("do_existing");
  });

  // ── Account-level services ──────────────────────────────────────────────
  it("classifies 'AmazonCloudWatch' as account_level", () => {
    const result = matchBillingServices([
      { provider: "aws", service: "AmazonCloudWatch" },
    ]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toEqual({
      service: "AmazonCloudWatch",
      provider: "aws",
      reason: "account_level",
    });
  });

  // ── Unknown services ────────────────────────────────────────────────────
  it("classifies unknown services as no_discoverer", () => {
    const result = matchBillingServices([
      { provider: "aws", service: "Some Unknown Service" },
    ]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toEqual({
      service: "Some Unknown Service",
      provider: "aws",
      reason: "no_discoverer",
    });
  });

  // ── Empty-input fallback ────────────────────────────────────────────────
  it("returns all discoverers when billingServices is empty", () => {
    const result = matchBillingServices([]);
    const allDiscoverers = getAllDiscoverers();

    expect(result.matched).toHaveLength(allDiscoverers.length);
    expect(result.unmatched).toHaveLength(0);

    // Every discoverer should appear in matched results
    const matchedKeys = result.matched.map((m) => m.discoverer.serviceKey);
    for (const d of allDiscoverers) {
      expect(matchedKeys).toContain(d.serviceKey);
    }
  });
});

// ---------------------------------------------------------------------------
// ACCOUNT_LEVEL_SERVICES
// ---------------------------------------------------------------------------

describe("ACCOUNT_LEVEL_SERVICES", () => {
  it.each([
    "AmazonCloudWatch",
    "AWS Key Management Service",
    "Amazon Simple Email Service",
    "Amazon Simple Notification Service",
    "Amazon API Gateway",
    "AWS Glue",
  ])("contains '%s'", (service) => {
    expect(ACCOUNT_LEVEL_SERVICES.has(service)).toBe(true);
  });

  it("does not contain arbitrary service names", () => {
    expect(ACCOUNT_LEVEL_SERVICES.has("Amazon EC2")).toBe(false);
  });
});
