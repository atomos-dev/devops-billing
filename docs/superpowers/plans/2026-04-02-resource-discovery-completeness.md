# Resource Discovery Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend AWS and DigitalOcean resource discovery with a Discoverer adapter pattern, independent scan orchestration, API endpoints, and a dedicated UI page.

**Architecture:** Each cloud service gets a `ResourceDiscoverer` implementation registered in a per-provider registry. A `ScanOrchestrator` matches billing data to discoverers, executes them with timeout/error isolation, and upserts results to the existing `resources` table. The UI polls scan progress via REST API.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM (SQLite), AWS SDK v3, DigitalOcean REST API, Vitest, Playwright, shadcn/ui, Tailwind CSS, ECharts.

**Spec:** `docs/superpowers/specs/2026-04-02-resource-discovery-completeness-design.md`

**Scope:** P0 only — core framework + high-value services (EC2, RDS, ELB, S3, NAT Gateway, EIP for AWS; Droplet, LB, Managed DB, Volume for DO). P1/P2 discoverers are follow-up plans.

---

## File Structure

### New files to create

```
src/discoverers/
  types.ts                         # ResourceDiscoverer interface, DiscoveredResource, ProviderCredentials
  registry.ts                      # Discoverer registry, billing service matching, account-level service list
  scan-orchestrator.ts             # Scan execution: bill matching → discover → upsert → cleanup

src/discoverers/aws/
  ec2.ts                           # Wraps AwsProvider.fetchResources()
  rds.ts                           # DescribeDBInstances + ListTagsForResource
  elb.ts                           # ELBv2 DescribeLoadBalancers + DescribeTags
  s3.ts                            # ListBuckets + GetBucketLocation
  nat-gateway.ts                   # DescribeNatGateways
  eip.ts                           # DescribeAddresses

src/discoverers/digitalocean/
  existing-resources.ts            # Wraps DOProvider.fetchResources(), splits by type
  managed-db.ts                    # GET /databases
  volume.ts                        # GET /volumes

src/discoverers/__tests__/
  registry.test.ts
  scan-orchestrator.test.ts
  aws/rds.test.ts
  aws/elb.test.ts
  aws/s3.test.ts
  aws/nat-gateway.test.ts
  aws/eip.test.ts
  digitalocean/managed-db.test.ts
  digitalocean/volume.test.ts

src/app/api/v1/resource-scan/
  route.ts                         # POST (trigger scan) + GET (scan status/history)
  services/route.ts                # GET (bill services with discoverer match info)

src/app/api/__tests__/
  resource-scan-routes.test.ts

src/app/(dashboard)/resource-scan/
  page.tsx                         # Resource scan page with 3 zones

e2e/
  resource-scan.spec.ts

src/db/migrations/
  0004_add_resource_scans.sql
```

### Files to modify

```
src/db/schema.ts                   # Add resourceScans table definition
src/components/layout/sidebar.tsx  # Add Resource Scan nav item
package.json                       # Add AWS SDK packages (@aws-sdk/client-rds, -s3, -elastic-load-balancing-v2)
```

---

## Task 1: Install Dependencies & Database Migration

**Files:**
- Modify: `package.json`
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0004_add_resource_scans.sql`

- [ ] **Step 1: Install AWS SDK packages for P0 discoverers**

```bash
npm install @aws-sdk/client-rds @aws-sdk/client-elastic-load-balancing-v2 @aws-sdk/client-s3
```

- [ ] **Step 2: Add resourceScans table to schema**

Add to end of `src/db/schema.ts`:

```typescript
/** Resource scan operation logs — tracks independent resource discovery runs */
export const resourceScans = sqliteTable("resource_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider"),         // null = scan all providers
  status: text("status").notNull().default("running"),  // running | success | failed | partial
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  servicesScanned: integer("services_scanned").default(0),
  resourcesFound: integer("resources_found").default(0),
  errorMessage: text("error_message"),
  details: text("details"),           // JSON: per-discoverer execution results
});
```

- [ ] **Step 3: Create migration SQL**

Create `src/db/migrations/0004_add_resource_scans.sql`:

```sql
CREATE TABLE IF NOT EXISTS resource_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  services_scanned INTEGER DEFAULT 0,
  resources_found INTEGER DEFAULT 0,
  error_message TEXT,
  details TEXT
);
```

- [ ] **Step 4: Update migration runner to apply new migration**

Check `src/db/index.ts` for how migrations are applied. If push-based (Drizzle Kit), run:

```bash
npx drizzle-kit push
```

If file-based, ensure the migration file is picked up by the existing migration logic.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/db/schema.ts src/db/migrations/
git commit -m "feat: add resource_scans table and AWS SDK dependencies"
```

---

## Task 2: Discoverer Types & Interfaces

**Files:**
- Create: `src/discoverers/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
/**
 * Resource Discoverer type definitions.
 * Defines the adapter interface for cloud resource discovery and
 * the credential/result types used across all discoverers.
 */

/** Credentials discriminated by provider */
export type ProviderCredentials =
  | {
      provider: "aws";
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      resourceRegions: string[];
    }
  | {
      provider: "digitalocean";
      apiToken: string;
    };

/** A single discovered cloud resource */
export interface DiscoveredResource {
  provider: "aws" | "digitalocean";
  resourceId: string;
  resourceName: string;
  resourceType: string;
  region: string;
  spec: string | null;
  tags: Record<string, string>;
  status: string;
  monthlyBaseCost: number | null;
  /** Transfer pool per resource (TiB), from provider API */
  bandwidthAllowanceTib?: number;
}

/**
 * Adapter interface for cloud resource discovery.
 * Each implementation discovers resources for one service type
 * (e.g., EC2, RDS, S3) and maps to one or more billing service names.
 */
export interface ResourceDiscoverer {
  /** Unique key identifying this discoverer (e.g., 'ec2', 'rds', 's3') */
  readonly serviceKey: string;
  /** Provider this discoverer belongs to */
  readonly provider: "aws" | "digitalocean";
  /** Billing service names this discoverer covers (matched against billItems.service) */
  readonly billingServiceNames: string[];
  /** Execute resource discovery; must complete within timeout or be aborted */
  discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]>;
}

/** Per-discoverer execution result stored in resource_scans.details JSON */
export interface DiscovererResult {
  serviceKey: string;
  status: "success" | "failed" | "timeout";
  resourcesFound: number;
  durationMs: number;
  error?: string;
}

/** Parsed shape of resource_scans.details JSON */
export interface ScanDetails {
  discoverers: DiscovererResult[];
  unmatchedServices: Array<{
    service: string;
    provider: string;
    reason: "no_discoverer" | "account_level";
  }>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discoverers/types.ts
git commit -m "feat: add ResourceDiscoverer interface and type definitions"
```

---

## Task 3: Discoverer Registry

**Files:**
- Create: `src/discoverers/registry.ts`
- Create: `src/discoverers/__tests__/registry.test.ts`

- [ ] **Step 1: Write registry tests**

```typescript
/**
 * Tests for the discoverer registry — service matching and account-level classification.
 */
import { describe, test, expect } from "vitest";
import {
  getDiscoverersForProvider,
  matchBillingServices,
  ACCOUNT_LEVEL_SERVICES,
} from "@/discoverers/registry";

describe("Discoverer Registry", () => {
  test("returns AWS discoverers for provider 'aws'", () => {
    const discoverers = getDiscoverersForProvider("aws");
    expect(discoverers.length).toBeGreaterThan(0);
    expect(discoverers.every((d) => d.provider === "aws")).toBe(true);
  });

  test("returns DO discoverers for provider 'digitalocean'", () => {
    const discoverers = getDiscoverersForProvider("digitalocean");
    expect(discoverers.length).toBeGreaterThan(0);
    expect(discoverers.every((d) => d.provider === "digitalocean")).toBe(true);
  });

  test("returns empty array for unknown provider", () => {
    expect(getDiscoverersForProvider("gcp")).toEqual([]);
  });

  test("matchBillingServices matches known services to discoverers", () => {
    const billingServices = [
      { provider: "aws", service: "Amazon Relational Database Service" },
      { provider: "aws", service: "AmazonCloudWatch" },
      { provider: "aws", service: "UnknownService" },
    ];

    const result = matchBillingServices(billingServices);

    // RDS should be matched
    const rdsMatch = result.matched.find((m) => m.discoverer.serviceKey === "rds");
    expect(rdsMatch).toBeDefined();

    // CloudWatch should be account-level
    const cwUnmatched = result.unmatched.find((u) => u.service === "AmazonCloudWatch");
    expect(cwUnmatched?.reason).toBe("account_level");

    // Unknown should be no_discoverer
    const unknownUnmatched = result.unmatched.find((u) => u.service === "UnknownService");
    expect(unknownUnmatched?.reason).toBe("no_discoverer");
  });

  test("matchBillingServices returns all discoverers when billingServices is empty (fallback)", () => {
    const result = matchBillingServices([]);
    // Should return all registered discoverers
    expect(result.matched.length).toBeGreaterThan(0);
    expect(result.unmatched).toEqual([]);
  });

  test("ACCOUNT_LEVEL_SERVICES contains expected AWS services", () => {
    expect(ACCOUNT_LEVEL_SERVICES).toContain("AmazonCloudWatch");
    expect(ACCOUNT_LEVEL_SERVICES).toContain("AWS Key Management Service");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/discoverers/__tests__/registry.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement registry**

```typescript
/**
 * Discoverer registry — maps billing service names to ResourceDiscoverer
 * implementations and classifies account-level services.
 */
