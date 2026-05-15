/**
 * Unit tests for the provider registry (src/providers/registry.ts).
 *
 * Validates registry structure, credential field metadata, and the
 * toProviderConfig() transform logic for each registered provider.
 */
import { describe, it, expect } from "vitest";
import { PROVIDER_REGISTRY } from "../registry";

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY — structure", () => {
  it("contains entries for 'aws' and 'digitalocean'", () => {
    expect(PROVIDER_REGISTRY).toHaveProperty("aws");
    expect(PROVIDER_REGISTRY).toHaveProperty("digitalocean");
  });

  it("has exactly two registered providers", () => {
    expect(Object.keys(PROVIDER_REGISTRY)).toHaveLength(2);
  });

  it.each(["aws", "digitalocean"] as const)(
    "%s entry has a non-empty displayName",
    (key) => {
      const meta = PROVIDER_REGISTRY[key];
      expect(typeof meta.displayName).toBe("string");
      expect(meta.displayName.length).toBeGreaterThan(0);
    }
  );

  it.each(["aws", "digitalocean"] as const)(
    "%s entry has a credentialFields array",
    (key) => {
      const meta = PROVIDER_REGISTRY[key];
      expect(Array.isArray(meta.credentialFields)).toBe(true);
      expect(meta.credentialFields.length).toBeGreaterThan(0);
    }
  );

  it.each(["aws", "digitalocean"] as const)(
    "%s entry has a toProviderConfig function",
    (key) => {
      expect(typeof PROVIDER_REGISTRY[key].toProviderConfig).toBe("function");
    }
  );
});

// ---------------------------------------------------------------------------
// AWS — credential fields
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY.aws — credential fields", () => {
  const { credentialFields } = PROVIDER_REGISTRY.aws;

  it("has exactly 4 credential fields", () => {
    expect(credentialFields).toHaveLength(4);
  });

  it("contains accessKeyId, secretAccessKey, region, and resourceRegions", () => {
    const keys = credentialFields.map((f) => f.key);
    expect(keys).toContain("accessKeyId");
    expect(keys).toContain("secretAccessKey");
    expect(keys).toContain("region");
    expect(keys).toContain("resourceRegions");
  });

  it("marks accessKeyId and secretAccessKey as required", () => {
    const byKey = Object.fromEntries(credentialFields.map((f) => [f.key, f]));
    expect(byKey.accessKeyId.required).toBe(true);
    expect(byKey.secretAccessKey.required).toBe(true);
  });

  it("marks region as required", () => {
    const region = credentialFields.find((f) => f.key === "region");
    expect(region?.required).toBe(true);
  });

  it("marks resourceRegions as NOT required (optional)", () => {
    const resourceRegions = credentialFields.find((f) => f.key === "resourceRegions");
    expect(resourceRegions?.required).toBe(false);
  });

  it("marks secretAccessKey as type 'password'", () => {
    const field = credentialFields.find((f) => f.key === "secretAccessKey");
    expect(field?.type).toBe("password");
  });

  it("marks accessKeyId as type 'text'", () => {
    const field = credentialFields.find((f) => f.key === "accessKeyId");
    expect(field?.type).toBe("text");
  });

  it("marks region and resourceRegions as type 'text'", () => {
    const byKey = Object.fromEntries(credentialFields.map((f) => [f.key, f]));
    expect(byKey.region.type).toBe("text");
    expect(byKey.resourceRegions.type).toBe("text");
  });

  it("region has a default value of 'us-east-1'", () => {
    const region = credentialFields.find((f) => f.key === "region");
    expect(region?.default).toBe("us-east-1");
  });

  it("resourceRegions has a hint about comma-separated values", () => {
    const field = credentialFields.find((f) => f.key === "resourceRegions");
    expect(field?.hint).toBeTruthy();
    expect(field?.hint).toMatch(/comma/i);
  });
});

// ---------------------------------------------------------------------------
// AWS — toProviderConfig
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY.aws — toProviderConfig()", () => {
  const { toProviderConfig } = PROVIDER_REGISTRY.aws;

  it("passes accessKeyId and secretAccessKey through unchanged", () => {
    const config = toProviderConfig({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    });
    expect(config.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config.secretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  it("uses the provided region", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "ap-southeast-1",
    });
    expect(config.region).toBe("ap-southeast-1");
  });

  it("defaults region to 'us-east-1' when region is empty string", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "",
    });
    expect(config.region).toBe("us-east-1");
  });

  it("splits resourceRegions on commas into an array", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "us-east-1",
      resourceRegions: "us-east-1,ap-southeast-1,eu-west-1",
    });
    expect(config.resourceRegions).toEqual(["us-east-1", "ap-southeast-1", "eu-west-1"]);
  });

  it("trims whitespace from each region in resourceRegions", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "us-east-1",
      resourceRegions: " us-east-1 , ap-southeast-1 ",
    });
    expect(config.resourceRegions).toEqual(["us-east-1", "ap-southeast-1"]);
  });

  it("falls back to region when resourceRegions is not provided", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "eu-west-1",
    });
    expect(config.resourceRegions).toEqual(["eu-west-1"]);
  });

  it("falls back to 'us-east-1' when both region and resourceRegions are absent", () => {
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
    });
    expect(config.resourceRegions).toEqual(["us-east-1"]);
    expect(config.region).toBe("us-east-1");
  });

  it("filters out blank entries from resourceRegions after splitting", () => {
    // Edge case: trailing comma produces an empty string after split
    const config = toProviderConfig({
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "us-east-1",
      resourceRegions: "us-east-1,,ap-southeast-1,",
    });
    expect(config.resourceRegions).toEqual(["us-east-1", "ap-southeast-1"]);
  });
});

// ---------------------------------------------------------------------------
// DigitalOcean — credential fields
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY.digitalocean — credential fields", () => {
  const { displayName, credentialFields } = PROVIDER_REGISTRY.digitalocean;

  it("has displayName 'DigitalOcean'", () => {
    expect(displayName).toBe("DigitalOcean");
  });

  it("has exactly 1 credential field", () => {
    expect(credentialFields).toHaveLength(1);
  });

  it("the single field has key 'apiToken'", () => {
    expect(credentialFields[0].key).toBe("apiToken");
  });

  it("apiToken is required", () => {
    expect(credentialFields[0].required).toBe(true);
  });

  it("apiToken is type 'password'", () => {
    expect(credentialFields[0].type).toBe("password");
  });
});

// ---------------------------------------------------------------------------
// DigitalOcean — toProviderConfig
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY.digitalocean — toProviderConfig()", () => {
  const { toProviderConfig } = PROVIDER_REGISTRY.digitalocean;

  it("passes apiToken through to the config object", () => {
    const config = toProviderConfig({ apiToken: "dop_v1_abc123" });
    expect(config.apiToken).toBe("dop_v1_abc123");
  });

  it("returns an object with only the apiToken key", () => {
    const config = toProviderConfig({ apiToken: "dop_v1_abc123" });
    expect(Object.keys(config)).toEqual(["apiToken"]);
  });

  it("propagates an empty apiToken as-is (validation is caller's responsibility)", () => {
    const config = toProviderConfig({ apiToken: "" });
    expect(config.apiToken).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AWS displayName
// ---------------------------------------------------------------------------

describe("PROVIDER_REGISTRY.aws — displayName", () => {
  it("has displayName 'Amazon Web Services'", () => {
    expect(PROVIDER_REGISTRY.aws.displayName).toBe("Amazon Web Services");
  });
});
