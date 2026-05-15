/**
 * Unit tests for src/discoverers/aws/elb.ts — ElbDiscoverer.
 *
 * Covers: metadata, multi-region discovery with tags, ARN-to-resourceId
 * extraction, status mapping, and per-region error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderCredentials } from "../../types";

// ---------------------------------------------------------------------------
// AWS SDK mock
// ---------------------------------------------------------------------------
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-elastic-load-balancing-v2", () => {
  const ElasticLoadBalancingV2Client = vi.fn(function (
    this: Record<string, unknown>,
  ) {
    this.send = mockSend;
  });
  const DescribeLoadBalancersCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  const DescribeTagsCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  return {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTagsCommand,
  };
});

import { ElbDiscoverer } from "../../aws/elb";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const awsCreds: ProviderCredentials = {
  provider: "aws",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "us-east-1",
  resourceRegions: ["us-east-1"],
};

const sampleArn =
  "arn:aws:elasticloadbalancing:us-east-1:123456:loadbalancer/app/my-alb/abc123def";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ElbDiscoverer", () => {
  let discoverer: ElbDiscoverer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    discoverer = new ElbDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("elb");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toEqual([
      "Amazon Elastic Load Balancing",
    ]);
  });

  // ── Discovery with tags ─────────────────────────────────────────────────
  it("discovers load balancers with tags", async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn: sampleArn,
            LoadBalancerName: "my-alb",
            Type: "application",
            Scheme: "internet-facing",
            State: { Code: "active" },
          },
        ],
      })
      .mockResolvedValueOnce({
        TagDescriptions: [
          {
            ResourceArn: sampleArn,
            Tags: [
              { Key: "Name", Value: "Web ALB" },
              { Key: "env", Value: "prod" },
            ],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "app/my-alb/abc123def",
      resourceName: "Web ALB",
      resourceType: "elb",
      region: "us-east-1",
      spec: "application internet-facing",
      status: "running",
      tags: { Name: "Web ALB", env: "prod" },
      monthlyBaseCost: null,
    });
  });

  // ── ARN extraction ──────────────────────────────────────────────────────
  it("extracts resourceId from ARN correctly", async () => {
    const nlbArn =
      "arn:aws:elasticloadbalancing:eu-west-1:999:loadbalancer/net/my-nlb/xyz789";

    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn: nlbArn,
            LoadBalancerName: "my-nlb",
            Type: "network",
            Scheme: "internal",
            State: { Code: "active" },
          },
        ],
      })
      .mockResolvedValueOnce({ TagDescriptions: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].resourceId).toBe("net/my-nlb/xyz789");
  });

  // ── Status mapping ──────────────────────────────────────────────────────
  it("maps 'active' state to 'running' and passes others through", async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn: sampleArn,
            LoadBalancerName: "provisioning-lb",
            Type: "application",
            Scheme: "internal",
            State: { Code: "provisioning" },
          },
        ],
      })
      .mockResolvedValueOnce({ TagDescriptions: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].status).toBe("provisioning");
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

    const multiRegionCreds: ProviderCredentials = {
      ...awsCreds,
      provider: "aws",
      resourceRegions: ["us-east-1", "eu-west-1"],
    };

    // Region 1 fails
    mockSend
      .mockRejectedValueOnce(new Error("AccessDenied"))
      // Region 2 succeeds
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn:
              "arn:aws:elasticloadbalancing:eu-west-1:123:loadbalancer/app/ok-lb/111",
            LoadBalancerName: "ok-lb",
            Type: "application",
            Scheme: "internal",
            State: { Code: "active" },
          },
        ],
      })
      .mockResolvedValueOnce({ TagDescriptions: [] });

    const resources = await discoverer.discover(multiRegionCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceName).toBe("ok-lb");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ── Empty region ────────────────────────────────────────────────────────
  it("skips regions with no load balancers", async () => {
    mockSend.mockResolvedValueOnce({ LoadBalancers: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(0);
    // Only one send call (DescribeLoadBalancers), no tags call
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // ── Falls back to LB name when no Name tag ─────────────────────────────
  it("uses LoadBalancerName when no Name tag exists", async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn: sampleArn,
            LoadBalancerName: "fallback-name",
            Type: "network",
            Scheme: "internal",
            State: { Code: "active" },
          },
        ],
      })
      .mockResolvedValueOnce({ TagDescriptions: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].resourceName).toBe("fallback-name");
  });
});
