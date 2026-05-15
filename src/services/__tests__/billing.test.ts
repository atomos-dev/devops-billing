/**
 * Unit tests for the billing query service.
 *
 * Mocks the `@/db` module so that all Drizzle query-builder chains
 * (select/from/where/orderBy/groupBy/innerJoin/limit/all/get/run/returning/values/set)
 * are controllable via vi.fn(), and verifies each exported function's
 * return values, filtering logic, and edge-case handling.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mock @/db — must be declared before importing the service under test.
// ---------------------------------------------------------------------------

/** Reusable chain stub: every chained method returns the chain itself,
 *  except terminal methods (.all / .get / .run) which return mock data. */
function createQueryChain(terminalValue: unknown = []) {
  const chain: Record<string, Mock> = {};

  // Non-terminal methods — return the chain for further chaining
  for (const method of [
    "select",
    "from",
    "where",
    "orderBy",
    "groupBy",
    "innerJoin",
    "limit",
    "insert",
    "update",
    "delete",
    "set",
    "values",
    "returning",
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // Terminal methods
  chain.all = vi.fn().mockReturnValue(terminalValue);
  chain.get = vi.fn().mockReturnValue(terminalValue);
  chain.run = vi.fn().mockReturnValue(terminalValue);

  return chain;
}

vi.mock("@/db", () => {
  // Create initial chain; will be replaced per-test via resetMockChain()
  const chain = createQueryChain();
  return {
    db: chain,
  };
});

// Schema tables are referenced as Drizzle column tokens — plain stubs suffice.
vi.mock("@/db/schema", () => ({
  bills: { billingPeriod: "billing_period", provider: "provider", id: "id", totalAmount: "total_amount" },
  billItems: {
    billId: "bill_id",
    service: "service",
    region: "region",
    resourceId: "resource_id",
    resourceName: "resource_name",
    usageCategory: "usage_category",
    amount: "amount",
  },
  manualCosts: {
    billingPeriod: "billing_period",
    providerName: "provider_name",
    id: "id",
    amount: "amount",
  },
  resources: { provider: "provider", resourceId: "resource_id", resourceName: "resource_name", resourceType: "resource_type", region: "region", usageCategory: "usage_category" },
  syncLogs: { provider: "provider", startedAt: "started_at", status: "status" },
}));

// Also mock drizzle-orm operators so they don't try to access real SQL logic.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, val) => ({ op: "eq", val })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  gte: vi.fn((_col, val) => ({ op: "gte", val })),
  lte: vi.fn((_col, val) => ({ op: "lte", val })),
  desc: vi.fn((col) => ({ op: "desc", col })),
  like: vi.fn((_col, val) => ({ op: "like", val })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), {
    // Tagged template support: sql`...`
    raw: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import service under test AFTER mocks are registered
// ---------------------------------------------------------------------------
import {
  getMonthlySummary,
  getMonthlyTrend,
  getBillItems,
  getBills,
  getResources,
  getProviderSyncStatus,
  getTopResources,
  getCostBreakdown,
  getManualCosts,
  createManualCost,
  updateManualCost,
  deleteManualCost,
} from "../billing";

// Re-import the mocked db so we can swap `.all()` return values per test
import { db } from "@/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the terminal return values on the shared mock chain. */
function setAllReturn(...values: unknown[]) {
  // Each successive call to `.all()` returns the next value in the list.
  const allFn = (db as unknown as Record<string, Mock>).all;
  allFn.mockReset();
  for (const v of values) {
    allFn.mockReturnValueOnce(v);
  }
}

function setGetReturn(value: unknown) {
  (db as unknown as Record<string, Mock>).get.mockReturnValue(value);
}

function setRunReturn(value: unknown) {
  (db as unknown as Record<string, Mock>).run.mockReturnValue(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: .all() returns [] so tests that don't set data get empty arrays
  (db as unknown as Record<string, Mock>).all.mockReturnValue([]);
  (db as unknown as Record<string, Mock>).get.mockReturnValue(undefined);
});

// ===========================
// getMonthlySummary
// ===========================
describe("getMonthlySummary", () => {
  it("should return zero totals when there are no bills and no manual costs", () => {
    setAllReturn([], []);

    const result = getMonthlySummary("2026-03");

    expect(result.month).toBe("2026-03");
    expect(result.providers).toHaveLength(0);
    expect(result.totalAuto).toBe(0);
    expect(result.totalManual).toBe(0);
    expect(result.total).toBe(0);
  });

  it("should aggregate auto bills correctly", () => {
    const autoBills = [
      { provider: "aws", totalAmount: 120.5 },
      { provider: "digitalocean", totalAmount: 45.0 },
    ];
    setAllReturn(autoBills, []);

    const result = getMonthlySummary("2026-02");

    expect(result.month).toBe("2026-02");
    expect(result.totalAuto).toBeCloseTo(165.5);
    expect(result.totalManual).toBe(0);
    expect(result.total).toBeCloseTo(165.5);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toEqual({ provider: "aws", amount: 120.5, isManual: false });
    expect(result.providers[1]).toEqual({ provider: "digitalocean", amount: 45.0, isManual: false });
  });

  it("should aggregate manual costs correctly", () => {
    const manualEntries = [
      { providerName: "cloudflare", amount: 20 },
      { providerName: "mongodb", amount: 35 },
    ];
    setAllReturn([], manualEntries);

    const result = getMonthlySummary("2026-01");

    expect(result.totalAuto).toBe(0);
    expect(result.totalManual).toBe(55);
    expect(result.total).toBe(55);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toEqual({ provider: "cloudflare", amount: 20, isManual: true });
  });

  it("should combine auto and manual costs", () => {
    setAllReturn(
      [{ provider: "aws", totalAmount: 100 }],
      [{ providerName: "cloudflare", amount: 25 }]
    );

    const result = getMonthlySummary("2026-03");

    expect(result.totalAuto).toBe(100);
    expect(result.totalManual).toBe(25);
    expect(result.total).toBe(125);
    expect(result.providers).toHaveLength(2);
  });

  it("should default to the current month when no month argument is given", () => {
    setAllReturn([], []);

    const result = getMonthlySummary();
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    expect(result.month).toBe(expected);
  });
});

// ===========================
// getMonthlyTrend
// ===========================
describe("getMonthlyTrend", () => {
  it("should return the correct number of monthly summaries", () => {
    // Each call to getMonthlySummary triggers 2x .all() calls (autoBills + manual)
    const callCount = 6 * 2; // default months=6
    const returns = Array(callCount).fill([]);
    setAllReturn(...returns);

    const result = getMonthlyTrend();

    expect(result).toHaveLength(6);
  });

  it("should generate correct month strings in ascending order", () => {
    const months = 3;
    const callCount = months * 2;
    setAllReturn(...Array(callCount).fill([]));

    const result = getMonthlyTrend(months);

    expect(result).toHaveLength(3);

    // Verify ascending chronological order
    const monthStrings = result.map((s) => s.month);
    for (let i = 1; i < monthStrings.length; i++) {
      expect(monthStrings[i]! > monthStrings[i - 1]!).toBe(true);
    }

    // The last month should be the current month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(monthStrings[monthStrings.length - 1]).toBe(currentMonth);
  });

  it("should handle months=1 returning only the current month", () => {
    setAllReturn([], []);

    const result = getMonthlyTrend(1);

    expect(result).toHaveLength(1);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(result[0]!.month).toBe(expected);
  });
});

// ===========================
// getBillItems
// ===========================
describe("getBillItems", () => {
  it("should return all items for a bill when no filters are provided", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
      { billId: 1, service: "RDS", region: "us-west-2", usageCategory: "devops", amount: 30 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1);

    expect(result).toHaveLength(2);
    expect(result).toEqual(items);
  });

  it("should filter by service", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
      { billId: 1, service: "RDS", region: "us-west-2", usageCategory: "devops", amount: 30 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1, { service: "EC2" });

    expect(result).toHaveLength(1);
    expect(result[0]!.service).toBe("EC2");
  });

  it("should filter by region", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
      { billId: 1, service: "RDS", region: "us-west-2", usageCategory: "devops", amount: 30 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1, { region: "us-west-2" });

    expect(result).toHaveLength(1);
    expect(result[0]!.service).toBe("RDS");
  });

  it("should filter by category", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
      { billId: 1, service: "RDS", region: "us-west-2", usageCategory: "devops", amount: 30 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1, { category: "devops" });

    expect(result).toHaveLength(1);
    expect(result[0]!.usageCategory).toBe("devops");
  });

  it("should apply multiple filters simultaneously", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
      { billId: 1, service: "EC2", region: "us-west-2", usageCategory: "devops", amount: 30 },
      { billId: 1, service: "RDS", region: "us-east-1", usageCategory: "dpn", amount: 40 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1, { service: "EC2", region: "us-east-1" });

    expect(result).toHaveLength(1);
    expect(result[0]!.amount).toBe(50);
  });

  it("should return empty array when no items match filters", () => {
    const items = [
      { billId: 1, service: "EC2", region: "us-east-1", usageCategory: "dpn", amount: 50 },
    ];
    setGetReturn({ provider: "aws" });
    setAllReturn(items);

    const result = getBillItems(1, { service: "Lambda" });

    expect(result).toHaveLength(0);
  });

  it("should enrich bill items with resource data when a direct resourceId match exists", () => {
    const items = [
      {
        id: 1,
        billId: 1,
        service: "Amazon Elastic Compute Cloud - Compute",
        region: "us-east-1",
        resourceId: "i-abc123",
        resourceName: null,
        usageCategory: "other",
        amount: 80,
        usageQuantity: null,
        usageUnit: "USD",
      },
    ];
    const resourceRows = [
      {
        provider: "aws",
        resourceId: "i-abc123",
        resourceName: "web-server-01",
        usageCategory: "dpn",
      },
    ];

    setGetReturn({ provider: "aws" });
    setAllReturn(items, resourceRows);

    const result = getBillItems(1);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceId: "i-abc123",
      resourceName: "web-server-01",
      usageCategory: "dpn",
    });
  });

  it("should keep unresolved bill items unchanged when no direct resource match exists", () => {
    const items = [
      {
        id: 1,
        billId: 1,
        service: "Amazon Elastic Compute Cloud - Compute",
        region: "us-east-1",
        resourceId: "i-missing",
        resourceName: null,
        usageCategory: "other",
        amount: 80,
        usageQuantity: null,
        usageUnit: "USD",
      },
    ];

    setGetReturn({ provider: "aws" });
    setAllReturn(items, []);

    const result = getBillItems(1);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceId: "i-missing",
      resourceName: null,
      usageCategory: "other",
    });
  });
});

