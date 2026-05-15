/**
 * Unit tests for the settings provider API routes.
 *
 * Covered routes:
 *   GET  /api/v1/settings/providers
 *   PUT  /api/v1/settings/providers/[provider]
 *   POST /api/v1/settings/providers/[provider]/test
 *
 * All service-layer and provider dependencies are mocked so that each handler
 * is tested in complete isolation from the database and cloud APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock modules — declared before importing route handlers (vitest hoisting).
// ---------------------------------------------------------------------------

vi.mock("@/services/settings", () => ({
  getAllProviderSettings: vi.fn(),
  upsertProviderSetting: vi.fn(),
  getEffectiveCredentials: vi.fn(),
  updateTestResult: vi.fn(),
  getProviderSetting: vi.fn(),
  getConfigSource: vi.fn().mockReturnValue("database"),
}));

// Provider constructor mocks must use `function` (not arrow functions) so that
// vitest can call them with `new`. The default mock returns testConnection: true.
vi.mock("@/providers/aws", () => ({
  AwsProvider: vi.fn().mockImplementation(function () {
    return { testConnection: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock("@/providers/digitalocean", () => ({
  DigitalOceanProvider: vi.fn().mockImplementation(function () {
    return { testConnection: vi.fn().mockResolvedValue(true) };
  }),
}));

// ---------------------------------------------------------------------------
// Import route handlers AFTER mocks are registered.
//
// NOTE: Vite's module resolver cannot handle directory names containing square
// brackets (Next.js dynamic route segments such as `[provider]`). The two
// dynamic-segment handlers are therefore imported via dedicated aliases
// registered in vitest.config.ts instead of relative paths.
// ---------------------------------------------------------------------------
import { GET } from "../../api/v1/settings/providers/route";
// @ts-expect-error — resolved via vitest.config.ts alias "@settings-provider-route"
import { PUT } from "@settings-provider-route";
// @ts-expect-error — resolved via vitest.config.ts alias "@settings-provider-test-route"
import { POST as testPOST } from "@settings-provider-test-route";

// Import mocked services so individual tests can configure return values
import {
  getAllProviderSettings,
  upsertProviderSetting,
  getEffectiveCredentials,
  updateTestResult,
  getConfigSource,
} from "@/services/settings";

import { AwsProvider } from "@/providers/aws";
import { DigitalOceanProvider } from "@/providers/digitalocean";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest with an optional JSON body. */
function makeRequest(
  path: string,
  method: string,
  body?: unknown
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
// GET /api/v1/settings/providers
// ===========================================================================

describe("GET /api/v1/settings/providers", () => {
  it("returns 200 with the providers list on success", async () => {
    const mockProviders = [
      {
        provider: "aws",
        displayName: "Amazon Web Services",
        enabled: true,
        configured: true,
        configSource: "database",
        lastTestedAt: null,
        lastTestResult: null,
        credentialFields: [],
      },
      {
        provider: "digitalocean",
        displayName: "DigitalOcean",
        enabled: false,
        configured: false,
        configSource: "none",
        lastTestedAt: null,
        lastTestResult: null,
        credentialFields: [],
      },
    ];

    vi.mocked(getAllProviderSettings).mockReturnValue(mockProviders as any);

    const res = await GET();
    const data = await json<{ providers: typeof mockProviders }>(res);

    expect(res.status).toBe(200);
    expect(data.providers).toHaveLength(2);
    expect(data.providers[0].provider).toBe("aws");
    expect(data.providers[1].provider).toBe("digitalocean");
    expect(getAllProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when getAllProviderSettings throws", async () => {
    vi.mocked(getAllProviderSettings).mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const res = await GET();
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to load provider settings");
  });
});

// ===========================================================================
// PUT /api/v1/settings/providers/[provider]
// ===========================================================================

describe("PUT /api/v1/settings/providers/[provider]", () => {
  it("returns 400 for an unknown provider key", async () => {
    const req = makeRequest("/api/v1/settings/providers/gcp", "PUT", {
      enabled: true,
    });
    const params = { params: Promise.resolve({ provider: "gcp" }) };

    const res = await PUT(req, params);
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/unknown provider/i);
    expect(upsertProviderSetting).not.toHaveBeenCalled();
  });

  it("returns 400 when 'enabled' is not a boolean", async () => {
    const req = makeRequest("/api/v1/settings/providers/aws", "PUT", {
      enabled: "yes", // string instead of boolean
    });
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await PUT(req, params);
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/enabled must be a boolean/i);
    expect(upsertProviderSetting).not.toHaveBeenCalled();
  });

  it("returns 400 when 'credentials' is not an object", async () => {
    const req = makeRequest("/api/v1/settings/providers/aws", "PUT", {
      credentials: "not-an-object",
    });
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await PUT(req, params);
    const data = await json<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/credentials must be an object/i);
    expect(upsertProviderSetting).not.toHaveBeenCalled();
  });

  it("calls upsertProviderSetting and returns success on valid input", async () => {
    const mockRow = {
      id: 1,
      provider: "aws",
      displayName: "Amazon Web Services",
      enabled: true,
      credentials: null,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    };
    vi.mocked(upsertProviderSetting).mockReturnValue(mockRow as any);

    const req = makeRequest("/api/v1/settings/providers/aws", "PUT", {
      enabled: true,
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        region: "us-east-1",
      },
    });
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await PUT(req, params);
    const data = await json<{
      success: boolean;
      provider: string;
      enabled: boolean;
      configSource: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.provider).toBe("aws");
    expect(data.enabled).toBe(true);
    expect(upsertProviderSetting).toHaveBeenCalledWith("aws", {
      enabled: true,
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        region: "us-east-1",
      },
    });
  });

  it("accepts null credentials (clears DB credentials to fall back to env)", async () => {
    const mockRow = {
      id: 1,
      provider: "aws",
      displayName: "Amazon Web Services",
      enabled: true,
      credentials: null,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    };
    vi.mocked(upsertProviderSetting).mockReturnValue(mockRow as any);
    // After clearing DB credentials, configSource should reflect env fallback
    vi.mocked(getConfigSource).mockReturnValue("env");

    const req = makeRequest("/api/v1/settings/providers/aws", "PUT", {
      credentials: null,
    });
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await PUT(req, params);
    const data = await json<{ success: boolean; configSource: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // row.credentials is null → configSource should be "env"
    expect(data.configSource).toBe("env");
    expect(upsertProviderSetting).toHaveBeenCalledWith("aws", {
      enabled: undefined,
      credentials: null,
    });
  });

  it("accepts valid input for 'digitalocean' provider", async () => {
    const mockRow = {
      id: 2,
      provider: "digitalocean",
      displayName: "DigitalOcean",
      enabled: true,
      credentials: "encrypted",
      lastTestedAt: null,
      lastTestResult: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    };
    vi.mocked(upsertProviderSetting).mockReturnValue(mockRow as any);
    vi.mocked(getConfigSource).mockReturnValue("database");

    const req = makeRequest("/api/v1/settings/providers/digitalocean", "PUT", {
      enabled: true,
      credentials: { apiToken: "dop_v1_abc" },
    });
    const params = { params: Promise.resolve({ provider: "digitalocean" }) };

    const res = await PUT(req, params);
    const data = await json<{ success: boolean; provider: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.provider).toBe("digitalocean");
    // row.credentials is non-null → configSource should be "database"
    expect((data as any).configSource).toBe("database");
  });
});

