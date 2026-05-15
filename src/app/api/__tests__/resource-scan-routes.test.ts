/**
 * Unit tests for the resource scan API routes.
 *
 * Covered routes:
 *   GET  /api/v1/resource-scan  — scan status & history
 *   POST /api/v1/resource-scan  — trigger a scan
 *
 * The scan orchestrator is fully mocked so that each handler is tested
 * in isolation from the database and cloud APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock modules — declared before importing route handlers (vitest hoisting).
// ---------------------------------------------------------------------------

const mockGetScanStatus = vi.fn();
const mockStartScan = vi.fn();

vi.mock("@/discoverers/scan-orchestrator", () => ({
  scanOrchestrator: {
    getScanStatus: (...args: unknown[]) => mockGetScanStatus(...args),
    startScan: (...args: unknown[]) => mockStartScan(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import route handlers AFTER mocks are registered.
// ---------------------------------------------------------------------------
import { GET, POST } from "../../api/v1/resource-scan/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest with an optional JSON body. */
function makeRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>
): NextRequest {
  const url = `http://localhost:3000${path}`;
  if (body !== undefined) {
    return new NextRequest(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new NextRequest(url, { method });
}

/** Extract JSON from a Response. */
async function json<T = unknown>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// GET /api/v1/resource-scan
// ===========================================================================

describe("GET /api/v1/resource-scan", () => {
  it("returns 200 with scan status", async () => {
    const mockStatus = {
      currentScan: null,
      recentScans: [
        { id: 1, status: "success", startedAt: "2026-04-01T00:00:00Z" },
      ],
    };
    mockGetScanStatus.mockReturnValue(mockStatus);

    const res = await GET();
    const data = await json<typeof mockStatus>(res);

    expect(res.status).toBe(200);
    expect(data.currentScan).toBeNull();
    expect(data.recentScans).toHaveLength(1);
    expect(data.recentScans[0].status).toBe("success");
    expect(mockGetScanStatus).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when getScanStatus throws", async () => {
    mockGetScanStatus.mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const res = await GET();
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to get scan status");
  });
});

// ===========================================================================
// POST /api/v1/resource-scan
// ===========================================================================

describe("POST /api/v1/resource-scan", () => {
  it("starts scan successfully and returns scanId + status", async () => {
    mockStartScan.mockResolvedValue({ scanId: 42 });

    const req = makeRequest("/api/v1/resource-scan", "POST", {});
    const res = await POST(req);
    const data = await json<{ scanId: number; status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.scanId).toBe(42);
    expect(data.status).toBe("running");
    expect(data.message).toBe("Resource scan started");
    expect(mockStartScan).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when a scan is already running", async () => {
    mockStartScan.mockResolvedValue({ error: "A scan is already running" });

    const req = makeRequest("/api/v1/resource-scan", "POST", {});
    const res = await POST(req);
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(409);
    expect(data.error).toBe("A scan is already running");
  });

  it("accepts optional provider parameter", async () => {
    mockStartScan.mockResolvedValue({ scanId: 99 });

    const req = makeRequest("/api/v1/resource-scan", "POST", { provider: "aws" });
    const res = await POST(req);
    const data = await json<{ scanId: number; status: string }>(res);

    expect(res.status).toBe(200);
    expect(data.scanId).toBe(99);
    expect(data.status).toBe("running");
    // Verify the provider was passed through to startScan
    expect(mockStartScan).toHaveBeenCalledWith("aws");
  });

  it("handles empty body gracefully (scans all providers)", async () => {
    mockStartScan.mockResolvedValue({ scanId: 7 });

    // Request with no body at all
    const req = new NextRequest("http://localhost:3000/api/v1/resource-scan", {
      method: "POST",
    });
    const res = await POST(req);
    const data = await json<{ scanId: number; status: string }>(res);

    expect(res.status).toBe(200);
    expect(data.scanId).toBe(7);
    // startScan is called with undefined provider (scan all)
    expect(mockStartScan).toHaveBeenCalledWith(undefined);
  });

  it("returns 500 when startScan throws unexpectedly", async () => {
    mockStartScan.mockRejectedValue(new Error("Unexpected failure"));

    const req = makeRequest("/api/v1/resource-scan", "POST", {});
    const res = await POST(req);
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to start scan");
  });
});
