/**
 * Unit tests for src/discoverers/digitalocean/volume.ts — VolumeDiscoverer.
 *
 * Covers: metadata, volume discovery with size/filesystem spec,
 * attachment status mapping, tag parsing, non-DO credential guard,
 * and API error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProviderCredentials } from "../../types";
import { VolumeDiscoverer } from "../../digitalocean/volume";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const doCreds: ProviderCredentials = { provider: "digitalocean", apiToken: "test-token" };

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("VolumeDiscoverer", () => {
  let discoverer: VolumeDiscoverer;

  beforeEach(() => {
    discoverer = new VolumeDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("volume");
    expect(discoverer.provider).toBe("digitalocean");
    expect(discoverer.billingServiceNames).toEqual(["Volumes"]);
  });

  // ── Volume discovery with size and filesystem type ──────────────────────
  it("discovers volumes with size and filesystem type in spec", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        volumes: [
          {
            id: "vol-uuid-1",
            name: "data-vol",
            region: { slug: "nyc1" },
            size_gigabytes: 100,
            filesystem_type: "ext4",
            droplet_ids: [12345],
            tags: ["env:prod"],
          },
          {
            id: "vol-uuid-2",
            name: "backup-vol",
            region: { slug: "sfo2" },
            size_gigabytes: 500,
            filesystem_type: "xfs",
            droplet_ids: [],
            tags: [],
          },
        ],
        meta: { total: 2 },
      }),
    });

    const resources = await discoverer.discover(doCreds);

    expect(resources).toHaveLength(2);

    expect(resources[0]).toMatchObject({
      provider: "digitalocean",
      resourceId: "vol-uuid-1",
      resourceName: "data-vol",
      resourceType: "volume",
      region: "nyc1",
      spec: "100GiB ext4",
      status: "attached",
      tags: { env: "prod" },
      monthlyBaseCost: null,
    });

    expect(resources[1]).toMatchObject({
      provider: "digitalocean",
      resourceId: "vol-uuid-2",
      resourceName: "backup-vol",
      resourceType: "volume",
      region: "sfo2",
      spec: "500GiB xfs",
      status: "unattached",
      tags: {},
      monthlyBaseCost: null,
    });
  });

  // ── Attachment status mapping ───────────────────────────────────────────
  it("maps attachment status based on droplet_ids presence", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        volumes: [
          { id: "v1", name: "attached-vol", region: { slug: "r" }, size_gigabytes: 10, filesystem_type: "ext4", droplet_ids: [1, 2], tags: [] },
          { id: "v2", name: "detached-vol", region: { slug: "r" }, size_gigabytes: 20, filesystem_type: "ext4", droplet_ids: [], tags: [] },
          { id: "v3", name: "no-ids-vol", region: { slug: "r" }, size_gigabytes: 30, filesystem_type: "ext4", tags: [] },
        ],
        meta: { total: 3 },
      }),
    });

    const resources = await discoverer.discover(doCreds);

    expect(resources[0].status).toBe("attached");
    expect(resources[1].status).toBe("unattached");
    // droplet_ids missing (undefined) → fallback to empty array → unattached
    expect(resources[2].status).toBe("unattached");
  });

  // ── Tag parsing ─────────────────────────────────────────────────────────
  it("parses DO key:value tags and flat tags correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        volumes: [
          {
            id: "v-tagged",
            name: "tagged-vol",
            region: { slug: "ams3" },
            size_gigabytes: 50,
            filesystem_type: "ext4",
            droplet_ids: [],
            tags: ["project:billing", "temporary", "tier:premium"],
          },
        ],
        meta: { total: 1 },
      }),
    });

    const resources = await discoverer.discover(doCreds);
    expect(resources[0].tags).toEqual({
      project: "billing",
      temporary: "true",
      tier: "premium",
    });
  });

  // ── Non-DO credentials ─────────────────────────────────────────────────
  it("returns empty array for non-digitalocean credentials", async () => {
    const awsCreds: ProviderCredentials = {
      provider: "aws",
      accessKeyId: "k",
      secretAccessKey: "s",
      region: "us-east-1",
      resourceRegions: ["us-east-1"],
    };
    const resources = await discoverer.discover(awsCreds);

    expect(resources).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── API error handling ─────────────────────────────────────────────────
  it("handles API errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const resources = await discoverer.discover(doCreds);

    expect(resources).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ── Non-OK response ────────────────────────────────────────────────────
  it("stops pagination on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const resources = await discoverer.discover(doCreds);
    expect(resources).toEqual([]);
  });
});
