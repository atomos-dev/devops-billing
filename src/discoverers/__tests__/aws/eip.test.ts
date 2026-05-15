/**
 * Unit tests for src/discoverers/aws/eip.ts — EipDiscoverer.
 *
 * Covers: metadata, multi-region discovery with tags, association status,
 * Name tag fallback to PublicIp, non-AWS credential guard, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderCredentials } from "../../types";

// ---------------------------------------------------------------------------
// AWS SDK mock — only the commands needed by EIP discoverer
// ---------------------------------------------------------------------------
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => {
  const EC2Client = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockSend;
  });
  const DescribeAddressesCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  return { EC2Client, DescribeAddressesCommand };
});

import { EipDiscoverer } from "../../aws/eip";

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
describe("EipDiscoverer", () => {
  let discoverer: EipDiscoverer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    discoverer = new EipDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("eip");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toEqual(["EC2 - Other"]);
  });

  // ── Discovery with tags & association ───────────────────────────────────
  it("discovers EIPs across regions with tags and association status", async () => {
    // Region 1: one associated EIP
    mockSend
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-abc123",
            PublicIp: "54.1.2.3",
            Domain: "vpc",
            AssociationId: "eipassoc-xyz",
            Tags: [
              { Key: "Name", Value: "Web Server EIP" },
              { Key: "env", Value: "prod" },
            ],
          },
        ],
      })
      // Region 2: one unassociated EIP
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-def456",
            PublicIp: "13.4.5.6",
            Domain: "vpc",
            Tags: [],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "eipalloc-abc123",
      resourceName: "Web Server EIP",
      resourceType: "eip",
      region: "us-east-1",
      spec: "vpc",
      status: "associated",
      tags: { Name: "Web Server EIP", env: "prod" },
      monthlyBaseCost: null,
    });
    expect(resources[1]).toMatchObject({
      resourceId: "eipalloc-def456",
      resourceName: "13.4.5.6",
      region: "ap-southeast-1",
      status: "unassociated",
    });
  });

  // ── Name tag fallback to PublicIp ───────────────────────────────────────
  it("uses PublicIp as name when no Name tag exists", async () => {
    mockSend
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-no-name",
            PublicIp: "3.4.5.6",
            Domain: "vpc",
            Tags: [{ Key: "env", Value: "dev" }],
          },
        ],
      })
      .mockResolvedValueOnce({ Addresses: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].resourceName).toBe("3.4.5.6");
  });

  // ── Association status ──────────────────────────────────────────────────
  it("marks EIP with AssociationId as 'associated'", async () => {
    mockSend
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-assoc",
            PublicIp: "1.2.3.4",
            Domain: "vpc",
            AssociationId: "eipassoc-123",
            Tags: [],
          },
        ],
      })
      .mockResolvedValueOnce({ Addresses: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].status).toBe("associated");
  });

  it("marks EIP without AssociationId as 'unassociated'", async () => {
    mockSend
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-free",
            PublicIp: "5.6.7.8",
            Domain: "standard",
            Tags: [],
          },
        ],
      })
      .mockResolvedValueOnce({ Addresses: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].status).toBe("unassociated");
    expect(resources[0].spec).toBe("standard");
  });

  // ── Non-AWS credentials ─────────────────────────────────────────────────
  it("returns empty array for non-aws credentials", async () => {
    const resources = await discoverer.discover({
      provider: "digitalocean",
      apiToken: "tok",
    });
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
      .mockRejectedValueOnce(new Error("UnauthorizedOperation"))
      // Region 2 succeeds
      .mockResolvedValueOnce({
        Addresses: [
          {
            AllocationId: "eipalloc-ok",
            PublicIp: "9.8.7.6",
            Domain: "vpc",
            Tags: [],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceId).toBe("eipalloc-ok");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
