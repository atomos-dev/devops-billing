/**
 * Unit tests for src/discoverers/aws/rds.ts — RdsDiscoverer.
 *
 * Covers: metadata, multi-region discovery with tags, status mapping,
 * non-AWS credential guard, and per-region error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderCredentials } from "../../types";

// ---------------------------------------------------------------------------
// AWS SDK mock — must be declared before the import of RdsDiscoverer
// ---------------------------------------------------------------------------
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-rds", () => {
  const RDSClient = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockSend;
  });
  const DescribeDBInstancesCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  const ListTagsForResourceCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  return { RDSClient, DescribeDBInstancesCommand, ListTagsForResourceCommand };
});

import { RdsDiscoverer } from "../../aws/rds";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const awsCreds: ProviderCredentials = {
  provider: "aws",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "us-east-1",
  resourceRegions: ["us-east-1", "ap-southeast-1"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("RdsDiscoverer", () => {
  let discoverer: RdsDiscoverer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    discoverer = new RdsDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("rds");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toEqual([
      "Amazon Relational Database Service",
    ]);
  });

  // ── Multi-region discovery with tags ────────────────────────────────────
  it("discovers RDS instances across regions with tags", async () => {
    // Region 1: one instance with tags
    mockSend
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "db-prod",
            DBInstanceArn: "arn:aws:rds:us-east-1:123456:db:db-prod",
            DBInstanceClass: "db.r5.large",
            Engine: "postgres",
            DBInstanceStatus: "available",
          },
        ],
      })
      .mockResolvedValueOnce({
        TagList: [
          { Key: "Name", Value: "Production DB" },
          { Key: "env", Value: "prod" },
        ],
      })
      // Region 2: one instance, no tags call needed (no ARN)
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "db-staging",
            DBInstanceClass: "db.t3.micro",
            Engine: "mysql",
            DBInstanceStatus: "stopped",
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(2);

    // First instance — us-east-1, tags resolved
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "db-prod",
      resourceName: "Production DB",
      resourceType: "rds",
      region: "us-east-1",
      spec: "postgres db.r5.large",
      status: "running",
      tags: { Name: "Production DB", env: "prod" },
      monthlyBaseCost: null,
    });

    // Second instance — ap-southeast-1, no ARN so no tag fetch
    expect(resources[1]).toMatchObject({
      provider: "aws",
      resourceId: "db-staging",
      resourceName: "db-staging",
      resourceType: "rds",
      region: "ap-southeast-1",
      spec: "mysql db.t3.micro",
      status: "stopped",
    });
  });

  // ── Status mapping ──────────────────────────────────────────────────────
  it.each([
    ["available", "running"],
    ["stopped", "stopped"],
    ["deleting", "terminated"],
    ["deleted", "terminated"],
    ["creating", "pending"],
    ["starting", "pending"],
    ["rebooting", "pending"],
    ["modifying", "pending"],
    ["some-other", "some-other"],
    [undefined, "unknown"],
  ])("maps DBInstanceStatus '%s' → '%s'", async (input, expected) => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: "db-test",
          DBInstanceClass: "db.t3.micro",
          Engine: "mysql",
          DBInstanceStatus: input,
        },
      ],
    });

    const creds: ProviderCredentials = {
      provider: "aws",
      accessKeyId: "k",
      secretAccessKey: "s",
      region: "us-east-1",
      resourceRegions: ["us-east-1"],
    };
    const resources = await discoverer.discover(creds);

    expect(resources[0].status).toBe(expected);
  });

  // ── Non-AWS credentials ─────────────────────────────────────────────────
  it("returns empty array for non-aws credentials", async () => {
    const doCreds: ProviderCredentials = {
      provider: "digitalocean",
      apiToken: "tok",
    };
    const resources = await discoverer.discover(doCreds);

    expect(resources).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── Per-region error handling ───────────────────────────────────────────
  it("handles API errors gracefully per region", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Region 1 fails
    mockSend
      .mockRejectedValueOnce(new Error("AccessDenied"))
      // Region 2 succeeds
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "db-ok",
            DBInstanceClass: "db.t3.micro",
            Engine: "mysql",
            DBInstanceStatus: "available",
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceId).toBe("db-ok");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ── Tag fetch failure is non-fatal ──────────────────────────────────────
  it("continues when ListTagsForResource fails", async () => {
    mockSend
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "db-tags-fail",
            DBInstanceArn: "arn:aws:rds:us-east-1:123:db:db-tags-fail",
            DBInstanceClass: "db.t3.micro",
            Engine: "mysql",
            DBInstanceStatus: "available",
          },
        ],
      })
      // Tag call fails
      .mockRejectedValueOnce(new Error("TagAccessDenied"))
      // Region 2 — no instances
      .mockResolvedValueOnce({ DBInstances: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceName).toBe("db-tags-fail");
    expect(resources[0].tags).toEqual({});
  });
});
