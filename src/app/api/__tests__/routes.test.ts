/**
 * Unit tests for Next.js App Router API route handlers.
 *
 * Tests each route handler (GET/POST) by mocking the
 * service layer (`@/services/billing`, `@/services/sync`, `@/providers`)
 * and invoking with a standard NextRequest object.
 *
 * Covered routes:
 *   /api/v1/summary   — GET
 *   /api/v1/sync      — POST + GET
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock modules — must be declared before importing the route handlers.
// ---------------------------------------------------------------------------

vi.mock("@/services/billing", () => ({
  getMonthlySummary: vi.fn(),
  getProviderSyncStatus: vi.fn(),
}));

vi.mock("@/services/sync", () => ({
  syncProvider: vi.fn(),
  syncAll: vi.fn(),
}));

vi.mock("@/providers", () => ({
  createProviders: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  getCurrentMonth: vi.fn(() => "2026-03"),
}));

// ---------------------------------------------------------------------------
// Import route handlers AFTER mocks are registered
// ---------------------------------------------------------------------------
import { GET as summaryGET } from "../../api/v1/summary/route";
import { POST as syncPOST, GET as syncGET } from "../../api/v1/sync/route";

// Import mocked services for configuring return values
import {
  getMonthlySummary,
  getProviderSyncStatus,
} from "@/services/billing";

import { syncProvider, syncAll } from "@/services/sync";
import { createProviders } from "@/providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest with optional query params. */
function makeRequest(
  path: string,
  params?: Record<string, string>,
  options?: RequestInit
): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url.toString(), options);
}

/** Build a NextRequest with a JSON body (for POST/PUT/PATCH). */
function makeJsonRequest(
  path: string,
  body: unknown,
  method = "POST",
  params?: Record<string, string>
): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Extract JSON body from a Response. */
async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

// =========================================================================
// /api/v1/summary
// =========================================================================
describe("GET /api/v1/summary", () => {
  const mockSummary = {
    month: "2026-03",
    providers: [
      { provider: "aws", amount: 120.5, isManual: false },
      { provider: "cloudflare", amount: 20, isManual: true },
    ],
    totalAuto: 120.5,
    totalManual: 20,
    total: 140.5,
  };

  it("returns 200 with monthly summary for a given month", async () => {
    vi.mocked(getMonthlySummary).mockReturnValue(mockSummary);

    const res = await summaryGET(makeRequest("/api/v1/summary", { month: "2026-03" }) as any);
    const data = await json(res) as typeof mockSummary;

    expect(res.status).toBe(200);
    expect(data.month).toBe("2026-03");
    expect(data.providers).toHaveLength(2);
    expect(data.total).toBe(140.5);
    expect(getMonthlySummary).toHaveBeenCalledWith("2026-03");
  });

  it("defaults to undefined month when param is not provided", async () => {
    vi.mocked(getMonthlySummary).mockReturnValue({ ...mockSummary, month: "2026-03" });

    await summaryGET(makeRequest("/api/v1/summary") as any);

    expect(getMonthlySummary).toHaveBeenCalledWith(undefined);
  });

  it("returns 500 when the service throws", async () => {
    vi.mocked(getMonthlySummary).mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const res = await summaryGET(makeRequest("/api/v1/summary") as any);
    const data = await json(res) as { error: string };

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to fetch summary");
  });
});

