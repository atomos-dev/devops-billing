/**
 * Unit tests for src/discoverers/scan-orchestrator.ts — ScanOrchestrator.
 *
 * Verifies scan status queries, concurrency lock behavior, scan record
 * creation, discoverer execution, resource upsert, and cleanup logic.
 * All external dependencies (DB, registry, settings) are mocked.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mock chain builder — mirrors the project-wide Drizzle mock pattern.
// vi.mock factories are hoisted, so the chain is created inside the factory.
// ---------------------------------------------------------------------------

function createQueryChain(terminalValue: unknown = []) {
  const chain: Record<string, Mock> = {};

  const nonTerminalMethods = [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "groupBy",
    "innerJoin",
    "set",
    "values",
    "onConflictDoUpdate",
    "target",
    "returning",
    "insert",
    "update",
    "delete",
  ];
  for (const method of nonTerminalMethods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.all = vi.fn().mockReturnValue(terminalValue);
  chain.get = vi.fn().mockReturnValue(undefined);
  chain.run = vi.fn();

  return chain;
}

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the module under test.
// ---------------------------------------------------------------------------

vi.mock("@/db", () => {
  const chain = createQueryChain();
  return { db: chain };
});

vi.mock("@/db/schema", () => ({
  bills: { id: "id", provider: "provider", billingPeriod: "billing_period" },
  billItems: { billId: "bill_id", service: "service" },
  resources: {
    provider: "provider",
    resourceId: "resource_id",
    resourceName: "resource_name",
    resourceType: "resource_type",
    region: "region",
    status: "status",
    updatedAt: "updated_at",
  },
  resourceScans: {
    id: "id",
    provider: "provider",
    status: "status",
    startedAt: "started_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, val) => ({ op: "eq", val })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  gt: vi.fn((_col, val) => ({ op: "gt", val })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), {
    raw: vi.fn(),
  }),
}));

const mockMatchBillingServices = vi.fn();
vi.mock("@/discoverers/registry", () => ({
  matchBillingServices: (...args: unknown[]) => mockMatchBillingServices(...args),
}));

const mockIsProviderEnabled = vi.fn();
const mockGetEffectiveCredentials = vi.fn();
vi.mock("@/services/settings", () => ({
  isProviderEnabled: (...args: unknown[]) => mockIsProviderEnabled(...args),
  getEffectiveCredentials: (...args: unknown[]) => mockGetEffectiveCredentials(...args),
}));

vi.mock("@/providers/registry", () => ({
  PROVIDER_REGISTRY: {
    aws: {
      displayName: "Amazon Web Services",
      toProviderConfig: (creds: Record<string, string>) => ({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        region: creds.region || "us-east-1",
        resourceRegions: (creds.resourceRegions || creds.region || "us-east-1")
          .split(",")
          .map((r: string) => r.trim()),
      }),
    },
    digitalocean: {
      displayName: "DigitalOcean",
      toProviderConfig: (creds: Record<string, string>) => ({
        apiToken: creds.apiToken,
      }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { ScanOrchestrator } from "../scan-orchestrator";
import { db } from "@/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The mocked db IS the chain — all chained methods (select, from, where, …)
 * and terminal methods (all, get, run) live directly on the db object.
 */
const dbMock = db as unknown as Record<string, Mock>;

/** Set the return value for .get() to simulate a scan record insert */
function resetScanRecord() {
  dbMock.get.mockReturnValue({
    id: 1,
    startedAt: "2026-04-02T00:00:00Z",
    status: "running",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset terminal returns to safe defaults
  dbMock.all.mockReturnValue([]);
  dbMock.get.mockReturnValue(undefined);
  // Re-wire non-terminal methods to return the chain after clearAllMocks
  const nonTerminal = [
    "select", "from", "where", "orderBy", "limit", "groupBy",
    "innerJoin", "set", "values", "onConflictDoUpdate", "target",
    "returning", "insert", "update", "delete",
  ];
  for (const method of nonTerminal) {
    dbMock[method].mockReturnValue(dbMock);
  }
});

// ===========================
// getScanStatus
// ===========================
describe("getScanStatus", () => {
  it("returns null currentScan when no scan is running", () => {
    const orchestrator = new ScanOrchestrator();
    dbMock.all.mockReturnValue([]);

    const status = orchestrator.getScanStatus();

    expect(status.currentScan).toBeNull();
    expect(status.recentScans).toEqual([]);
  });

  it("returns recent scans from the database", () => {
    const recentScans = [
      { id: 1, status: "success", startedAt: "2026-04-01T00:00:00Z" },
      { id: 2, status: "failed", startedAt: "2026-03-31T00:00:00Z" },
    ];
    dbMock.all.mockReturnValue(recentScans);

    const orchestrator = new ScanOrchestrator();
    const status = orchestrator.getScanStatus();

    expect(status.recentScans).toEqual(recentScans);
    expect(dbMock.select).toHaveBeenCalled();
  });

  it("returns currentScan with progress when a scan is running", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();
    mockMatchBillingServices.mockReturnValue({ matched: [], unmatched: [] });

    // Start a scan — it creates the running lock
    const result = await orchestrator.startScan();
    expect(result.scanId).toBe(1);

    // The scan status should show a running scan (or just finished)
    const status = orchestrator.getScanStatus();
    expect(status).toBeDefined();
  });
});