// ===========================
// getBills
// ===========================
describe("getBills", () => {
  it("should return all bills when no provider is specified", () => {
    const allBills = [
      { id: 1, provider: "aws", billingPeriod: "2026-03", totalAmount: 100 },
      { id: 2, provider: "digitalocean", billingPeriod: "2026-03", totalAmount: 50 },
    ];
    setAllReturn(allBills);

    const result = getBills();

    expect(result).toEqual(allBills);
  });

  it("should return filtered bills when provider is specified", () => {
    const awsBills = [{ id: 1, provider: "aws", billingPeriod: "2026-03", totalAmount: 100 }];
    setAllReturn(awsBills);

    const result = getBills("aws");

    expect(result).toEqual(awsBills);
  });

  it("should return empty array when no bills exist", () => {
    setAllReturn([]);

    const result = getBills();

    expect(result).toEqual([]);
  });
});

// ===========================
// getResources
// ===========================
describe("getResources", () => {
  const sampleResources = [
    { provider: "aws", resourceId: "i-abc123", resourceName: "web-server-01", resourceType: "ec2", region: "us-east-1", usageCategory: "dpn" },
    { provider: "aws", resourceId: "i-def456", resourceName: "db-primary", resourceType: "rds", region: "us-west-2", usageCategory: "devops" },
    { provider: "digitalocean", resourceId: "do-789", resourceName: "worker-node", resourceType: "droplet", region: "sgp1", usageCategory: "mainnet" },
  ];

  it("should return all resources when no filters are provided", () => {
    setAllReturn(sampleResources);

    const result = getResources();

    expect(result).toHaveLength(3);
  });

  it("should filter by provider", () => {
    setAllReturn(sampleResources);

    const result = getResources({ provider: "aws" });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.provider === "aws")).toBe(true);
  });

  it("should filter by category", () => {
    setAllReturn(sampleResources);

    const result = getResources({ category: "dpn" });

    expect(result).toHaveLength(1);
    expect(result[0]!.resourceName).toBe("web-server-01");
  });

  it("should filter by region", () => {
    setAllReturn(sampleResources);

    const result = getResources({ region: "sgp1" });

    expect(result).toHaveLength(1);
    expect(result[0]!.provider).toBe("digitalocean");
  });

  it("should search by resource name (case-insensitive)", () => {
    setAllReturn(sampleResources);

    const result = getResources({ search: "Web-Server" });

    expect(result).toHaveLength(1);
    expect(result[0]!.resourceId).toBe("i-abc123");
  });

  it("should search by resource ID (case-insensitive)", () => {
    setAllReturn(sampleResources);

    const result = getResources({ search: "DEF456" });

    expect(result).toHaveLength(1);
    expect(result[0]!.resourceName).toBe("db-primary");
  });

  it("should search by resource type (case-insensitive)", () => {
    setAllReturn(sampleResources);

    const result = getResources({ search: "Droplet" });

    expect(result).toHaveLength(1);
    expect(result[0]!.resourceId).toBe("do-789");
  });

  it("should combine provider filter with search", () => {
    setAllReturn(sampleResources);

    // "worker" matches do-789 (digitalocean), but provider filter says "aws"
    const result = getResources({ provider: "aws", search: "worker" });

    expect(result).toHaveLength(0);
  });

  it("should handle null resourceName and resourceType gracefully in search", () => {
    const resourcesWithNulls = [
      { provider: "aws", resourceId: "i-nul001", resourceName: null, resourceType: null, region: "us-east-1", usageCategory: "other" },
    ];
    setAllReturn(resourcesWithNulls);

    // Should not throw even though name/type are null
    const result = getResources({ search: "nul001" });

    expect(result).toHaveLength(1);
  });

  it("should return empty array when search matches nothing", () => {
    setAllReturn(sampleResources);

    const result = getResources({ search: "nonexistent" });

    expect(result).toHaveLength(0);
  });
});

