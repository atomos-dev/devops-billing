/**
 * Unit tests for src/discoverers/aws/nat-gateway.ts — NatGatewayDiscoverer.
 *
 * Covers: metadata, multi-region discovery with tags, deleted gateway filtering,
 * status mapping, and per-region error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderCredentials } from "../../types";

// ---------------------------------------------------------------------------
// AWS SDK mock — only the commands needed by nat-gateway discoverer
// ---------------------------------------------------------------------------
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => {
  const EC2Client = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockSend;
  });
  const DescribeNatGatewaysCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  return { EC2Client, DescribeNatGatewaysCommand };
});

import { NatGatewayDiscoverer } from "../../aws/nat-gateway";

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
describe("NatGatewayDiscoverer", () => {
  let discoverer: NatGatewayDiscoverer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    discoverer = new NatGatewayDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("nat_gateway");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toEqual([
      "Amazon Virtual Private Cloud",
    ]);
  });

  // ── Discovery with tags ─────────────────────────────────────────────────
  it("discovers NAT gateways across regions with tags", async () => {
    // Region 1
    mockSend
      .mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-abc123",
            State: "available",
            ConnectivityType: "public",
            Tags: [
              { Key: "Name", Value: "Main NAT" },
              { Key: "env", Value: "prod" },
            ],
          },
        ],
      })
      // Region 2
      .mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-def456",
            State: "available",
            ConnectivityType: "private",
            Tags: [],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "nat-abc123",
      resourceName: "Main NAT",
      resourceType: "nat_gateway",
      region: "us-east-1",
      spec: "public",
      status: "running",
      tags: { Name: "Main NAT", env: "prod" },
      monthlyBaseCost: null,
    });
    expect(resources[1]).toMatchObject({
      resourceId: "nat-def456",
      resourceName: "",
      region: "ap-southeast-1",
      spec: "private",
      status: "running",
    });
  });

  // ── Filters out deleted gateways ────────────────────────────────────────
  it("filters out deleted NAT gateways", async () => {
    mockSend
      .mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-alive",
            State: "available",
            ConnectivityType: "public",
            Tags: [],
          },
          {
            NatGatewayId: "nat-gone",
            State: "deleted",
            ConnectivityType: "public",
            Tags: [],
          },
        ],
      })
      .mockResolvedValueOnce({ NatGateways: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceId).toBe("nat-alive");
  });

  // ── Status mapping ──────────────────────────────────────────────────────
  it("maps 'available' → 'running' and passes other states through", async () => {
    mockSend
      .mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-pending",
            State: "pending",
            ConnectivityType: "public",
            Tags: [],
          },
        ],
      })
      .mockResolvedValueOnce({ NatGateways: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].status).toBe("pending");
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
        NatGateways: [
          {
            NatGatewayId: "nat-ok",
            State: "available",
            ConnectivityType: "public",
            Tags: [],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceId).toBe("nat-ok");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