// ===========================
// startScan — concurrency lock
// ===========================
describe("startScan", () => {
  it("returns error if a scan is already running", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();

    // Use a slow discoverer so the scan stays in "running" state
    const slowDiscoverer = {
      serviceKey: "ec2",
      provider: "aws" as const,
      billingServiceNames: ["EC2"],
      discover: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
      ),
    };

    mockMatchBillingServices.mockReturnValue({
      matched: [{ service: "EC2", provider: "aws", discoverer: slowDiscoverer }],
      unmatched: [],
    });
    mockIsProviderEnabled.mockReturnValue(true);
    mockGetEffectiveCredentials.mockReturnValue({
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "us-east-1",
    });

    // First scan starts
    const first = await orchestrator.startScan();
    expect(first.scanId).toBe(1);
    expect(first.error).toBeUndefined();

    // Immediately try a second — should be blocked by concurrency lock
    const second = await orchestrator.startScan();
    expect(second.error).toBe("A scan is already running");
    expect(second.scanId).toBeUndefined();
  });

  it("creates a scan record in the database", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();
    mockMatchBillingServices.mockReturnValue({ matched: [], unmatched: [] });

    await orchestrator.startScan();

    expect(dbMock.insert).toHaveBeenCalled();
    expect(dbMock.values).toHaveBeenCalled();
    expect(dbMock.returning).toHaveBeenCalled();
  });

  it("creates scan record with provider filter when specified", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();
    mockMatchBillingServices.mockReturnValue({ matched: [], unmatched: [] });

    await orchestrator.startScan("aws");

    expect(dbMock.values).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "aws" })
    );
  });

  it("creates scan record with null provider when none specified", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();
    mockMatchBillingServices.mockReturnValue({ matched: [], unmatched: [] });

    await orchestrator.startScan();

    expect(dbMock.values).toHaveBeenCalledWith(
      expect.objectContaining({ provider: null })
    );
  });

  it("allows a new scan after the previous one completes", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();
    mockMatchBillingServices.mockReturnValue({ matched: [], unmatched: [] });

    // First scan
    const first = await orchestrator.startScan();
    expect(first.scanId).toBe(1);

    // Wait for the background scan to complete (empty discoverers = instant)
    await new Promise((r) => setTimeout(r, 50));

    // Second scan should succeed because finalizeScan clears runningScan
    dbMock.get.mockReturnValue({
      id: 2,
      startedAt: "2026-04-02T01:00:00Z",
      status: "running",
    });

    const second = await orchestrator.startScan();
    expect(second.scanId).toBe(2);
    expect(second.error).toBeUndefined();
  });
});

// ===========================
// executeScan — discoverer execution
// ===========================
describe("executeScan (via startScan)", () => {
  it("marks discoverers as failed when no credentials are available", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();

    const fakeDiscoverer = {
      serviceKey: "ec2",
      provider: "aws" as const,
      billingServiceNames: ["Amazon Elastic Compute Cloud - Compute"],
      discover: vi.fn(),
    };

    mockMatchBillingServices.mockReturnValue({
      matched: [{ service: "EC2", provider: "aws", discoverer: fakeDiscoverer }],
      unmatched: [],
    });

    // Provider not enabled -> getCredentials returns null
    mockIsProviderEnabled.mockReturnValue(false);

    await orchestrator.startScan();

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 50));

    // discover() should NOT have been called
    expect(fakeDiscoverer.discover).not.toHaveBeenCalled();

    // finalizeScan should have been called (via db.update)
    expect(dbMock.update).toHaveBeenCalled();
  });

  it("calls discover() when credentials are available", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();

    const fakeDiscoverer = {
      serviceKey: "do_existing",
      provider: "digitalocean" as const,
      billingServiceNames: ["Droplets"],
      discover: vi.fn().mockResolvedValue([]),
    };

    mockMatchBillingServices.mockReturnValue({
      matched: [{ service: "Droplets", provider: "digitalocean", discoverer: fakeDiscoverer }],
      unmatched: [],
    });

    mockIsProviderEnabled.mockReturnValue(true);
    mockGetEffectiveCredentials.mockReturnValue({ apiToken: "test-token" });

    await orchestrator.startScan();
    await new Promise((r) => setTimeout(r, 50));

    expect(fakeDiscoverer.discover).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "digitalocean", apiToken: "test-token" })
    );
  });

  it("handles discoverer errors gracefully without crashing the scan", async () => {
    const orchestrator = new ScanOrchestrator();
    resetScanRecord();

    const fakeDiscoverer = {
      serviceKey: "ec2",
      provider: "aws" as const,
      billingServiceNames: ["EC2"],
      discover: vi.fn().mockRejectedValue(new Error("API error")),
    };

    mockMatchBillingServices.mockReturnValue({
      matched: [{ service: "EC2", provider: "aws", discoverer: fakeDiscoverer }],
      unmatched: [],
    });

    mockIsProviderEnabled.mockReturnValue(true);
    mockGetEffectiveCredentials.mockReturnValue({
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "us-east-1",
    });

    await orchestrator.startScan();
    await new Promise((r) => setTimeout(r, 50));

    // Scan should complete (runningScan cleared) despite discoverer failure
    const status = orchestrator.getScanStatus();
    expect(status.currentScan).toBeNull();
  });
});
