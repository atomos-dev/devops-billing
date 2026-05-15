/**
 * Unit tests for src/discoverers/digitalocean/managed-db.ts — ManagedDbDiscoverer.
 *
 * Covers: metadata, database discovery with spec mapping, status mapping,
 * DO key:value tag parsing, non-DO credential guard, and API error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProviderCredentials } from "../../types";
import { ManagedDbDiscoverer } from "../../digitalocean/managed-db";

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
describe("ManagedDbDiscoverer", () => {
  let discoverer: ManagedDbDiscoverer;

  beforeEach(() => {
    discoverer = new ManagedDbDiscoverer();
  });

  // ── Metadata ────────────────────────────────────────────────────────────
  it("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("managed_db");
    expect(discoverer.provider).toBe("digitalocean");
    expect(discoverer.billingServiceNames).toEqual(["Managed Databases"]);
  });

  // ── Database discovery with correct mapping ─────────────────────────────
  it("discovers databases with correct engine/size/node spec mapping", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        databases: [
          {
            id: "db-uuid-1",
            name: "prod-pg",
            engine: "pg",
            size_slug: "db-s-2vcpu-4gb",
            num_nodes: 3,
            region: "nyc1",
            status: "online",
            tags: ["env:prod", "team:platform"],
          },
          {
            id: "db-uuid-2",
            name: "staging-mysql",
            engine: "mysql",
            size_slug: "db-s-1vcpu-1gb",
            num_nodes: 1,
            region: "sfo2",
            status: "creating",
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
      resourceId: "db-uuid-1",
      resourceName: "prod-pg",
      resourceType: "managed_db",
      region: "nyc1",
      spec: "pg db-s-2vcpu-4gb 3-node",
      status: "running",
      tags: { env: "prod", team: "platform" },
      monthlyBaseCost: null,
    });

    expect(resources[1]).toMatchObject({
      provider: "digitalocean",
      resourceId: "db-uuid-2",
      resourceName: "staging-mysql",
      resourceType: "managed_db",
      region: "sfo2",
      spec: "mysql db-s-1vcpu-1gb 1-node",
      status: "creating",
      tags: {},
      monthlyBaseCost: null,
    });
  });

  // ── Status mapping: "online" → "running" ───────────────────────────────
  it('maps status "online" to "running"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        databases: [
          { id: "db-1", name: "a", engine: "pg", size_slug: "s", num_nodes: 1, region: "r", status: "online", tags: [] },
        ],
        meta: { total: 1 },
      }),
    });

    const resources = await discoverer.discover(doCreds);
    expect(resources[0].status).toBe("running");
  });

  // ── Tag parsing: key:value and flat tags ────────────────────────────────
  it("parses DO key:value tags and flat tags correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        databases: [
          {
            id: "db-tags",
            name: "tagged-db",
            engine: "redis",
            size_slug: "db-s-1vcpu-1gb",
            num_nodes: 1,
            region: "ams3",
            status: "online",
            tags: ["env:staging", "managed", "tier:free"],
          },
        ],
        meta: { total: 1 },
      }),
    });

    const resources = await discoverer.discover(doCreds);
    expect(resources[0].tags).toEqual({
      env: "staging",
      managed: "true",
      tier: "free",
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
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const resources = await discoverer.discover(doCreds);
    expect(resources).toEqual([]);
  });

  // ── Pagination ─────────────────────────────────────────────────────────
  it("paginates through multiple pages", async () => {
    // meta.total must exceed per_page (100) to trigger a second page fetch
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          databases: [
            { id: "db-p1", name: "page1", engine: "pg", size_slug: "s", num_nodes: 1, region: "r", status: "online", tags: [] },
          ],
          meta: { total: 101 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          databases: [
            { id: "db-p2", name: "page2", engine: "mysql", size_slug: "s", num_nodes: 1, region: "r", status: "online", tags: [] },
          ],
          meta: { total: 101 },
        }),
      });

    const resources = await discoverer.discover(doCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0].resourceId).toBe("db-p1");
    expect(resources[1].resourceId).toBe("db-p2");
    // Verify both pages were fetched
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
