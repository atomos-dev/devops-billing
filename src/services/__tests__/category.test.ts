/**
 * Unit tests for the usage category classification service.
 * Covers all three classification priorities (tag-based, name pattern, default),
 * all six category types, and edge cases around null/undefined/empty inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyResource, type UsageCategory } from "@/services/category";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: build a single-key tag object */
function tag(key: string, value: string): Record<string, string> {
  return { [key]: value };
}

// ---------------------------------------------------------------------------
// Priority 1 — Tag-based classification
// ---------------------------------------------------------------------------
describe("classifyResource — tag-based classification (Priority 1)", () => {
  const tagKeys = ["usage", "purpose", "category", "team", "project"];
  const allCategories: UsageCategory[] = [
    "dpn",
    "mainnet",
    "devops",
    "dbg",
    "gc",
    "other",
  ];

  describe.each(tagKeys)("recognises the '%s' tag key", (key) => {
    it.each(allCategories)(
      "returns '%s' when tag value matches exactly",
      (cat) => {
        expect(classifyResource(tag(key, cat), undefined)).toBe(cat);
      },
    );
  });

  it("tag lookup is case-insensitive (value)", () => {
    expect(classifyResource(tag("usage", "DPN"), undefined)).toBe("dpn");
    expect(classifyResource(tag("usage", "Mainnet"), undefined)).toBe(
      "mainnet",
    );
    expect(classifyResource(tag("usage", "DEVOPS"), undefined)).toBe("devops");
    expect(classifyResource(tag("usage", "DBG"), undefined)).toBe("dbg");
    expect(classifyResource(tag("usage", "GC"), undefined)).toBe("gc");
    expect(classifyResource(tag("usage", "OTHER"), undefined)).toBe("other");
  });

  it("tag key is case-sensitive (only lowercase keys are checked)", () => {
    // The implementation checks exact lowercase keys; an uppercase key should NOT match
    expect(classifyResource({ Usage: "dpn" }, undefined)).toBe("other");
    expect(classifyResource({ PURPOSE: "mainnet" }, undefined)).toBe("other");
  });

  it("first matching tag key wins (priority order)", () => {
    // "usage" is checked before "project"
    const tags = { usage: "dpn", project: "mainnet" };
    expect(classifyResource(tags, undefined)).toBe("dpn");
  });

  it("skips tag keys whose value is not a valid category", () => {
    const tags = { usage: "unknown-value", purpose: "mainnet" };
    expect(classifyResource(tags, undefined)).toBe("mainnet");
  });

  it("tags take priority over name pattern matching", () => {
    // name matches "devops" pattern, but tag says "dpn"
    expect(classifyResource(tag("usage", "dpn"), "devops-server-01")).toBe(
      "dpn",
    );
  });
});

// ---------------------------------------------------------------------------
// Priority 2 — Name pattern matching
// ---------------------------------------------------------------------------
describe("classifyResource — name pattern matching (Priority 2)", () => {
  // dpn patterns: /cloud-node/i, /dpn/i, /deeper-node/i, /vpn-node/i
  describe("dpn patterns", () => {
    it.each([
      "cloud-node-us-west-1",
      "my-dpn-server",
      "deeper-node-42",
      "vpn-node-east",
      "CLOUD-NODE-UPPER",
      "DPN-UPPER",
    ])("matches '%s'", (name) => {
      expect(classifyResource(undefined, name)).toBe("dpn");
    });
  });

  // mainnet patterns: /mainnet/i, /main-net/i, /blockchain/i, /chain-node/i
  describe("mainnet patterns", () => {
    it.each([
      "mainnet-validator-1",
      "main-net-rpc",
      "blockchain-explorer",
      "chain-node-01",
      "MAINNET-UPPER",
    ])("matches '%s'", (name) => {
      expect(classifyResource(undefined, name)).toBe("mainnet");
    });
  });

  // devops patterns: /devops/i, /ci-cd/i, /jenkins/i, /monitor/i, /grafana/i, /prometheus/i
  describe("devops patterns", () => {
    it.each([
      "devops-tooling",
      "ci-cd-runner",
      "jenkins-master",
      "monitor-prod",
      "grafana-dashboard",
      "prometheus-server",
      "DEVOPS-UPPER",
    ])("matches '%s'", (name) => {
      expect(classifyResource(undefined, name)).toBe("devops");
    });
  });

  // dbg patterns: /dbg/i, /debug/i, /staging/i, /test/i
  describe("dbg patterns", () => {
    it.each([
      "dbg-instance",
      "debug-server",
      "staging-api",
      "test-runner",
      "my-test-env",
      "DBG-UPPER",
    ])("matches '%s'", (name) => {
      expect(classifyResource(undefined, name)).toBe("dbg");
    });
  });

  // gc patterns: /gc-/i, /garbage/i
  describe("gc patterns", () => {
    it.each(["gc-cleanup-job", "garbage-collector", "GC-UPPER", "GARBAGE"])(
      "matches '%s'",
      (name) => {
        expect(classifyResource(undefined, name)).toBe("gc");
      },
    );

    it("does not match 'gc' without trailing hyphen", () => {
      // Pattern is /gc-/i — bare "gc" should not match
      expect(classifyResource(undefined, "gc")).toBe("other");
    });
  });

  it("pattern matching is case-insensitive", () => {
    expect(classifyResource(undefined, "Cloud-Node-ABC")).toBe("dpn");
    expect(classifyResource(undefined, "MAINNET-XYZ")).toBe("mainnet");
    expect(classifyResource(undefined, "Jenkins-Master")).toBe("devops");
    expect(classifyResource(undefined, "Staging-API")).toBe("dbg");
    expect(classifyResource(undefined, "GC-Job")).toBe("gc");
  });

  it("returns first category match when name could match multiple patterns", () => {
    // "dpn" is iterated before "dbg", so "dpn-test-server" should match dpn first
    expect(classifyResource(undefined, "dpn-test-server")).toBe("dpn");
  });
});