// ===========================================================================
// POST /api/v1/settings/providers/[provider]/test
// ===========================================================================

describe("POST /api/v1/settings/providers/[provider]/test", () => {
  it("returns 400 for an unknown provider key", async () => {
    const req = makeRequest("/api/v1/settings/providers/gcp/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "gcp" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toMatch(/unknown provider/i);
  });

  it("returns success: true when testConnection resolves to true (AWS)", async () => {
    vi.mocked(getEffectiveCredentials).mockReturnValue({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      region: "us-east-1",
    });

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toMatch(/successful/i);
    expect(updateTestResult).toHaveBeenCalledWith("aws", true);
  });

  it("returns success: false when testConnection resolves to false (AWS)", async () => {
    // Override the mock to return false for this test
    vi.mocked(AwsProvider).mockImplementationOnce(function () {
      return { testConnection: vi.fn().mockResolvedValue(false) } as any;
    });

    vi.mocked(getEffectiveCredentials).mockReturnValue({
      accessKeyId: "AKID",
      secretAccessKey: "WRONG_SECRET",
      region: "us-east-1",
    });

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.message).toMatch(/failed/i);
    expect(updateTestResult).toHaveBeenCalledWith("aws", false);
  });

  it("uses provided temporary credentials when included in request body", async () => {
    vi.mocked(getEffectiveCredentials).mockReturnValue(null);

    const tempCreds = {
      accessKeyId: "TEMP_KEY",
      secretAccessKey: "TEMP_SECRET",
      region: "us-west-2",
    };

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {
      credentials: tempCreds,
    });
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean }>(res);

    // getEffectiveCredentials should NOT be called because temp creds were provided
    expect(getEffectiveCredentials).not.toHaveBeenCalled();
    expect(data.success).toBe(true);
  });

  it("falls back to saved credentials when no temp creds are in the body", async () => {
    vi.mocked(getEffectiveCredentials).mockReturnValue({
      accessKeyId: "SAVED_KEY",
      secretAccessKey: "SAVED_SECRET",
      region: "us-east-1",
    });

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean }>(res);

    expect(getEffectiveCredentials).toHaveBeenCalledWith("aws");
    expect(data.success).toBe(true);
  });

  it("returns success: false (no 400) when no credentials are available", async () => {
    vi.mocked(getEffectiveCredentials).mockReturnValue(null);

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    // The route returns 200 with success: false (not a 4xx) in this case
    expect(data.success).toBe(false);
    expect(data.message).toMatch(/no credentials available/i);
    expect(updateTestResult).not.toHaveBeenCalled();
  });

  it("works correctly for DigitalOcean provider", async () => {
    vi.mocked(getEffectiveCredentials).mockReturnValue({
      apiToken: "dop_v1_abc123",
    });

    const req = makeRequest(
      "/api/v1/settings/providers/digitalocean/test",
      "POST",
      {}
    );
    const params = { params: Promise.resolve({ provider: "digitalocean" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(updateTestResult).toHaveBeenCalledWith("digitalocean", true);
  });

  it("returns DigitalOcean failure when testConnection rejects", async () => {
    vi.mocked(DigitalOceanProvider).mockImplementationOnce(function () {
      return { testConnection: vi.fn().mockResolvedValue(false) } as any;
    });

    vi.mocked(getEffectiveCredentials).mockReturnValue({
      apiToken: "dop_v1_bad",
    });

    const req = makeRequest(
      "/api/v1/settings/providers/digitalocean/test",
      "POST",
      {}
    );
    const params = { params: Promise.resolve({ provider: "digitalocean" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    expect(updateTestResult).toHaveBeenCalledWith("digitalocean", false);
  });

  it("returns success: false with error message when testConnection throws", async () => {
    vi.mocked(AwsProvider).mockImplementationOnce(function () {
      return {
        testConnection: vi.fn().mockRejectedValue(new Error("Network timeout")),
      } as any;
    });

    vi.mocked(getEffectiveCredentials).mockReturnValue({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "us-east-1",
    });

    const req = makeRequest("/api/v1/settings/providers/aws/test", "POST", {});
    const params = { params: Promise.resolve({ provider: "aws" }) };

    const res = await testPOST(req, params);
    const data = await json<{ success: boolean; message: string }>(res);

    // Route catches the error and returns success: false with the error message
    expect(data.success).toBe(false);
    expect(data.message).toMatch(/network timeout/i);
  });
});