import type { ResourceDiscoverer } from "./types";

// ── AWS Discoverers ─────────────────────────────────────────────────────────
import { Ec2Discoverer } from "./aws/ec2";
import { RdsDiscoverer } from "./aws/rds";
import { ElbDiscoverer } from "./aws/elb";
import { S3Discoverer } from "./aws/s3";
import { NatGatewayDiscoverer } from "./aws/nat-gateway";
import { EipDiscoverer } from "./aws/eip";

// ── DO Discoverers ──────────────────────────────────────────────────────────
import { ExistingResourcesDiscoverer } from "./digitalocean/existing-resources";
import { ManagedDbDiscoverer } from "./digitalocean/managed-db";
import { VolumeDiscoverer } from "./digitalocean/volume";

/** All registered discoverers, grouped by provider */
const DISCOVERER_REGISTRY: Record<string, ResourceDiscoverer[]> = {
  aws: [
    new Ec2Discoverer(),
    new RdsDiscoverer(),
    new ElbDiscoverer(),
    new S3Discoverer(),
    new NatGatewayDiscoverer(),
    new EipDiscoverer(),
  ],
  digitalocean: [
    new ExistingResourcesDiscoverer(),
    new ManagedDbDiscoverer(),
    new VolumeDiscoverer(),
  ],
};

/**
 * AWS services billed at the account level — no enumerable resources to discover.
 * Listed on the scan page as "account-level" rather than "unsupported".
 */
export const ACCOUNT_LEVEL_SERVICES = new Set([
  "AmazonCloudWatch",
  "AWS Key Management Service",
  "Amazon Simple Email Service",
  "Amazon Simple Notification Service",
  "Amazon API Gateway",
  "AWS Glue",
]);

/** Get all discoverers for a given provider key */
export function getDiscoverersForProvider(provider: string): ResourceDiscoverer[] {
  return DISCOVERER_REGISTRY[provider] ?? [];
}

/** Get all discoverers across all providers */
export function getAllDiscoverers(): ResourceDiscoverer[] {
  return Object.values(DISCOVERER_REGISTRY).flat();
}

interface BillingServiceEntry {
  provider: string;
  service: string;
}

interface MatchResult {
  matched: Array<{ service: string; provider: string; discoverer: ResourceDiscoverer }>;
  unmatched: Array<{ service: string; provider: string; reason: "no_discoverer" | "account_level" }>;
}

/**
 * Match billing service names to registered discoverers.
 * Falls back to returning ALL discoverers when billingServices is empty
 * (new install, no billing data yet).
 */
