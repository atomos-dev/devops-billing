/**
 * Usage category classification service.
 * Determines resource purpose (dpn/mainnet/devops/dbg/gc/other) via:
 * Priority 1: Cloud provider tags
 * Priority 2: Resource name pattern matching
 * Priority 3: Manual assignment (stored in DB)
 * Priority 4: Default to "other"
 */

export type UsageCategory = "dpn" | "mainnet" | "devops" | "dbg" | "gc" | "customer" | "other";

/** Name patterns for automatic classification (configurable via env) */
const DEFAULT_PATTERNS: Record<UsageCategory, RegExp[]> = {
  dpn: [/cloud-node/i, /dpn/i, /deeper-node/i, /vpn-node/i, /^wg-for-/i, /^wireguard-/i, /^stun-/i],
  mainnet: [
    /mainnet/i, /main-net/i, /blockchain/i, /chain-node/i,
    /^addr-backend/i, /^deeper-device-backend$/i, /^deeper-web$/i,
    /^dpr-binding/i, /^sn-server$/i, /^config-server/i, /^license-server/i,
    /^file-server$/i, /^image-server/i, /^my-ip-web/i,
    /^api\.deeper\.network$/i, /^api\.dpr\.deeper\.network$/i,
    /SyncCreditsStack/i, /VotingWeb/i,
  ],
  devops: [
    /devops/i, /ci-cd/i, /jenkins/i, /monitor/i, /grafana/i, /prometheus/i,
    /^jump-server/i, /^ubuntu-ssh-proxy$/i, /^bore-server$/i,
    /^device-proxy/i, /RustDesk/i, /^arm-build/i, /^deeperscan$/i,
    /github-action/i,
  ],
  dbg: [/dbg/i, /debug/i, /staging/i, /testnet/i, /^zhangyong-/i],
  gc: [/^gc-/i, /^gcv/i, /^global-control/i, /^next-gc/i],
  customer: [/^ubuntu-s-\d+vcpu-/i],
  other: [],
};

/**
 * Load custom patterns from environment, falling back to defaults.
 * Format: CATEGORY_PATTERNS_DPN=cloud-node,dpn,vpn-node
 */
function loadPatterns(): Record<UsageCategory, RegExp[]> {
  const patterns = { ...DEFAULT_PATTERNS };
  const categories: UsageCategory[] = ["dpn", "mainnet", "devops", "dbg", "gc", "customer"];

  for (const cat of categories) {
    const envKey = `CATEGORY_PATTERNS_${cat.toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal) {
      patterns[cat] = envVal.split(",").map((p) => new RegExp(p.trim(), "i"));
    }
  }

  return patterns;
}

/**
 * Classify a resource's usage category.
 * @param tags - Cloud provider tags (key-value pairs)
 * @param resourceName - Human-readable resource name
 * @returns The determined usage category
 */
export function classifyResource(
  tags: Record<string, string> | undefined,
  resourceName: string | undefined
): UsageCategory {
  // Priority 1: Check tags for explicit usage/purpose labels
  if (tags) {
    const tagKeys = ["usage", "purpose", "category", "team", "project"];
    for (const key of tagKeys) {
      const value = (tags[key] || "").toLowerCase();
      if (isValidCategory(value)) return value;
    }
  }

  // Priority 2: Name pattern matching
  if (resourceName) {
    const patterns = loadPatterns();
    for (const [category, regexps] of Object.entries(patterns)) {
      if (category === "other") continue;
      for (const re of regexps) {
        if (re.test(resourceName)) return category as UsageCategory;
      }
    }
  }

  // Priority 4: Default
  return "other";
}

function isValidCategory(value: string): value is UsageCategory {
  return ["dpn", "mainnet", "devops", "dbg", "gc", "customer", "other"].includes(value);
}