// ---------------------------------------------------------------------------
// Priority 4 — Default fallback
// ---------------------------------------------------------------------------
describe("classifyResource — default fallback (Priority 4)", () => {
  it("returns 'other' when both tags and name are undefined", () => {
    expect(classifyResource(undefined, undefined)).toBe("other");
  });

  it("returns 'other' when tags are empty and name is undefined", () => {
    expect(classifyResource({}, undefined)).toBe("other");
  });

  it("returns 'other' when tags are undefined and name does not match any pattern", () => {
    expect(classifyResource(undefined, "random-server-42")).toBe("other");
  });

  it("returns 'other' when tags have no recognised keys and name is unmatched", () => {
    expect(
      classifyResource({ env: "production" }, "random-server-42"),
    ).toBe("other");
  });

  it("returns 'other' when tags have recognised keys but invalid values and name is unmatched", () => {
    expect(
      classifyResource({ usage: "billing", purpose: "frontend" }, "web-app"),
    ).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("classifyResource — edge cases", () => {
  it("handles undefined tags gracefully", () => {
    expect(classifyResource(undefined, "cloud-node-1")).toBe("dpn");
  });

  it("handles undefined resourceName gracefully", () => {
    expect(classifyResource(tag("usage", "mainnet"), undefined)).toBe(
      "mainnet",
    );
  });

  it("handles both undefined", () => {
    expect(classifyResource(undefined, undefined)).toBe("other");
  });

  it("handles empty string tag value (not a valid category)", () => {
    expect(classifyResource(tag("usage", ""), undefined)).toBe("other");
  });

  it("handles empty string resourceName (no pattern matches)", () => {
    expect(classifyResource(undefined, "")).toBe("other");
  });

  it("handles whitespace-only tag value", () => {
    expect(classifyResource(tag("usage", "   "), undefined)).toBe("other");
  });

  it("handles tag value with extra whitespace around valid category", () => {
    // The implementation does .toLowerCase() but no .trim(), so " dpn " is not valid
    expect(classifyResource(tag("usage", " dpn "), undefined)).toBe("other");
  });

  it("handles tag value that is a substring of a valid category", () => {
    expect(classifyResource(tag("usage", "dp"), undefined)).toBe("other");
    expect(classifyResource(tag("usage", "main"), undefined)).toBe("other");
  });

  it("multiple tags present — only recognised tag keys are checked", () => {
    const tags = {
      env: "production",
      region: "us-west-2",
      usage: "devops",
      custom: "something",
    };
    expect(classifyResource(tags, undefined)).toBe("devops");
  });

  it("tag with 'other' value returns 'other' immediately (does not fall through to name matching)", () => {
    // "other" is a valid category, so it should be returned by tag matching
    expect(classifyResource(tag("usage", "other"), "cloud-node-1")).toBe(
      "other",
    );
  });

  it("resourceName containing a pattern as a substring still matches", () => {
    // The regex will match "dpn" anywhere in the string
    expect(classifyResource(undefined, "my-super-dpn-server-instance")).toBe(
      "dpn",
    );
  });
});

// ---------------------------------------------------------------------------
// Environment-based custom patterns
// ---------------------------------------------------------------------------
describe("classifyResource — custom patterns via environment variables", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset to clean env before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CATEGORY_PATTERNS_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CATEGORY_PATTERNS_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("overrides DPN patterns when CATEGORY_PATTERNS_DPN is set", () => {
    process.env.CATEGORY_PATTERNS_DPN = "custom-dpn,my-special-node";

    // Custom pattern should match
    expect(classifyResource(undefined, "custom-dpn-server")).toBe("dpn");
    expect(classifyResource(undefined, "my-special-node-01")).toBe("dpn");

    // Default pattern should no longer match (overridden, not merged)
    expect(classifyResource(undefined, "cloud-node-1")).toBe("other");
  });

  it("overrides MAINNET patterns when CATEGORY_PATTERNS_MAINNET is set", () => {
    process.env.CATEGORY_PATTERNS_MAINNET = "my-chain";

    expect(classifyResource(undefined, "my-chain-node")).toBe("mainnet");
    // Default "blockchain" pattern should no longer match
    expect(classifyResource(undefined, "blockchain-explorer")).toBe("other");
  });

  it("overrides DEVOPS patterns when CATEGORY_PATTERNS_DEVOPS is set", () => {
    process.env.CATEGORY_PATTERNS_DEVOPS = "build-server,deploy-agent";

    expect(classifyResource(undefined, "build-server-01")).toBe("devops");
    expect(classifyResource(undefined, "deploy-agent-prod")).toBe("devops");
    // Default "jenkins" pattern should no longer match
    expect(classifyResource(undefined, "jenkins-master")).toBe("other");
  });

  it("overrides DBG patterns when CATEGORY_PATTERNS_DBG is set", () => {
    process.env.CATEGORY_PATTERNS_DBG = "sandbox";

    expect(classifyResource(undefined, "sandbox-instance")).toBe("dbg");
    // Default "staging" pattern should no longer match
    expect(classifyResource(undefined, "staging-api")).toBe("other");
  });

  it("overrides GC patterns when CATEGORY_PATTERNS_GC is set", () => {
    process.env.CATEGORY_PATTERNS_GC = "cleanup,sweep";

    expect(classifyResource(undefined, "cleanup-job")).toBe("gc");
    expect(classifyResource(undefined, "sweep-daemon")).toBe("gc");
    // Default "garbage" pattern should no longer match
    expect(classifyResource(undefined, "garbage-collector")).toBe("other");
  });

  it("custom patterns are case-insensitive", () => {
    process.env.CATEGORY_PATTERNS_DPN = "custom-node";

    expect(classifyResource(undefined, "CUSTOM-NODE-01")).toBe("dpn");
    expect(classifyResource(undefined, "Custom-Node-Prod")).toBe("dpn");
  });

  it("trims whitespace from custom pattern entries", () => {
    process.env.CATEGORY_PATTERNS_DPN = " custom-dpn , my-node ";

    expect(classifyResource(undefined, "custom-dpn-server")).toBe("dpn");
    expect(classifyResource(undefined, "my-node-01")).toBe("dpn");
  });

  it("tags still take priority over custom name patterns", () => {
    process.env.CATEGORY_PATTERNS_DPN = "custom-node";

    expect(
      classifyResource(tag("usage", "mainnet"), "custom-node-01"),
    ).toBe("mainnet");
  });
});

// ---------------------------------------------------------------------------
// UsageCategory type coverage — sanity check
// ---------------------------------------------------------------------------
describe("classifyResource — return type coverage", () => {
  it("can produce every UsageCategory value", () => {
    const results = new Set<UsageCategory>();

    // Tag-based for each
    results.add(classifyResource(tag("usage", "dpn"), undefined));
    results.add(classifyResource(tag("usage", "mainnet"), undefined));
    results.add(classifyResource(tag("usage", "devops"), undefined));
    results.add(classifyResource(tag("usage", "dbg"), undefined));
    results.add(classifyResource(tag("usage", "gc"), undefined));
    results.add(classifyResource(tag("usage", "other"), undefined));

    expect(results).toEqual(
      new Set(["dpn", "mainnet", "devops", "dbg", "gc", "other"]),
    );
  });
});