// =========================================================================
// /api/v1/sync
// =========================================================================
describe("POST /api/v1/sync", () => {
  const mockProviderInstance = {
    name: "aws",
    displayName: "AWS",
    fetchBills: vi.fn(),
    fetchBillItems: vi.fn(),
    fetchResources: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(createProviders).mockReturnValue(
      new Map([["aws", mockProviderInstance as any]])
    );
  });

  it("syncs all providers when no specific provider is given", async () => {
    const results = [{ provider: "aws", status: "success", recordsSynced: 10, syncLogId: 1 }];
    vi.mocked(syncAll).mockResolvedValue(results as any);

    const req = makeJsonRequest("/api/v1/sync", {});
    const res = await syncPOST(req as any);
    const data = await json(res) as { results: unknown[] };

    expect(res.status).toBe(200);
    expect(data.results).toEqual(results);
    expect(syncAll).toHaveBeenCalled();
  });

  it("syncs a specific provider when provider is given in body", async () => {
    const result = { provider: "aws", status: "success", recordsSynced: 5, syncLogId: 2 };
    vi.mocked(syncProvider).mockResolvedValue(result as any);

    const req = makeJsonRequest("/api/v1/sync", { provider: "aws" });
    const res = await syncPOST(req as any);
    const data = await json(res) as { result: unknown };

    expect(res.status).toBe(200);
    expect(data.result).toEqual(result);
    expect(syncProvider).toHaveBeenCalledWith(mockProviderInstance, "manual", 6);
  });

  it("returns 404 when the specified provider is not found", async () => {
    const req = makeJsonRequest("/api/v1/sync", { provider: "gcp" });
    const res = await syncPOST(req as any);
    const data = await json(res) as { error: string };

    expect(res.status).toBe(404);
    expect(data.error).toContain("gcp");
    expect(data.error).toContain("not found");
  });

  it("handles request without JSON body gracefully", async () => {
    vi.mocked(syncAll).mockResolvedValue([]);

    const req = new NextRequest("http://localhost:3000/api/v1/sync", { method: "POST" });
    const res = await syncPOST(req as any);

    expect(res.status).toBe(200);
    expect(syncAll).toHaveBeenCalled();
  });

  it("returns 500 when sync throws an error", async () => {
    vi.mocked(createProviders).mockImplementation(() => {
      throw new Error("Config load failed");
    });

    const req = makeJsonRequest("/api/v1/sync", {});
    const res = await syncPOST(req as any);
    const data = await json(res) as { error: string };

    expect(res.status).toBe(500);
    expect(data.error).toBe("Sync failed");
  });

  it("respects SYNC_BACKFILL_MONTHS env variable", async () => {
    const originalEnv = process.env.SYNC_BACKFILL_MONTHS;
    process.env.SYNC_BACKFILL_MONTHS = "3";

    vi.mocked(syncProvider).mockResolvedValue({
      provider: "aws",
      status: "success",
      recordsSynced: 5,
      syncLogId: 3,
    });

    const req = makeJsonRequest("/api/v1/sync", { provider: "aws" });
    await syncPOST(req as any);

    expect(syncProvider).toHaveBeenCalledWith(mockProviderInstance, "manual", 3);

    // Restore env
    if (originalEnv === undefined) {
      delete process.env.SYNC_BACKFILL_MONTHS;
    } else {
      process.env.SYNC_BACKFILL_MONTHS = originalEnv;
    }
  });
});

describe("GET /api/v1/sync", () => {
  it("returns sync status as a plain object", async () => {
    const statusMap = new Map([
      ["aws", { lastSync: "2026-03-18T10:00:00Z", status: "success", isStale: false }],
      ["digitalocean", { lastSync: "2026-03-17T08:00:00Z", status: "success", isStale: true }],
    ]);
    vi.mocked(getProviderSyncStatus).mockReturnValue(statusMap);

    const res = await syncGET();
    const data = await json(res) as {
      status: Record<string, { lastSync: string; status: string; isStale: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(data.status.aws).toEqual({
      lastSync: "2026-03-18T10:00:00Z",
      status: "success",
      isStale: false,
    });
    expect(data.status.digitalocean).toEqual({
      lastSync: "2026-03-17T08:00:00Z",
      status: "success",
      isStale: true,
    });
  });

  it("returns empty object when no sync logs exist", async () => {
    vi.mocked(getProviderSyncStatus).mockReturnValue(new Map());

    const res = await syncGET();
    const data = await json(res) as { status: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(Object.keys(data.status)).toHaveLength(0);
  });

  it("returns 500 when the service throws", async () => {
    vi.mocked(getProviderSyncStatus).mockImplementation(() => {
      throw new Error("DB error");
    });

    const res = await syncGET();
    const data = await json(res) as { error: string };

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to get sync status");
  });
});