// ===========================
// getProviderSyncStatus
// ===========================
describe("getProviderSyncStatus", () => {
  it("should return empty map when there are no sync logs", () => {
    setAllReturn([]);

    const result = getProviderSyncStatus();

    expect(result.size).toBe(0);
  });

  it("should return latest sync per provider", () => {
    const logs = [
      { provider: "aws", startedAt: "2026-03-18T10:00:00Z", status: "success" },
      { provider: "aws", startedAt: "2026-03-17T10:00:00Z", status: "failed" },
      { provider: "digitalocean", startedAt: "2026-03-18T08:00:00Z", status: "success" },
    ];
    setAllReturn(logs);

    const result = getProviderSyncStatus();

    expect(result.size).toBe(2);
    // Because logs are ordered desc and the function picks the first per provider,
    // "aws" should have the 03-18 entry
    expect(result.get("aws")!.lastSync).toBe("2026-03-18T10:00:00Z");
    expect(result.get("aws")!.status).toBe("success");
    expect(result.get("digitalocean")!.lastSync).toBe("2026-03-18T08:00:00Z");
  });

  it("should mark syncs older than 48 hours as stale", () => {
    const staleDate = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    const logs = [{ provider: "aws", startedAt: staleDate, status: "success" }];
    setAllReturn(logs);

    const result = getProviderSyncStatus();

    expect(result.get("aws")!.isStale).toBe(true);
  });

  it("should mark recent syncs as not stale", () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const logs = [{ provider: "aws", startedAt: recentDate, status: "success" }];
    setAllReturn(logs);

    const result = getProviderSyncStatus();

    expect(result.get("aws")!.isStale).toBe(false);
  });

  it("should mark a sync exactly at the 48h boundary as not stale", () => {
    // 47.9 hours ago — just under the threshold
    const borderDate = new Date(Date.now() - 47.9 * 60 * 60 * 1000).toISOString();
    const logs = [{ provider: "aws", startedAt: borderDate, status: "success" }];
    setAllReturn(logs);

    const result = getProviderSyncStatus();

    expect(result.get("aws")!.isStale).toBe(false);
  });
});