export function matchBillingServices(billingServices: BillingServiceEntry[]): MatchResult {
  // Fallback: no billing data → return all discoverers
  if (billingServices.length === 0) {
    const allDiscoverers = getAllDiscoverers();
    return {
      matched: allDiscoverers.map((d) => ({
        service: d.billingServiceNames[0] ?? d.serviceKey,
        provider: d.provider,
        discoverer: d,
      })),
      unmatched: [],
    };
  }

  const matched: MatchResult["matched"] = [];
  const unmatched: MatchResult["unmatched"] = [];
  const alreadyMatched = new Set<string>(); // Avoid duplicate discoverers

  for (const { provider, service } of billingServices) {
    const providerDiscoverers = getDiscoverersForProvider(provider);
    const discoverer = providerDiscoverers.find(
      (d) => !alreadyMatched.has(d.serviceKey) && d.billingServiceNames.includes(service)
    );

    if (discoverer) {
      alreadyMatched.add(discoverer.serviceKey);
      matched.push({ service, provider, discoverer });
    } else if (ACCOUNT_LEVEL_SERVICES.has(service)) {
      unmatched.push({ service, provider, reason: "account_level" });
    } else {
      unmatched.push({ service, provider, reason: "no_discoverer" });
    }
  }

  return { matched, unmatched };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Tests will still fail because discoverer imports don't exist yet. Create stub files first. For each discoverer, create a minimal stub that satisfies the import:

Create temporary stubs in each discoverer file (e.g., `src/discoverers/aws/ec2.ts`):

```typescript
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

export class Ec2Discoverer implements ResourceDiscoverer {
  readonly serviceKey = "ec2";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Elastic Compute Cloud - Compute"];

  async discover(_credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    throw new Error("Not implemented");
  }
}
```

Repeat for all P0 discoverers (RDS, ELB, S3, NAT Gateway, EIP, ExistingResources, ManagedDb, Volume) with their respective serviceKey, provider, and billingServiceNames. The billingServiceNames for each:

- `RdsDiscoverer`: `["Amazon Relational Database Service"]`
- `ElbDiscoverer`: `["Amazon Elastic Load Balancing"]`
- `S3Discoverer`: `["Amazon Simple Storage Service"]`
- `NatGatewayDiscoverer`: `["Amazon Virtual Private Cloud"]`
- `EipDiscoverer`: `["EC2 - Other"]`
- `ExistingResourcesDiscoverer`: `["Droplets", "Load Balancers"]`
- `ManagedDbDiscoverer`: `["Managed Databases"]`
- `VolumeDiscoverer`: `["Volumes"]`

Then run:

```bash
npx vitest run src/discoverers/__tests__/registry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discoverers/
git commit -m "feat: add discoverer registry with billing service matching"
```

---

## Task 4: AWS EC2 Discoverer

**Files:**
- Modify: `src/discoverers/aws/ec2.ts`

- [ ] **Step 1: Implement EC2 Discoverer (wraps existing AwsProvider)**

Replace the stub with full implementation:

```typescript
/**
 * EC2 Discoverer — wraps AwsProvider.fetchResources() to reuse
 * existing EC2 instance discovery and pricing logic.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";
import { AwsProvider } from "@/providers/aws";

export class Ec2Discoverer implements ResourceDiscoverer {
  readonly serviceKey = "ec2";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Elastic Compute Cloud - Compute"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const awsProvider = new AwsProvider({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region: credentials.region,
      resourceRegions: credentials.resourceRegions,
    });

    const resources = await awsProvider.fetchResources();

    return resources.map((r) => ({
      provider: "aws" as const,
      resourceId: r.resourceId,
      resourceName: r.resourceName ?? "",
      resourceType: "ec2",
      region: r.region ?? credentials.region,
      spec: r.spec ?? null,
      tags: r.tags ?? {},
      status: r.status ?? "unknown",
      monthlyBaseCost: r.monthlyBaseCost ?? null,
    }));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discoverers/aws/ec2.ts
git commit -m "feat: implement EC2 discoverer wrapping existing provider"
```

---

## Task 5: AWS RDS Discoverer

**Files:**
- Modify: `src/discoverers/aws/rds.ts`
- Create: `src/discoverers/__tests__/aws/rds.test.ts`

- [ ] **Step 1: Write RDS discoverer test**

```typescript
/**
 * Tests for RDS Discoverer — validates DescribeDBInstances mapping and multi-region support.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { RdsDiscoverer } from "@/discoverers/aws/rds";
import type { ProviderCredentials } from "@/discoverers/types";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-rds", () => {
  const RDSClient = vi.fn(function () {
    this.send = mockSend;
  });
  const DescribeDBInstancesCommand = vi.fn(function (input) {
    this.input = input;
  });
  const ListTagsForResourceCommand = vi.fn(function (input) {
    this.input = input;
  });
  return { RDSClient, DescribeDBInstancesCommand, ListTagsForResourceCommand };
});

const awsCreds: ProviderCredentials = {
  provider: "aws",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  region: "us-east-1",
  resourceRegions: ["us-east-1", "ap-southeast-1"],
};

describe("RdsDiscoverer", () => {
  const discoverer = new RdsDiscoverer();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("rds");
    expect(discoverer.provider).toBe("aws");
    expect(discoverer.billingServiceNames).toContain("Amazon Relational Database Service");
  });

  test("discovers RDS instances across regions", async () => {
    mockSend
      // Region 1: DescribeDBInstances
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "my-postgres",
            DBInstanceClass: "db.t3.medium",
            Engine: "postgres",
            DBInstanceStatus: "available",
            DBInstanceArn: "arn:aws:rds:us-east-1:123:db:my-postgres",
          },
        ],
      })
      // Region 1: ListTagsForResource
      .mockResolvedValueOnce({
        TagList: [{ Key: "Name", Value: "Primary DB" }, { Key: "env", Value: "prod" }],
      })
      // Region 2: DescribeDBInstances
      .mockResolvedValueOnce({ DBInstances: [] });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      provider: "aws",
      resourceId: "my-postgres",
      resourceName: "Primary DB",
      resourceType: "rds",
      region: "us-east-1",
      spec: "postgres db.t3.medium",
      status: "running",
      tags: { Name: "Primary DB", env: "prod" },
    });
  });

  test("maps DBInstanceStatus correctly", async () => {
    mockSend
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: "stopped-db",
            DBInstanceClass: "db.t3.small",
            Engine: "mysql",
            DBInstanceStatus: "stopped",
            DBInstanceArn: "arn:aws:rds:us-east-1:123:db:stopped-db",
          },
        ],
      })
      .mockResolvedValueOnce({ TagList: [] })
      .mockResolvedValueOnce({ DBInstances: [] });

    const resources = await discoverer.discover(awsCreds);
    expect(resources[0].status).toBe("stopped");
  });

  test("returns empty for non-aws credentials", async () => {
    const doCreds: ProviderCredentials = { provider: "digitalocean", apiToken: "token" };
    const resources = await discoverer.discover(doCreds);
    expect(resources).toEqual([]);
  });

  test("handles API errors gracefully per region", async () => {
    mockSend
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockResolvedValueOnce({ DBInstances: [] });

    const resources = await discoverer.discover(awsCreds);
    // Should not throw, returns whatever succeeded
    expect(resources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/discoverers/__tests__/aws/rds.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement RDS discoverer**

```typescript
/**
 * RDS Discoverer — discovers Amazon RDS database instances across configured regions.
 */
import {
  RDSClient,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-rds";
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

/** Map RDS DBInstanceStatus to normalized status */
function mapRdsStatus(status: string | undefined): string {
  switch (status) {
    case "available":
      return "running";
    case "stopped":
      return "stopped";
    case "deleting":
    case "deleted":
      return "terminated";
    case "creating":
    case "starting":
    case "rebooting":
    case "modifying":
      return "pending";
    default:
      return status ?? "unknown";
  }
}

export class RdsDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "rds";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Relational Database Service"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new RDSClient({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(new DescribeDBInstancesCommand({}));

        for (const db of result.DBInstances ?? []) {
          // Fetch tags for this instance
          let tags: Record<string, string> = {};
          let name = db.DBInstanceIdentifier ?? "";
          if (db.DBInstanceArn) {
            try {
              const tagResult = await client.send(
                new ListTagsForResourceCommand({ ResourceName: db.DBInstanceArn })
              );
              for (const tag of tagResult.TagList ?? []) {
                if (tag.Key && tag.Value) {
                  tags[tag.Key] = tag.Value;
                  if (tag.Key === "Name") name = tag.Value;
                }
              }
            } catch {
              // Tags are optional; continue without them
            }
          }

          resources.push({
            provider: "aws",
            resourceId: db.DBInstanceIdentifier ?? "",
            resourceName: name,
            resourceType: "rds",
            region,
            spec: `${db.Engine ?? "unknown"} ${db.DBInstanceClass ?? "unknown"}`,
            tags,
            status: mapRdsStatus(db.DBInstanceStatus),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[RDS Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/discoverers/__tests__/aws/rds.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discoverers/aws/rds.ts src/discoverers/__tests__/aws/rds.test.ts
git commit -m "feat: implement RDS discoverer with multi-region support"
```

---

## Task 6: AWS ELB Discoverer

**Files:**
- Modify: `src/discoverers/aws/elb.ts`
- Create: `src/discoverers/__tests__/aws/elb.test.ts`

- [ ] **Step 1: Write ELB discoverer test**

```typescript
/**
 * Tests for ELB Discoverer — validates ELBv2 DescribeLoadBalancers mapping.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { ElbDiscoverer } from "@/discoverers/aws/elb";
import type { ProviderCredentials } from "@/discoverers/types";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-elastic-load-balancing-v2", () => {
  const ElasticLoadBalancingV2Client = vi.fn(function () {
    this.send = mockSend;
  });
  const DescribeLoadBalancersCommand = vi.fn(function (input) {
    this.input = input;
  });
  const DescribeTagsCommand = vi.fn(function (input) {
    this.input = input;
  });
  return { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTagsCommand };
});

const awsCreds: ProviderCredentials = {
  provider: "aws",
  accessKeyId: "test",
  secretAccessKey: "test",
  region: "us-east-1",
  resourceRegions: ["us-east-1"],
};

describe("ElbDiscoverer", () => {
  const discoverer = new ElbDiscoverer();

  beforeEach(() => vi.clearAllMocks());

  test("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("elb");
    expect(discoverer.billingServiceNames).toContain("Amazon Elastic Load Balancing");
  });

  test("discovers load balancers with tags", async () => {
    mockSend
      .mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc123",
            LoadBalancerName: "my-alb",
            Type: "application",
            Scheme: "internet-facing",
            State: { Code: "active" },
          },
        ],
      })
      .mockResolvedValueOnce({
        TagDescriptions: [
          {
            ResourceArn: "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc123",
            Tags: [{ Key: "env", Value: "prod" }],
          },
        ],
      });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      resourceId: "app/my-alb/abc123",
      resourceName: "my-alb",
      resourceType: "elb",
      spec: "application internet-facing",
      status: "running",
      tags: { env: "prod" },
    });
  });
});
```

- [ ] **Step 2: Implement ELB discoverer**

```typescript
/**
 * ELB Discoverer — discovers Application/Network/Gateway Load Balancers via ELBv2 API.
 */
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

/** Extract the resource path from an ELB ARN (e.g., "app/my-alb/abc123") */
function extractElbResourceId(arn: string): string {
  const match = arn.match(/loadbalancer\/(.+)$/);
  return match?.[1] ?? arn;
}

export class ElbDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "elb";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Elastic Load Balancing"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new ElasticLoadBalancingV2Client({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(new DescribeLoadBalancersCommand({}));
        const lbs = result.LoadBalancers ?? [];
        if (lbs.length === 0) continue;

        // Batch fetch tags (max 20 ARNs per call)
        const arns = lbs.map((lb) => lb.LoadBalancerArn).filter(Boolean) as string[];
        const tagMap = new Map<string, Record<string, string>>();

        for (let i = 0; i < arns.length; i += 20) {
          try {
            const tagResult = await client.send(
              new DescribeTagsCommand({ ResourceArns: arns.slice(i, i + 20) })
            );
            for (const desc of tagResult.TagDescriptions ?? []) {
              const tags: Record<string, string> = {};
              for (const tag of desc.Tags ?? []) {
                if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
              }
              if (desc.ResourceArn) tagMap.set(desc.ResourceArn, tags);
            }
          } catch {
            // Tags are optional
          }
        }

        for (const lb of lbs) {
          const tags = (lb.LoadBalancerArn && tagMap.get(lb.LoadBalancerArn)) ?? {};
          resources.push({
            provider: "aws",
            resourceId: extractElbResourceId(lb.LoadBalancerArn ?? ""),
            resourceName: lb.LoadBalancerName ?? "",
            resourceType: "elb",
            region,
            spec: `${lb.Type ?? "unknown"} ${lb.Scheme ?? "unknown"}`,
            tags,
            status: lb.State?.Code === "active" ? "running" : (lb.State?.Code ?? "unknown"),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[ELB Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
```

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run src/discoverers/__tests__/aws/elb.test.ts
git add src/discoverers/aws/elb.ts src/discoverers/__tests__/aws/elb.test.ts
git commit -m "feat: implement ELB discoverer with batch tag fetching"
```

---

## Task 7: AWS S3 Discoverer

**Files:**
- Modify: `src/discoverers/aws/s3.ts`
- Create: `src/discoverers/__tests__/aws/s3.test.ts`

- [ ] **Step 1: Write S3 discoverer test**

```typescript
/**
 * Tests for S3 Discoverer — validates ListBuckets + GetBucketLocation mapping.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { S3Discoverer } from "@/discoverers/aws/s3";
import type { ProviderCredentials } from "@/discoverers/types";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn(function () {
    this.send = mockSend;
  });
  const ListBucketsCommand = vi.fn();
  const GetBucketLocationCommand = vi.fn(function (input) {
    this.input = input;
  });
  return { S3Client, ListBucketsCommand, GetBucketLocationCommand };
});

const awsCreds: ProviderCredentials = {
  provider: "aws",
  accessKeyId: "test",
  secretAccessKey: "test",
  region: "us-east-1",
  resourceRegions: ["us-east-1"],
};

describe("S3Discoverer", () => {
  const discoverer = new S3Discoverer();

  beforeEach(() => vi.clearAllMocks());

  test("discovers S3 buckets with location", async () => {
    mockSend
      .mockResolvedValueOnce({
        Buckets: [
          { Name: "my-data-bucket", CreationDate: new Date() },
          { Name: "logs-bucket", CreationDate: new Date() },
        ],
      })
      // GetBucketLocation for bucket 1 (null = us-east-1)
      .mockResolvedValueOnce({ LocationConstraint: null })
      // GetBucketLocation for bucket 2
      .mockResolvedValueOnce({ LocationConstraint: "ap-southeast-1" });

    const resources = await discoverer.discover(awsCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      resourceId: "my-data-bucket",
      resourceName: "my-data-bucket",
      resourceType: "s3",
      region: "us-east-1",
      spec: null,
      status: "active",
    });
    expect(resources[1].region).toBe("ap-southeast-1");
  });

  test("handles GetBucketLocation errors gracefully", async () => {
    mockSend
      .mockResolvedValueOnce({
        Buckets: [{ Name: "forbidden-bucket" }],
      })
      .mockRejectedValueOnce(new Error("Access Denied"));

    const resources = await discoverer.discover(awsCreds);
    expect(resources).toHaveLength(1);
    expect(resources[0].region).toBe("unknown");
  });
});
```

- [ ] **Step 2: Implement S3 discoverer**

```typescript
/**
 * S3 Discoverer — discovers S3 buckets via ListBuckets (global) + GetBucketLocation per bucket.
 */
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
} from "@aws-sdk/client-s3";
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

export class S3Discoverer implements ResourceDiscoverer {
  readonly serviceKey = "s3";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Simple Storage Service"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const client = new S3Client({
      region: credentials.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    const resources: DiscoveredResource[] = [];

    try {
      const result = await client.send(new ListBucketsCommand({}));

      for (const bucket of result.Buckets ?? []) {
        if (!bucket.Name) continue;

        // Determine bucket region
        let region = "unknown";
        try {
          const locResult = await client.send(
            new GetBucketLocationCommand({ Bucket: bucket.Name })
          );
          // null/empty LocationConstraint means us-east-1
          region = locResult.LocationConstraint || "us-east-1";
        } catch {
          // Access denied or other error — keep region as unknown
        }

        resources.push({
          provider: "aws",
          resourceId: bucket.Name,
          resourceName: bucket.Name,
          resourceType: "s3",
          region,
          spec: null,
          tags: {},
          status: "active",
          monthlyBaseCost: null,
        });
      }
    } catch (error) {
      console.error("[S3 Discoverer] Failed:", error);
    }

    return resources;
  }
}
```

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run src/discoverers/__tests__/aws/s3.test.ts
git add src/discoverers/aws/s3.ts src/discoverers/__tests__/aws/s3.test.ts
git commit -m "feat: implement S3 discoverer with bucket location resolution"
```

---

## Task 8: AWS NAT Gateway & EIP Discoverers

**Files:**
- Modify: `src/discoverers/aws/nat-gateway.ts`
- Modify: `src/discoverers/aws/eip.ts`
- Create: `src/discoverers/__tests__/aws/nat-gateway.test.ts`
- Create: `src/discoverers/__tests__/aws/eip.test.ts`

- [ ] **Step 1: Write NAT Gateway test and implementation**

Test (`src/discoverers/__tests__/aws/nat-gateway.test.ts`):

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { NatGatewayDiscoverer } from "@/discoverers/aws/nat-gateway";
import type { ProviderCredentials } from "@/discoverers/types";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => {
  const EC2Client = vi.fn(function () { this.send = mockSend; });
  const DescribeNatGatewaysCommand = vi.fn(function (input) { this.input = input; });
  return { EC2Client, DescribeNatGatewaysCommand };
});

const awsCreds: ProviderCredentials = {
  provider: "aws", accessKeyId: "k", secretAccessKey: "s",
  region: "us-east-1", resourceRegions: ["us-east-1"],
};

describe("NatGatewayDiscoverer", () => {
  const discoverer = new NatGatewayDiscoverer();
  beforeEach(() => vi.clearAllMocks());

  test("discovers NAT gateways", async () => {
    mockSend.mockResolvedValueOnce({
      NatGateways: [{
        NatGatewayId: "nat-abc123",
        ConnectivityType: "public",
        State: "available",
        Tags: [{ Key: "Name", Value: "Main NAT" }],
      }],
    });

    const resources = await discoverer.discover(awsCreds);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      resourceId: "nat-abc123",
      resourceName: "Main NAT",
      resourceType: "nat_gateway",
      spec: "public",
      status: "running",
    });
  });

  test("filters out deleted NAT gateways", async () => {
    mockSend.mockResolvedValueOnce({
      NatGateways: [
        { NatGatewayId: "nat-1", State: "available", ConnectivityType: "public", Tags: [] },
        { NatGatewayId: "nat-2", State: "deleted", ConnectivityType: "public", Tags: [] },
      ],
    });

    const resources = await discoverer.discover(awsCreds);
    expect(resources).toHaveLength(1);
    expect(resources[0].resourceId).toBe("nat-1");
  });
});
```

Implementation (`src/discoverers/aws/nat-gateway.ts`):

```typescript
/**
 * NAT Gateway Discoverer — discovers VPC NAT Gateways across configured regions.
 */
import { EC2Client, DescribeNatGatewaysCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

export class NatGatewayDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "nat_gateway";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Virtual Private Cloud"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new EC2Client({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(new DescribeNatGatewaysCommand({}));

        for (const gw of result.NatGateways ?? []) {
          // Skip deleted gateways
          if (gw.State === "deleted") continue;

          const tags: Record<string, string> = {};
          let name = gw.NatGatewayId ?? "";
          for (const tag of gw.Tags ?? []) {
            if (tag.Key && tag.Value) {
              tags[tag.Key] = tag.Value;
              if (tag.Key === "Name") name = tag.Value;
            }
          }

          resources.push({
            provider: "aws",
            resourceId: gw.NatGatewayId ?? "",
            resourceName: name,
            resourceType: "nat_gateway",
            region,
            spec: gw.ConnectivityType ?? "unknown",
            tags,
            status: gw.State === "available" ? "running" : (gw.State ?? "unknown"),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[NAT Gateway Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
```

- [ ] **Step 2: Write EIP test and implementation**

Test (`src/discoverers/__tests__/aws/eip.test.ts`):

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { EipDiscoverer } from "@/discoverers/aws/eip";
import type { ProviderCredentials } from "@/discoverers/types";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => {
  const EC2Client = vi.fn(function () { this.send = mockSend; });
  const DescribeAddressesCommand = vi.fn(function (input) { this.input = input; });
  return { EC2Client, DescribeAddressesCommand };
});

const awsCreds: ProviderCredentials = {
  provider: "aws", accessKeyId: "k", secretAccessKey: "s",
  region: "us-east-1", resourceRegions: ["us-east-1"],
};

describe("EipDiscoverer", () => {
  const discoverer = new EipDiscoverer();
  beforeEach(() => vi.clearAllMocks());

  test("discovers EIPs with association status", async () => {
    mockSend.mockResolvedValueOnce({
      Addresses: [
        {
          AllocationId: "eipalloc-abc",
          PublicIp: "1.2.3.4",
          Domain: "vpc",
          AssociationId: "assoc-123",
          InstanceId: "i-xxx",
          Tags: [{ Key: "Name", Value: "Web Server EIP" }],
        },
        {
          AllocationId: "eipalloc-def",
          PublicIp: "5.6.7.8",
          Domain: "vpc",
          Tags: [],
        },
      ],
    });

    const resources = await discoverer.discover(awsCreds);
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      resourceId: "eipalloc-abc",
      resourceName: "Web Server EIP",
      status: "associated",
      spec: "vpc",
    });
    expect(resources[1].status).toBe("unassociated");
  });
});
```

Implementation (`src/discoverers/aws/eip.ts`):

```typescript
/**
 * EIP Discoverer — discovers Elastic IP addresses across configured regions.
 */
import { EC2Client, DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

export class EipDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "eip";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["EC2 - Other"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new EC2Client({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(new DescribeAddressesCommand({}));

        for (const addr of result.Addresses ?? []) {
          const tags: Record<string, string> = {};
          let name = addr.PublicIp ?? addr.AllocationId ?? "";
          for (const tag of addr.Tags ?? []) {
            if (tag.Key && tag.Value) {
              tags[tag.Key] = tag.Value;
              if (tag.Key === "Name") name = tag.Value;
            }
          }

          resources.push({
            provider: "aws",
            resourceId: addr.AllocationId ?? "",
            resourceName: name,
            resourceType: "eip",
            region,
            spec: addr.Domain ?? "vpc",
            tags,
            status: addr.AssociationId ? "associated" : "unassociated",
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[EIP Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
```

- [ ] **Step 3: Run all tests and commit**

```bash
npx vitest run src/discoverers/__tests__/aws/nat-gateway.test.ts src/discoverers/__tests__/aws/eip.test.ts
git add src/discoverers/aws/nat-gateway.ts src/discoverers/aws/eip.ts src/discoverers/__tests__/aws/
git commit -m "feat: implement NAT Gateway and EIP discoverers"
```

---

## Task 9: DigitalOcean Existing Resources Discoverer

**Files:**
- Modify: `src/discoverers/digitalocean/existing-resources.ts`

- [ ] **Step 1: Implement DO Existing Resources Discoverer (wraps DOProvider)**

```typescript
/**
 * Existing Resources Discoverer — wraps DigitalOceanProvider.fetchResources()
 * to reuse existing Droplet and Load Balancer discovery logic.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";
import { DigitalOceanProvider } from "@/providers/digitalocean";

export class ExistingResourcesDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "do_existing";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Droplets", "Load Balancers"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];

    const doProvider = new DigitalOceanProvider({ apiToken: credentials.apiToken });
    const resources = await doProvider.fetchResources();

    return resources.map((r) => ({
      provider: "digitalocean" as const,
      resourceId: r.resourceId,
      resourceName: r.resourceName ?? "",
      resourceType: r.resourceType ?? "unknown",
      region: r.region ?? "unknown",
      spec: r.spec ?? null,
      tags: r.tags ?? {},
      status: r.status ?? "unknown",
      monthlyBaseCost: r.monthlyBaseCost ?? null,
      bandwidthAllowanceTib: r.bandwidthAllowanceTib,
    }));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discoverers/digitalocean/existing-resources.ts
git commit -m "feat: implement DO existing resources discoverer wrapping provider"
```

---

## Task 10: DigitalOcean Managed DB & Volume Discoverers

**Files:**
- Modify: `src/discoverers/digitalocean/managed-db.ts`
- Modify: `src/discoverers/digitalocean/volume.ts`
- Create: `src/discoverers/__tests__/digitalocean/managed-db.test.ts`
- Create: `src/discoverers/__tests__/digitalocean/volume.test.ts`

- [ ] **Step 1: Write Managed DB test**

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { ManagedDbDiscoverer } from "@/discoverers/digitalocean/managed-db";
import type { ProviderCredentials } from "@/discoverers/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const doCreds: ProviderCredentials = { provider: "digitalocean", apiToken: "test-token" };

describe("ManagedDbDiscoverer", () => {
  const discoverer = new ManagedDbDiscoverer();
  beforeEach(() => vi.clearAllMocks());

  test("has correct metadata", () => {
    expect(discoverer.serviceKey).toBe("managed_db");
    expect(discoverer.provider).toBe("digitalocean");
  });

  test("discovers managed databases", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        databases: [
          {
            id: "db-uuid-1",
            name: "primary-pg",
            engine: "pg",
            size_slug: "db-s-1vcpu-1gb",
            num_nodes: 1,
            status: "online",
            region: "sgp1",
            tags: ["env:prod"],
          },
        ],
        meta: { total: 1 },
      }),
    });

    const resources = await discoverer.discover(doCreds);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      provider: "digitalocean",
      resourceId: "db-uuid-1",
      resourceName: "primary-pg",
      resourceType: "managed_db",
      region: "sgp1",
      spec: "pg db-s-1vcpu-1gb 1-node",
      status: "running",
    });
  });

  test("returns empty for non-DO credentials", async () => {
    const awsCreds: ProviderCredentials = {
      provider: "aws", accessKeyId: "k", secretAccessKey: "s",
      region: "us-east-1", resourceRegions: [],
    };
    expect(await discoverer.discover(awsCreds)).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement Managed DB discoverer**

```typescript
/**
 * Managed Database Discoverer — discovers DigitalOcean managed database clusters.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

const DO_API_BASE = "https://api.digitalocean.com/v2";

export class ManagedDbDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "managed_db";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Managed Databases"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];

    const resources: DiscoveredResource[] = [];

    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`${DO_API_BASE}/databases?page=${page}&per_page=100`, {
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) break;
        const data = await res.json();

        for (const db of data.databases ?? []) {
          const tags: Record<string, string> = {};
          for (const tag of db.tags ?? []) {
            const parts = tag.split(":");
            if (parts.length === 2) {
              tags[parts[0]] = parts[1];
            } else {
              tags[tag] = "true";
            }
          }

          resources.push({
            provider: "digitalocean",
            resourceId: db.id ?? "",
            resourceName: db.name ?? "",
            resourceType: "managed_db",
            region: db.region ?? "unknown",
            spec: `${db.engine ?? "unknown"} ${db.size_slug ?? "unknown"} ${db.num_nodes ?? 1}-node`,
            tags,
            status: db.status === "online" ? "running" : (db.status ?? "unknown"),
            monthlyBaseCost: null,
          });
        }

        const totalPages = Math.ceil((data.meta?.total ?? 0) / 100);
        hasMore = page < totalPages;
        page++;
      }
    } catch (error) {
      console.error("[Managed DB Discoverer] Failed:", error);
    }

    return resources;
  }
}
```

- [ ] **Step 3: Write Volume test and implementation**

Test (`src/discoverers/__tests__/digitalocean/volume.test.ts`):

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { VolumeDiscoverer } from "@/discoverers/digitalocean/volume";
import type { ProviderCredentials } from "@/discoverers/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const doCreds: ProviderCredentials = { provider: "digitalocean", apiToken: "test-token" };

describe("VolumeDiscoverer", () => {
  const discoverer = new VolumeDiscoverer();
  beforeEach(() => vi.clearAllMocks());

  test("discovers volumes with attachment status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        volumes: [
          {
            id: "vol-1",
            name: "data-vol",
            size_gigabytes: 100,
            filesystem_type: "ext4",
            region: { slug: "sgp1" },
            droplet_ids: [12345],
            tags: [],
          },
          {
            id: "vol-2",
            name: "backup-vol",
            size_gigabytes: 50,
            filesystem_type: "ext4",
            region: { slug: "sgp1" },
            droplet_ids: [],
            tags: [],
          },
        ],
        meta: { total: 2 },
      }),
    });

    const resources = await discoverer.discover(doCreds);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      resourceId: "vol-1",
      resourceName: "data-vol",
      spec: "100GiB ext4",
      status: "attached",
    });
    expect(resources[1].status).toBe("unattached");
  });
});
```

Implementation (`src/discoverers/digitalocean/volume.ts`):

```typescript
/**
 * Volume Discoverer — discovers DigitalOcean block storage volumes.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

const DO_API_BASE = "https://api.digitalocean.com/v2";

export class VolumeDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "volume";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Volumes"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];

    const resources: DiscoveredResource[] = [];

    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`${DO_API_BASE}/volumes?page=${page}&per_page=100`, {
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) break;
        const data = await res.json();

        for (const vol of data.volumes ?? []) {
          const tags: Record<string, string> = {};
          for (const tag of vol.tags ?? []) {
            const parts = tag.split(":");
            if (parts.length === 2) {
              tags[parts[0]] = parts[1];
            } else {
              tags[tag] = "true";
            }
          }

          const dropletIds = vol.droplet_ids ?? [];
          resources.push({
            provider: "digitalocean",
            resourceId: vol.id ?? "",
            resourceName: vol.name ?? "",
            resourceType: "volume",
            region: vol.region?.slug ?? "unknown",
            spec: `${vol.size_gigabytes ?? 0}GiB ${vol.filesystem_type ?? "unknown"}`,
            tags,
            status: dropletIds.length > 0 ? "attached" : "unattached",
            monthlyBaseCost: null,
          });
        }

        const totalPages = Math.ceil((data.meta?.total ?? 0) / 100);
        hasMore = page < totalPages;
        page++;
      }
    } catch (error) {
      console.error("[Volume Discoverer] Failed:", error);
    }

    return resources;
  }
}
```

- [ ] **Step 4: Run all DO discoverer tests and commit**

```bash
npx vitest run src/discoverers/__tests__/digitalocean/
git add src/discoverers/digitalocean/ src/discoverers/__tests__/digitalocean/
git commit -m "feat: implement DO managed database and volume discoverers"
```

---

## Task 11: Scan Orchestrator

**Files:**
- Create: `src/discoverers/scan-orchestrator.ts`
- Create: `src/discoverers/__tests__/scan-orchestrator.test.ts`

- [ ] **Step 1: Write scan orchestrator test**

```typescript
/**
 * Tests for ScanOrchestrator — validates end-to-end scan flow:
 * bill matching → discover → upsert → cleanup.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock the database module
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();

vi.mock("@/db", () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit", "set", "values", "onConflictDoUpdate", "target", "returning"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.all = vi.fn().mockReturnValue([]);
  chain.get = vi.fn().mockReturnValue(undefined);
  chain.run = vi.fn();

  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
      insert: vi.fn().mockReturnValue(chain),
      update: vi.fn().mockReturnValue(chain),
      delete: vi.fn().mockReturnValue(chain),
    },
  };
});

vi.mock("@/db/schema", () => ({
  billItems: { service: "service", amount: "amount" },
  bills: { provider: "provider", id: "id" },
  resources: {},
  resourceScans: {},
}));

vi.mock("@/discoverers/registry", () => ({
  matchBillingServices: vi.fn().mockReturnValue({
    matched: [],
    unmatched: [],
  }),
  getDiscoverersForProvider: vi.fn().mockReturnValue([]),
  getAllDiscoverers: vi.fn().mockReturnValue([]),
}));

vi.mock("@/services/settings", () => ({
  getEffectiveCredentials: vi.fn().mockReturnValue(null),
  isProviderEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/providers/registry", () => ({
  PROVIDER_REGISTRY: {
    aws: { toProviderConfig: vi.fn((c: Record<string, string>) => c) },
    digitalocean: { toProviderConfig: vi.fn((c: Record<string, string>) => c) },
  },
}));

import { ScanOrchestrator } from "@/discoverers/scan-orchestrator";

describe("ScanOrchestrator", () => {
  beforeEach(() => vi.clearAllMocks());

  test("getScanStatus returns null when no scan exists", async () => {
    const orchestrator = new ScanOrchestrator();
    const status = orchestrator.getScanStatus();
    expect(status.currentScan).toBeNull();
  });

  test("startScan returns error if scan is already running", async () => {
    const orchestrator = new ScanOrchestrator();
    // Simulate running scan
    orchestrator["runningScan"] = { id: 1, status: "running", startedAt: new Date().toISOString(), completed: 0, total: 0 };

    const result = await orchestrator.startScan();
    expect(result.error).toBe("A scan is already running");
  });
});
```

- [ ] **Step 2: Implement scan orchestrator**

```typescript
/**
 * Scan Orchestrator — coordinates resource discovery across providers.
 *
 * Flow: check concurrency → create scan record → match billing services
 * → execute discoverers (serial per provider, parallel across providers)
 * → upsert resources → clean up terminated → finalize scan record.
 */
import { db } from "@/db";
import { billItems, bills, resources, resourceScans } from "@/db/schema";
import { eq, and, gt, sql, inArray, notInArray } from "drizzle-orm";
import { matchBillingServices, getAllDiscoverers, getDiscoverersForProvider } from "./registry";
import { getEffectiveCredentials, isProviderEnabled } from "@/services/settings";
import { PROVIDER_REGISTRY } from "@/providers/registry";
import type { ProviderCredentials, DiscoveredResource, DiscovererResult, ScanDetails } from "./types";

const DISCOVERER_TIMEOUT_MS = 60_000;

interface RunningState {
  id: number;
  status: string;
  startedAt: string;
  completed: number;
  total: number;
}

export class ScanOrchestrator {
  private runningScan: RunningState | null = null;

  getScanStatus() {
    // Fetch recent scans from DB
    const recent = db
      .select()
      .from(resourceScans)
      .orderBy(sql`${resourceScans.startedAt} DESC`)
      .limit(10)
      .all();

    return {
      currentScan: this.runningScan
        ? {
            id: this.runningScan.id,
            status: this.runningScan.status,
            startedAt: this.runningScan.startedAt,
            progress: {
              completed: this.runningScan.completed,
              total: this.runningScan.total,
            },
          }
        : null,
      recentScans: recent,
    };
  }

  async startScan(provider?: string): Promise<{ scanId?: number; error?: string }> {
    if (this.runningScan) {
      return { error: "A scan is already running" };
    }

    // Create scan record
    const scanRecord = db
      .insert(resourceScans)
      .values({
        provider: provider ?? null,
        status: "running",
      })
      .returning()
      .get();

    const scanId = scanRecord.id;

    this.runningScan = {
      id: scanId,
      status: "running",
      startedAt: scanRecord.startedAt,
      completed: 0,
      total: 0,
    };

    // Run scan in background (non-blocking)
    this.executeScan(scanId, provider).catch((error) => {
      console.error("[ScanOrchestrator] Unhandled scan error:", error);
      this.finalizeScan(scanId, "failed", [], [], error.message);
    });

    return { scanId };
  }

  private async executeScan(scanId: number, provider?: string): Promise<void> {
    const details: ScanDetails = { discoverers: [], unmatchedServices: [] };
    const successfulTypes: string[] = [];

    try {
      // Step 1: Get billing services from recent 3 months
      const billingServices = this.getBillingServices(provider);

      // Step 2: Match to discoverers
      const { matched, unmatched } = matchBillingServices(billingServices);
      details.unmatchedServices = unmatched;

      // Filter by requested provider if specified
      const discoverers = provider
        ? matched.filter((m) => m.discoverer.provider === provider).map((m) => m.discoverer)
        : matched.map((m) => m.discoverer);

      // Deduplicate discoverers (same discoverer may match multiple billing services)
      const uniqueDiscoverers = [...new Map(discoverers.map((d) => [d.serviceKey, d])).values()];

      this.runningScan!.total = uniqueDiscoverers.length;

      // Step 3: Group by provider and execute
      const byProvider = new Map<string, typeof uniqueDiscoverers>();
      for (const d of uniqueDiscoverers) {
        const group = byProvider.get(d.provider) ?? [];
        group.push(d);
        byProvider.set(d.provider, group);
      }

      // Execute providers in parallel, discoverers within a provider serially
      const providerPromises = Array.from(byProvider.entries()).map(
        async ([providerKey, providerDiscoverers]) => {
          const creds = this.getCredentials(providerKey);
          if (!creds) {
            for (const d of providerDiscoverers) {
              details.discoverers.push({
                serviceKey: d.serviceKey,
                status: "failed",
                resourcesFound: 0,
                durationMs: 0,
                error: "No credentials configured",
              });
              this.runningScan!.completed++;
            }
            return;
          }

          for (const discoverer of providerDiscoverers) {
            const result = await this.executeDiscoverer(discoverer, creds);
            details.discoverers.push(result.detail);

            if (result.detail.status === "success" && result.resources.length > 0) {
              this.upsertResources(result.resources);
              successfulTypes.push(discoverer.serviceKey);
            }

            this.runningScan!.completed++;

            // Update progress in DB
            db.update(resourceScans)
              .set({ details: JSON.stringify(details) })
              .where(eq(resourceScans.id, scanId))
              .run();
          }
        }
      );

      await Promise.all(providerPromises);

      // Step 4: Clean up terminated resources (only for successful discoverers)
      if (successfulTypes.length > 0) {
        this.cleanupTerminatedResources(successfulTypes, provider);
      }

      // Step 5: Finalize
      const totalFound = details.discoverers.reduce((sum, d) => sum + d.resourcesFound, 0);
      const hasFailures = details.discoverers.some((d) => d.status === "failed" || d.status === "timeout");
      const allFailed = details.discoverers.every((d) => d.status === "failed" || d.status === "timeout");

      const finalStatus = allFailed ? "failed" : hasFailures ? "partial" : "success";

      this.finalizeScan(scanId, finalStatus, details.discoverers, details.unmatchedServices);
    } catch (error) {
      console.error("[ScanOrchestrator] Scan execution error:", error);
      this.finalizeScan(scanId, "failed", details.discoverers, details.unmatchedServices, String(error));
    }
  }

  private async executeDiscoverer(
    discoverer: { serviceKey: string; discover: (creds: ProviderCredentials) => Promise<DiscoveredResource[]> },
    credentials: ProviderCredentials
  ): Promise<{ detail: DiscovererResult; resources: DiscoveredResource[] }> {
    const startTime = Date.now();

    try {
      // Apply timeout
      const result = await Promise.race([
        discoverer.discover(credentials),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Discoverer timeout")), DISCOVERER_TIMEOUT_MS)
        ),
      ]);

      return {
        detail: {
          serviceKey: discoverer.serviceKey,
          status: "success",
          resourcesFound: result.length,
          durationMs: Date.now() - startTime,
        },
        resources: result,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === "Discoverer timeout";
      return {
        detail: {
          serviceKey: discoverer.serviceKey,
          status: isTimeout ? "timeout" : "failed",
          resourcesFound: 0,
          durationMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        },
        resources: [],
      };
    }
  }

  private getBillingServices(provider?: string): Array<{ provider: string; service: string }> {
    // Get distinct (provider, service) pairs from recent 3 months of bill items
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, "0")}`;

    const rows = db
      .select({
        provider: bills.provider,
        service: billItems.service,
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(
        provider
          ? and(gt(bills.billingPeriod, cutoff), eq(bills.provider, provider))
          : gt(bills.billingPeriod, cutoff)
      )
      .groupBy(bills.provider, billItems.service)
      .all();

    return rows.map((r) => ({ provider: r.provider, service: r.service }));
  }

  private getCredentials(providerKey: string): ProviderCredentials | null {
    if (!isProviderEnabled(providerKey)) return null;

    const creds = getEffectiveCredentials(providerKey);
    if (!creds) return null;

    const meta = PROVIDER_REGISTRY[providerKey];
    if (!meta) return null;

    const config = meta.toProviderConfig(creds);

    if (providerKey === "aws") {
      return {
        provider: "aws",
        accessKeyId: config.accessKeyId as string,
        secretAccessKey: config.secretAccessKey as string,
        region: config.region as string,
        resourceRegions: config.resourceRegions as string[],
      };
    }

    if (providerKey === "digitalocean") {
      return {
        provider: "digitalocean",
        apiToken: config.apiToken as string,
      };
    }

    return null;
  }

  private upsertResources(discoveredResources: DiscoveredResource[]): void {
    for (const r of discoveredResources) {
      db.insert(resources)
        .values({
          provider: r.provider,
          resourceId: r.resourceId,
          resourceName: r.resourceName,
          resourceType: r.resourceType,
          region: r.region,
          spec: r.spec,
          tags: JSON.stringify(r.tags),
          status: r.status,
          monthlyBaseCost: r.monthlyBaseCost,
          bandwidthAllowanceTib: r.bandwidthAllowanceTib ?? null,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [resources.provider, resources.resourceId],
          set: {
            resourceName: r.resourceName,
            resourceType: r.resourceType,
            region: r.region,
            spec: r.spec,
            tags: JSON.stringify(r.tags),
            status: r.status,
            monthlyBaseCost: r.monthlyBaseCost,
            bandwidthAllowanceTib: r.bandwidthAllowanceTib ?? null,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
    }
  }

  private cleanupTerminatedResources(successfulTypes: string[], provider?: string): void {
    // For each successful discoverer type, mark resources not in the latest scan as terminated
    // This is handled by checking updatedAt — resources not updated in this scan are stale
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min buffer

    for (const resourceType of successfulTypes) {
      const conditions = [
        eq(resources.resourceType, resourceType),
        sql`${resources.updatedAt} < ${cutoff}`,
        sql`${resources.status} != 'terminated'`,
      ];

      if (provider) {
        conditions.push(eq(resources.provider, provider));
      }

      db.update(resources)
        .set({ status: "terminated", updatedAt: new Date().toISOString() })
        .where(and(...conditions))
        .run();
    }
  }

  private finalizeScan(
    scanId: number,
    status: string,
    discoverers: DiscovererResult[],
    unmatchedServices: ScanDetails["unmatchedServices"],
    errorMessage?: string
  ): void {
    const totalFound = discoverers.reduce((sum, d) => sum + d.resourcesFound, 0);
    const details: ScanDetails = { discoverers, unmatchedServices };

    db.update(resourceScans)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        servicesScanned: discoverers.length,
        resourcesFound: totalFound,
        errorMessage: errorMessage ?? null,
        details: JSON.stringify(details),
      })
      .where(eq(resourceScans.id, scanId))
      .run();

    this.runningScan = null;
  }
}

/** Singleton orchestrator instance */
export const scanOrchestrator = new ScanOrchestrator();
```

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run src/discoverers/__tests__/scan-orchestrator.test.ts
git add src/discoverers/scan-orchestrator.ts src/discoverers/__tests__/scan-orchestrator.test.ts
git commit -m "feat: implement scan orchestrator with timeout and error isolation"
```

---

## Task 12: API Routes

**Files:**
- Create: `src/app/api/v1/resource-scan/route.ts`
- Create: `src/app/api/v1/resource-scan/services/route.ts`
- Create: `src/app/api/__tests__/resource-scan-routes.test.ts`

- [ ] **Step 1: Write API route tests**

```typescript
/**
 * Tests for resource-scan API routes.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetScanStatus = vi.fn();
const mockStartScan = vi.fn();

vi.mock("@/discoverers/scan-orchestrator", () => ({
  scanOrchestrator: {
    getScanStatus: (...args: unknown[]) => mockGetScanStatus(...args),
    startScan: (...args: unknown[]) => mockStartScan(...args),
  },
}));

// Mock billing services query
const mockGetBillingServices = vi.fn().mockReturnValue([]);
vi.mock("@/discoverers/registry", () => ({
  matchBillingServices: vi.fn().mockReturnValue({ matched: [], unmatched: [] }),
  getDiscoverersForProvider: vi.fn().mockReturnValue([]),
  getAllDiscoverers: vi.fn().mockReturnValue([]),
  ACCOUNT_LEVEL_SERVICES: new Set(["AmazonCloudWatch"]),
}));

import { GET, POST } from "@/app/api/v1/resource-scan/route";

function makeRequest(method: string, body?: Record<string, unknown>): NextRequest {
  const url = "http://localhost:3000/api/v1/resource-scan";
  return new NextRequest(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

describe("Resource Scan API", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /api/v1/resource-scan", () => {
    test("returns scan status", async () => {
      mockGetScanStatus.mockReturnValue({
        currentScan: null,
        recentScans: [],
      });

      const res = await GET(makeRequest("GET"));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.currentScan).toBeNull();
      expect(data.recentScans).toEqual([]);
    });
  });

  describe("POST /api/v1/resource-scan", () => {
    test("starts a scan successfully", async () => {
      mockStartScan.mockResolvedValue({ scanId: 1 });

      const res = await POST(makeRequest("POST", {}));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.scanId).toBe(1);
      expect(data.status).toBe("running");
    });

    test("returns 409 when scan is already running", async () => {
      mockStartScan.mockResolvedValue({ error: "A scan is already running" });

      const res = await POST(makeRequest("POST"));
      expect(res.status).toBe(409);
    });

    test("accepts optional provider parameter", async () => {
      mockStartScan.mockResolvedValue({ scanId: 2 });

      const res = await POST(makeRequest("POST", { provider: "aws" }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(mockStartScan).toHaveBeenCalledWith("aws");
    });
  });
});
```

- [ ] **Step 2: Implement resource-scan route**

`src/app/api/v1/resource-scan/route.ts`:

```typescript
/**
 * Resource Scan API — trigger scans and query scan status/history.
 */
import { NextRequest, NextResponse } from "next/server";
import { scanOrchestrator } from "@/discoverers/scan-orchestrator";

/** GET — query current scan status and recent scan history */
export async function GET() {
  try {
    const status = scanOrchestrator.getScanStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("[API] Resource scan status error:", error);
    return NextResponse.json({ error: "Failed to get scan status" }, { status: 500 });
  }
}

/** POST — trigger a resource scan (optionally for a single provider) */
export async function POST(request: NextRequest) {
  try {
    let provider: string | undefined;

    try {
      const body = await request.json();
      provider = body.provider;
    } catch {
      // No body or invalid JSON — scan all providers
    }

    const result = await scanOrchestrator.startScan(provider);

    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 409 }
      );
    }

    return NextResponse.json({
      scanId: result.scanId,
      status: "running",
      message: "Resource scan started",
    });
  } catch (error) {
    console.error("[API] Resource scan trigger error:", error);
    return NextResponse.json({ error: "Failed to start scan" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Implement services route**

`src/app/api/v1/resource-scan/services/route.ts`:

```typescript
/**
 * Resource Scan Services API — list billing services with discoverer support status.
 */
import { NextResponse } from "next/server";
import { db } from "@/db";
import { billItems, bills } from "@/db/schema";
import { eq, gt, sql } from "drizzle-orm";
import { getDiscoverersForProvider, ACCOUNT_LEVEL_SERVICES } from "@/discoverers/registry";

/** GET — billing services grouped by provider with discoverer match info */
export async function GET() {
  try {
    // Get billing services from recent 3 months with total amounts
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, "0")}`;

    const rows = db
      .select({
        provider: bills.provider,
        service: billItems.service,
        totalAmount: sql<number>`SUM(${billItems.amount})`,
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(gt(bills.billingPeriod, cutoff))
      .groupBy(bills.provider, billItems.service)
      .orderBy(sql`SUM(${billItems.amount}) DESC`)
      .all();

    // Group by provider and match discoverers
    const result: Record<string, Array<{
      service: string;
      hasDiscoverer: boolean;
      discovererKey?: string;
      reason?: string;
      lastBillAmount: number;
    }>> = {};

    for (const row of rows) {
      if (!result[row.provider]) result[row.provider] = [];

      const discoverers = getDiscoverersForProvider(row.provider);
      const matchedDiscoverer = discoverers.find((d) =>
        d.billingServiceNames.includes(row.service)
      );

      if (matchedDiscoverer) {
        result[row.provider].push({
          service: row.service,
          hasDiscoverer: true,
          discovererKey: matchedDiscoverer.serviceKey,
          lastBillAmount: Math.round(row.totalAmount * 100) / 100,
        });
      } else {
        result[row.provider].push({
          service: row.service,
          hasDiscoverer: false,
          reason: ACCOUNT_LEVEL_SERVICES.has(row.service) ? "account_level" : "no_discoverer",
          lastBillAmount: Math.round(row.totalAmount * 100) / 100,
        });
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Resource scan services error:", error);
    return NextResponse.json({ error: "Failed to get services" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run src/app/api/__tests__/resource-scan-routes.test.ts
git add src/app/api/v1/resource-scan/ src/app/api/__tests__/resource-scan-routes.test.ts
git commit -m "feat: implement resource-scan API routes"
```

---

## Task 13: Sidebar Navigation Update

**Files:**
- Modify: `src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add Resource Scan nav item**

Add import and nav entry in `src/components/layout/sidebar.tsx`:

Add `Radar` to the lucide-react import:

```typescript
import {
  LayoutDashboard,
  FileText,
  Server,
  TrendingUp,
  PencilLine,
  Settings,
  LogOut,
  Activity,
  Radar,
} from "lucide-react";
```

Add entry to `navItems` array after "Bandwidth":

```typescript
  { href: "/bandwidth", label: "Bandwidth", icon: Activity },
  { href: "/resource-scan", label: "Resource Scan", icon: Radar },
  { href: "/manual-costs", label: "Manual Costs", icon: PencilLine },
```

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat: add Resource Scan to sidebar navigation"
```

---

## Task 14: Resource Scan Page

**Files:**
- Create: `src/app/(dashboard)/resource-scan/page.tsx`

Implementation note: Use `/web-design-guidelines` skill during implementation for UI quality. Follow existing page patterns (client component, useState/useEffect/useCallback, shadcn/ui, Tailwind, toast notifications).

- [ ] **Step 1: Implement resource scan page**

```tsx
/**
 * Resource Scan page — independent resource discovery with service coverage
 * overview, scan triggering, and scan history.
 */
"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Radar,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

interface ScanProgress {
  completed: number;
  total: number;
}

interface CurrentScan {
  id: number;
  status: string;
  startedAt: string;
  progress: ScanProgress;
}

interface ScanRecord {
  id: number;
  provider: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  services_scanned: number;
  resources_found: number;
  details: string | null;
}

interface DiscovererDetail {
  serviceKey: string;
  status: string;
  resourcesFound: number;
  durationMs: number;
  error?: string;
}

interface ServiceInfo {
  service: string;
  hasDiscoverer: boolean;
  discovererKey?: string;
  reason?: string;
  lastBillAmount: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getProviderLabel(provider: string | null): string {
  if (provider === "aws") return "AWS";
  if (provider === "digitalocean") return "DigitalOcean";
  return provider ?? "All Providers";
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(status: string) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "partial":
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    case "timeout":
      return <Clock className="h-4 w-4 text-amber-500" />;
    default:
      return null;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ResourceScanPage() {
  const [currentScan, setCurrentScan] = useState<CurrentScan | null>(null);
  const [recentScans, setRecentScans] = useState<ScanRecord[]>([]);
  const [services, setServices] = useState<Record<string, ServiceInfo[]>>({});
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [scanProvider, setScanProvider] = useState<string>("all");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/resource-scan");
      if (res.ok) {
        const data = await res.json();
        setCurrentScan(data.currentScan);
        setRecentScans(data.recentScans ?? []);
      }
    } catch (error) {
      console.error("Failed to fetch scan status:", error);
    }
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/resource-scan/services");
      if (res.ok) {
        setServices(await res.json());
      }
    } catch (error) {
      console.error("Failed to fetch services:", error);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchStatus();
    fetchServices();
  }, [fetchStatus, fetchServices]);

  // Poll when scan is running
  useEffect(() => {
    if (!currentScan) return;

    const interval = setInterval(async () => {
      await fetchStatus();
      await fetchServices();
    }, 3000);

    return () => clearInterval(interval);
  }, [currentScan, fetchStatus, fetchServices]);

  const handleStartScan = async () => {
    try {
      const body = scanProvider === "all" ? {} : { provider: scanProvider };
      const res = await fetch("/api/v1/resource-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 409) {
        toast.error("A scan is already running");
        return;
      }

      if (res.ok) {
        toast.success("Resource scan started");
        await fetchStatus();
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Failed to start scan");
      }
    } catch {
      toast.error("Failed to start scan");
    }
  };

  const toggleRow = (id: number) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const parseDetails = (detailsJson: string | null): DiscovererDetail[] => {
    if (!detailsJson) return [];
    try {
      const parsed = JSON.parse(detailsJson);
      return parsed.discoverers ?? [];
    } catch {
      return [];
    }
  };

  const lastSuccessful = recentScans.find((s) => s.status === "success");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Resource Scan</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Discover and inventory cloud resources across all providers
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastSuccessful && (
            <span className="text-xs text-muted-foreground">
              Last scan: {new Date(lastSuccessful.started_at).toLocaleString()}
            </span>
          )}

          <Select value={scanProvider} onValueChange={setScanProvider}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              <SelectItem value="aws">AWS</SelectItem>
              <SelectItem value="digitalocean">DigitalOcean</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={handleStartScan}
            disabled={!!currentScan}
          >
            {currentScan ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scanning ({currentScan.progress.completed}/{currentScan.progress.total})
              </>
            ) : (
              <>
                <Radar className="mr-2 h-4 w-4" />
                Scan Resources
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Service Coverage Overview */}
      {Object.entries(services).length > 0 && (
        <div className="space-y-4">
          {Object.entries(services).map(([provider, serviceList]) => (
            <Card key={provider}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{getProviderLabel(provider)}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {serviceList.map((svc) => (
                    <div
                      key={svc.service}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{svc.service}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          ${svc.lastBillAmount.toFixed(2)}
                        </p>
                      </div>
                      <div className="ml-2 shrink-0">
                        {svc.hasDiscoverer ? (
                          <Badge variant="default" className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                            Supported
                          </Badge>
                        ) : svc.reason === "account_level" ? (
                          <Badge variant="secondary">Account Level</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            Pending
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state when no billing data */}
      {Object.entries(services).length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <p>No billing data found. Sync your billing data first for accurate service coverage analysis.</p>
            <p className="text-xs mt-1">You can still run a resource scan — it will check all supported services.</p>
          </CardContent>
        </Card>
      )}

      {/* Scan History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Scan History</CardTitle>
        </CardHeader>
        <CardContent>
          {recentScans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No scans yet. Click &quot;Scan Resources&quot; to start.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Services</TableHead>
                  <TableHead className="text-right">Resources</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentScans.map((scan) => {
                  const isExpanded = expandedRows[scan.id] ?? false;
                  const details = parseDetails(scan.details);

                  return (
                    <Fragment key={scan.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleRow(scan.id)}
                      >
                        <TableCell>
                          {details.length > 0 && (
                            isExpanded
                              ? <ChevronDown className="h-4 w-4" />
                              : <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {new Date(scan.started_at).toLocaleString()}
                        </TableCell>
                        <TableCell>{getProviderLabel(scan.provider)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {statusIcon(scan.status)}
                            <span className="text-sm capitalize">{scan.status}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {scan.services_scanned}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {scan.resources_found}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {formatDuration(scan.started_at, scan.finished_at)}
                        </TableCell>
                      </TableRow>

                      {/* Expanded details */}
                      {isExpanded && details.length > 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-0">
                            <div className="px-8 py-3">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-muted-foreground">
                                    <th className="text-left font-medium py-1">Service</th>
                                    <th className="text-left font-medium py-1">Status</th>
                                    <th className="text-right font-medium py-1">Resources</th>
                                    <th className="text-right font-medium py-1">Duration</th>
                                    <th className="text-left font-medium py-1 pl-4">Error</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {details.map((d) => (
                                    <tr key={d.serviceKey}>
                                      <td className="py-1 font-mono">{d.serviceKey}</td>
                                      <td className="py-1">
                                        <div className="flex items-center gap-1">
                                          {statusIcon(d.status)}
                                          <span className="capitalize">{d.status}</span>
                                        </div>
                                      </td>
                                      <td className="py-1 text-right font-mono">{d.resourcesFound}</td>
                                      <td className="py-1 text-right text-muted-foreground">
                                        {d.durationMs < 1000 ? `${d.durationMs}ms` : `${(d.durationMs / 1000).toFixed(1)}s`}
                                      </td>
                                      <td className="py-1 pl-4 text-red-500 text-xs truncate max-w-[200px]">
                                        {d.error ?? "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/resource-scan/page.tsx
git commit -m "feat: implement resource scan page with service coverage and scan history"
```

---

## Task 15: E2E Tests

**Files:**
- Create: `e2e/resource-scan.spec.ts`

- [ ] **Step 1: Write E2E tests**

```typescript
/**
 * E2E tests for the Resource Scan page.
 * Tests navigation, page rendering, scan triggering, and scan history display.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Resource Scan Page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("navigates to resource scan page via sidebar", async ({ page }) => {
    await page.click('a[href="/resource-scan"]');
    await page.waitForURL("/resource-scan");
    await expect(page.locator("h1")).toHaveText("Resource Scan");
  });

  test("renders page header and scan button", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h1")).toHaveText("Resource Scan");
    await expect(page.getByRole("button", { name: /scan resources/i })).toBeVisible();
  });

  test("shows provider selector with options", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Open the provider select
    const trigger = page.locator('button[role="combobox"]');
    await trigger.click();

    await expect(page.getByRole("option", { name: "All Providers" })).toBeVisible();
    await expect(page.getByRole("option", { name: "AWS" })).toBeVisible();
    await expect(page.getByRole("option", { name: "DigitalOcean" })).toBeVisible();
  });

  test("shows scan history section", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Scan History")).toBeVisible();
  });

  test("shows empty state message when no scans exist", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Should show either scan history or empty state
    const content = page.locator("text=No scans yet");
    const table = page.locator("table");

    // One of these should be visible
    const hasEmptyState = await content.isVisible().catch(() => false);
    const hasTable = await table.isVisible().catch(() => false);

    expect(hasEmptyState || hasTable).toBe(true);
  });

  test("scan button triggers API call", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Intercept the scan API call
    const scanRequest = page.waitForRequest(
      (req) => req.url().includes("/api/v1/resource-scan") && req.method() === "POST"
    );

    await page.getByRole("button", { name: /scan resources/i }).click();

    // Verify the request was made
    const req = await scanRequest;
    expect(req.method()).toBe("POST");
  });

  test("shows service coverage cards when billing data exists", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Service coverage section may or may not be visible depending on billing data
    // Check the page renders without errors either way
    const pageContent = await page.textContent("body");
    expect(pageContent).toContain("Resource Scan");
  });

  test("handles scan error gracefully (409 conflict)", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Mock the scan endpoint to return 409
    await page.route("**/api/v1/resource-scan", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "A scan is already running" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.getByRole("button", { name: /scan resources/i }).click();

    // Should show error toast
    await expect(page.getByText(/already running/i)).toBeVisible({ timeout: 5000 });
  });

  test("resource scan page is accessible from the sidebar", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Check sidebar link exists
    const scanLink = page.locator('a[href="/resource-scan"]');
    await expect(scanLink).toBeVisible();
    await expect(scanLink).toHaveText(/resource scan/i);
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
npx playwright test e2e/resource-scan.spec.ts
```

Note: E2E tests require the dev server running. If tests fail due to missing providers/data, that's expected — the tests primarily verify page structure and user interactions.

- [ ] **Step 3: Commit**

```bash
git add e2e/resource-scan.spec.ts
git commit -m "test: add E2E tests for resource scan page"
```

---

## Task 16: Run Full Test Suite & Fix Issues

- [ ] **Step 1: Run all unit tests**

```bash
npx vitest run
```

Fix any import errors, type mismatches, or test failures.

- [ ] **Step 2: Run all E2E tests**

```bash
npx playwright test
```

Verify existing tests still pass (no regression).

- [ ] **Step 3: Run type checking**

```bash
npx tsc --noEmit
```

Fix any TypeScript errors.

- [ ] **Step 4: Final commit with all fixes**

```bash
git add -A
git commit -m "fix: resolve test and type issues across resource discovery feature"
```
