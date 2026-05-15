/**
 * Unit tests for src/providers/index.ts — createProviders()
 *
 * The new createProviders() is parameterless; it reads enabled state and
 * credentials from the settings service internally. We mock the settings
 * service functions and the concrete provider constructors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock settings service — controls which providers are enabled and what creds
// ---------------------------------------------------------------------------
vi.mock("@/services/settings", () => ({
  isProviderEnabled: vi.fn(),
  getEffectiveCredentials: vi.fn(),
}));

// Mock concrete providers so we don't hit real SDKs
vi.mock("../aws", () => {
  const AwsProvider = vi.fn(function (this: Record<string, unknown>, config: unknown) {
    this.name = "aws";
    this.displayName = "Amazon Web Services";
    this._config = config;
  });
  return { AwsProvider };
});

vi.mock("../digitalocean", () => {
  const DigitalOceanProvider = vi.fn(function (this: Record<string, unknown>, config: unknown) {
    this.name = "digitalocean";
    this.displayName = "DigitalOcean";
    this._config = config;
  });
  return { DigitalOceanProvider };
});

import { createProviders } from "../index";
import { isProviderEnabled, getEffectiveCredentials } from "@/services/settings";
import { AwsProvider } from "../aws";
import { DigitalOceanProvider } from "../digitalocean";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure mocks so a provider is enabled with credentials */
function enableProvider(key: string, creds: Record<string, string>) {
  vi.mocked(isProviderEnabled).mockImplementation((k) =>
    k === key ? true : vi.mocked(isProviderEnabled).getMockImplementation()!(k)
  );
  vi.mocked(getEffectiveCredentials).mockImplementation((k) =>
    k === key ? creds : vi.mocked(getEffectiveCredentials).getMockImplementation()!(k)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createProviders", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: all providers disabled, no credentials
    vi.mocked(isProviderEnabled).mockReturnValue(false);
    vi.mocked(getEffectiveCredentials).mockReturnValue(null);
  });

  it("creates both providers when enabled and credentials present", () => {
    vi.mocked(isProviderEnabled).mockReturnValue(true);
    vi.mocked(getEffectiveCredentials).mockImplementation((key) => {
      if (key === "aws") {
        return { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };
      }
      if (key === "digitalocean") {
        return { apiToken: "dop_v1_token" };
      }
      return null;
    });

    const providers = createProviders();

    expect(providers.size).toBe(2);
    expect(providers.has("aws")).toBe(true);
    expect(providers.has("digitalocean")).toBe(true);
  });

  it("skips AWS when disabled", () => {
    vi.mocked(isProviderEnabled).mockImplementation((key) => key === "digitalocean");
    vi.mocked(getEffectiveCredentials).mockImplementation((key) => {
      if (key === "aws") return { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };
      if (key === "digitalocean") return { apiToken: "dop_v1_token" };
      return null;
    });

    const providers = createProviders();

    expect(providers.size).toBe(1);
    expect(providers.has("aws")).toBe(false);
    expect(providers.has("digitalocean")).toBe(true);
  });

  it("skips DigitalOcean when disabled", () => {
    vi.mocked(isProviderEnabled).mockImplementation((key) => key === "aws");
    vi.mocked(getEffectiveCredentials).mockImplementation((key) => {
      if (key === "aws") return { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };
      return null;
    });

    const providers = createProviders();

    expect(providers.size).toBe(1);
    expect(providers.has("aws")).toBe(true);
    expect(providers.has("digitalocean")).toBe(false);
  });

  it("skips provider when credentials are null", () => {
    vi.mocked(isProviderEnabled).mockReturnValue(true);
    vi.mocked(getEffectiveCredentials).mockReturnValue(null);

    const providers = createProviders();

    expect(providers.size).toBe(0);
  });

  it("returns empty map when all providers are disabled", () => {
    vi.mocked(isProviderEnabled).mockReturnValue(false);

    const providers = createProviders();

    expect(providers.size).toBe(0);
  });

  it("handles factory errors gracefully without crashing", () => {
    vi.mocked(isProviderEnabled).mockReturnValue(true);
    // Provide invalid credentials that will cause toProviderConfig or factory to choke
    vi.mocked(getEffectiveCredentials).mockImplementation((key) => {
      if (key === "aws") return { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };
      if (key === "digitalocean") return { apiToken: "token" };
      return null;
    });

    // Make AwsProvider throw
    vi.mocked(AwsProvider).mockImplementation(() => {
      throw new Error("AWS SDK init failed");
    });

    // Should still create DO provider despite AWS failure
    const providers = createProviders();

    expect(providers.has("aws")).toBe(false);
    expect(providers.has("digitalocean")).toBe(true);
  });

  it("passes transformed config from toProviderConfig to factory", () => {
    vi.mocked(isProviderEnabled).mockImplementation((key) => key === "aws");
    vi.mocked(getEffectiveCredentials).mockImplementation((key) => {
      if (key === "aws") {
        return {
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
          region: "us-east-1",
          resourceRegions: "us-east-1, ap-southeast-1",
        };
      }
      return null;
    });

    const providers = createProviders();

    expect(providers.size).toBe(1);
    // toProviderConfig splits resourceRegions string into array
    expect(AwsProvider).toHaveBeenCalledWith({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      region: "us-east-1",
      resourceRegions: ["us-east-1", "ap-southeast-1"],
    });
  });
});