// ===========================
// getTopResources
// ===========================
describe("getTopResources", () => {
  it("should return results from the query chain", () => {
    const topItems = [
      { resourceId: "i-abc123", resourceName: "web-01", service: "EC2", totalAmount: 200 },
      { resourceId: "i-def456", resourceName: "db-01", service: "RDS", totalAmount: 150 },
    ];
    setAllReturn(topItems);

    const result = getTopResources("2026-03");

    expect(result).toEqual(topItems);
  });

  it("should return empty array when no resources exist for the period", () => {
    setAllReturn([]);

    const result = getTopResources("2026-01");

    expect(result).toEqual([]);
  });

  it("should use custom limit parameter", () => {
    setAllReturn([]);

    getTopResources("2026-03", 5);

    // Verify that .limit() was called (the mock chain records calls)
    expect((db as unknown as Record<string, Mock>).limit).toHaveBeenCalled();
  });
});

// ===========================
// getCostBreakdown
// ===========================
describe("getCostBreakdown", () => {
  it("should return breakdown by service", () => {
    const breakdown = [
      { key: "EC2", totalAmount: 300 },
      { key: "RDS", totalAmount: 150 },
    ];
    setAllReturn(breakdown);

    const result = getCostBreakdown("2026-03", "service");

    expect(result).toEqual(breakdown);
  });

  it("should return breakdown by region", () => {
    const breakdown = [
      { key: "us-east-1", totalAmount: 400 },
      { key: "us-west-2", totalAmount: 100 },
    ];
    setAllReturn(breakdown);

    const result = getCostBreakdown("2026-03", "region");

    expect(result).toEqual(breakdown);
  });

  it("should return breakdown by category", () => {
    const breakdown = [
      { key: "dpn", totalAmount: 500 },
      { key: "devops", totalAmount: 200 },
    ];
    setAllReturn(breakdown);

    const result = getCostBreakdown("2026-03", "category");

    expect(result).toEqual(breakdown);
  });

  it("should accept optional provider filter", () => {
    const breakdown = [{ key: "EC2", totalAmount: 250 }];
    setAllReturn(breakdown);

    const result = getCostBreakdown("2026-03", "service", "aws");

    expect(result).toEqual(breakdown);
  });

  it("should return empty array when no data matches", () => {
    setAllReturn([]);

    const result = getCostBreakdown("2020-01", "service");

    expect(result).toEqual([]);
  });
});

