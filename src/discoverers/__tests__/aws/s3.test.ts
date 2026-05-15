/**
 * Unit tests for src/discoverers/aws/s3.ts — S3Discoverer.
 *
 * Covers: metadata, bucket discovery with location resolution,
 * us-east-1 default for null/empty location, GetBucketLocation error
 * handling, and non-AWS credential guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderCredentials } from "../../types";

// ---------------------------------------------------------------------------
// AWS SDK mock
// ---------------------------------------------------------------------------
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockSend;
  });
  const ListBucketsCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  const GetBucketLocationCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown,
  ) {
    this.input = input;
  });
  return { S3Client, ListBucketsCommand, GetBucketLocationCommand };
});

import { S3Discoverer } from "../../aws/s3";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("S3Discoverer", () => {
  let discoverer: S3Discoverer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    discoverer = new S3Discoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("s3");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toEqual([
      "Amazon Simple Storage Service",
    ]);
  });

  // ── Discovery with location ─────────────────────────────────────────────
  it("discovers buckets with their locations", async () => {
    mockSend
      .mockResolvedValueOnce({
        Buckets: [
          { Name: "my-data-bucket" },
          { Name: "logs-bucket" },
        ],
      })
      .mockResolvedValueOnce({ LocationConstraint: "eu-west-1" })
      .mockResolvedValueOnce({ LocationConstraint: "ap-southeast-1" });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "my-data-bucket",
      resourceName: "my-data-bucket",
      resourceType: "s3",
      region: "eu-west-1",
      spec: null,
      tags: {},
      status: "active",
      monthlyBaseCost: null,
    });
    expect(resources[1].region).toBe("ap-southeast-1");
  });

  // ── us-east-1 default for null/empty location ──────────────────────────
  it("defaults to us-east-1 when LocationConstraint is null", async () => {
    mockSend
      .mockResolvedValueOnce({ Buckets: [{ Name: "us-bucket" }] })
      .mockResolvedValueOnce({ LocationConstraint: null });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].region).toBe("us-east-1");
  });

  it("defaults to us-east-1 when LocationConstraint is empty string", async () => {
    mockSend
      .mockResolvedValueOnce({ Buckets: [{ Name: "us-bucket-2" }] })
      .mockResolvedValueOnce({ LocationConstraint: "" });

    const resources = await discoverer.discover(awsCreds);

    expect(resources[0].region).toBe("us-east-1");
  });

  // ── GetBucketLocation error handling ────────────────────────────────────
  it("sets region to 'unknown' when GetBucketLocation fails", async () => {
    mockSend
      .mockResolvedValueOnce({
        Buckets: [{ Name: "restricted-bucket" }],
      })
      .mockRejectedValueOnce(new Error("AccessDenied"));

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0].region).toBe("unknown");
    expect(resources[0].resourceId).toBe("restricted-bucket");
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

  // ── Empty bucket list ───────────────────────────────────────────────────
  it("returns empty array when no buckets exist", async () => {
    mockSend.mockResolvedValueOnce({ Buckets: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(0);
  });
});