// ===========================
// Manual cost CRUD
// ===========================
describe("getManualCosts", () => {
  it("should return all manual costs when no billing period is specified", () => {
    const costs = [
      { id: 1, providerName: "cloudflare", billingPeriod: "2026-03", amount: 20 },
      { id: 2, providerName: "mongodb", billingPeriod: "2026-02", amount: 35 },
    ];
    setAllReturn(costs);

    const result = getManualCosts();

    expect(result).toEqual(costs);
  });

  it("should return filtered costs when billing period is specified", () => {
    const costs = [{ id: 1, providerName: "cloudflare", billingPeriod: "2026-03", amount: 20 }];
    setAllReturn(costs);

    const result = getManualCosts("2026-03");

    expect(result).toEqual(costs);
  });

  it("should return empty array when no manual costs exist", () => {
    setAllReturn([]);

    const result = getManualCosts();

    expect(result).toEqual([]);
  });
});

describe("createManualCost", () => {
  it("should insert and return the created record", () => {
    const newCost = {
      id: 1,
      providerName: "cloudflare",
      billingPeriod: "2026-03",
      amount: 25,
      note: "CDN charges",
      createdAt: "2026-03-18T00:00:00Z",
      updatedAt: "2026-03-18T00:00:00Z",
    };
    setGetReturn(newCost);

    const result = createManualCost({
      providerName: "cloudflare",
      billingPeriod: "2026-03",
      amount: 25,
      note: "CDN charges",
    });

    expect(result).toEqual(newCost);
    // Verify that .insert() and .values() were called
    expect((db as unknown as Record<string, Mock>).insert).toHaveBeenCalled();
    expect((db as unknown as Record<string, Mock>).values).toHaveBeenCalled();
  });

  it("should work without optional note field", () => {
    const newCost = {
      id: 2,
      providerName: "mongodb",
      billingPeriod: "2026-03",
      amount: 50,
      note: null,
      createdAt: "2026-03-18T00:00:00Z",
      updatedAt: "2026-03-18T00:00:00Z",
    };
    setGetReturn(newCost);

    const result = createManualCost({
      providerName: "mongodb",
      billingPeriod: "2026-03",
      amount: 50,
    });

    expect(result).toEqual(newCost);
  });
});

describe("updateManualCost", () => {
  it("should update and return the modified record", () => {
    const updated = {
      id: 1,
      providerName: "cloudflare",
      billingPeriod: "2026-03",
      amount: 30,
      note: "Updated CDN charges",
      updatedAt: "2026-03-18T12:00:00Z",
    };
    setGetReturn(updated);

    const result = updateManualCost(1, { amount: 30, note: "Updated CDN charges" });

    expect(result).toEqual(updated);
    expect((db as unknown as Record<string, Mock>).update).toHaveBeenCalled();
    expect((db as unknown as Record<string, Mock>).set).toHaveBeenCalled();
  });

  it("should allow partial updates (only providerName)", () => {
    const updated = {
      id: 1,
      providerName: "cloudflare-pro",
      billingPeriod: "2026-03",
      amount: 25,
      updatedAt: "2026-03-18T12:00:00Z",
    };
    setGetReturn(updated);

    const result = updateManualCost(1, { providerName: "cloudflare-pro" });

    expect(result).toEqual(updated);
  });
});

describe("deleteManualCost", () => {
  it("should delete the record and return run result", () => {
    const runResult = { changes: 1 };
    setRunReturn(runResult);

    const result = deleteManualCost(1);

    expect(result).toEqual(runResult);
    expect((db as unknown as Record<string, Mock>).delete).toHaveBeenCalled();
  });

  it("should return result even when id does not exist (no-op delete)", () => {
    const runResult = { changes: 0 };
    setRunReturn(runResult);

    const result = deleteManualCost(999);

    expect(result).toEqual(runResult);
  });
});
