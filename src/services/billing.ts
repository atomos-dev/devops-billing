/**
 * Billing query service — aggregates cost data for Dashboard, trends, and exports.
 */
import { db } from "@/db";
import { bills, billItems, manualCosts, resources, syncLogs, bandwidthUsage, bandwidthReports } from "@/db/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { getCurrentMonth } from "@/lib/utils";
import { classifyResource } from "./category";

/** Summary data for a single month across all providers */
export interface MonthlySummary {
  month: string; // YYYY-MM
  providers: { provider: string; amount: number; isManual: boolean }[];
  totalAuto: number;
  totalManual: number;
  total: number;
}

interface BillItemRecord {
  id: number;
  billId: number;
  service: string;
  region: string | null;
  resourceId: string | null;
  resourceName: string | null;
  usageCategory: string | null;
  amount: number;
  usageQuantity: number | null;
  usageUnit: string | null;
}

interface ResourceRecord {
  provider: string;
  resourceId: string;
  resourceName: string | null;
  usageCategory: string | null;
}

function hasMeaningfulCategory(value: string | null | undefined) {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== "other");
}

/**
 * Applies strict resource matching for bill items that already have a concrete resourceId.
 * No inference is performed: if the item cannot be matched by provider + resourceId, it remains unresolved.
 */
function enrichBillItemsWithDirectResourceMatches(
  items: BillItemRecord[],
  billProvider: string | null | undefined
) {
  if (!billProvider) return items;

  const resourceBackedItems = items.filter((item) => Boolean(item.resourceId?.trim()));
  if (resourceBackedItems.length === 0) return items;

  const resourceRows = db
    .select()
    .from(resources)
    .where(eq(resources.provider, billProvider))
    .all() as ResourceRecord[];

  const resourcesById = new Map(resourceRows.map((resource) => [resource.resourceId, resource]));

  return items.map((item) => {
    const resourceId = item.resourceId?.trim();
    if (!resourceId) return item;

    const matchedResource = resourcesById.get(resourceId);
    if (!matchedResource) return item;

    return {
      ...item,
      resourceName: item.resourceName || matchedResource.resourceName || null,
      usageCategory: hasMeaningfulCategory(item.usageCategory)
        ? item.usageCategory
        : matchedResource.usageCategory || item.usageCategory,
    };
  });
}

/** Get billing summary for a specific month (or current month) */
export function getMonthlySummary(month?: string): MonthlySummary {
  const targetMonth = month || getCurrentMonth();

  // Auto-collected bills
  const autoBills = db
    .select()
    .from(bills)
    .where(eq(bills.billingPeriod, targetMonth))
    .all();

  // Manual costs
  const manual = db
    .select()
    .from(manualCosts)
    .where(eq(manualCosts.billingPeriod, targetMonth))
    .all();

  const providers: MonthlySummary["providers"] = [];

  for (const bill of autoBills) {
    providers.push({
      provider: bill.provider,
      amount: bill.totalAmount,
      isManual: false,
    });
  }

  for (const cost of manual) {
    providers.push({
      provider: cost.providerName,
      amount: cost.amount,
      isManual: true,
    });
  }

  const totalAuto = autoBills.reduce((sum, b) => sum + b.totalAmount, 0);
  const totalManual = manual.reduce((sum, m) => sum + m.amount, 0);

  return {
    month: targetMonth,
    providers,
    totalAuto,
    totalManual,
    total: totalAuto + totalManual,
  };
}

/** Get monthly summaries for a date range (for trend charts) */
export function getMonthlyTrend(months: number = 6): MonthlySummary[] {
  const summaries: MonthlySummary[] = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    summaries.push(getMonthlySummary(month));
  }

  return summaries;
}

/** Monthly trend grouped by a dimension (service, region, or category) across N months */
export interface DimensionTrendItem {
  month: string;
  key: string | null;
  totalAmount: number;
}

/**
 * Get monthly cost trend grouped by a specific dimension.
 * Returns per-month, per-dimension-key totals for the last N months.
 * Optionally filtered by provider.
 */
export function getDimensionTrend(
  months: number = 6,
  dimension: "service" | "region" | "category",
  provider?: string
): DimensionTrendItem[] {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
  const startPeriod = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}`;

  const conditions = [gte(bills.billingPeriod, startPeriod)];
  if (provider) conditions.push(eq(bills.provider, provider));

  // For category dimension, prefer the resource table's label over bill_items
  if (dimension === "category") {
    return db
      .select({
        month: bills.billingPeriod,
        key: sql<string>`COALESCE(
          CASE WHEN ${resources.usageCategory} IS NOT NULL AND ${resources.usageCategory} != 'other'
               THEN ${resources.usageCategory} END,
          CASE WHEN ${billItems.usageCategory} IS NOT NULL AND ${billItems.usageCategory} != 'other'
               THEN ${billItems.usageCategory} END,
          'other'
        )`.as("category_key"),
        totalAmount: sql<number>`ROUND(SUM(${billItems.amount}), 2)`.as("total_amount"),
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .leftJoin(resources, eq(billItems.resourceId, resources.resourceId))
      .where(and(...conditions))
      .groupBy(bills.billingPeriod, sql`category_key`)
      .orderBy(bills.billingPeriod, sql`total_amount DESC`)
      .all();
  }

  const column =
    dimension === "service"
      ? billItems.service
      : billItems.region;

  return db
    .select({
      month: bills.billingPeriod,
      key: column,
      totalAmount: sql<number>`ROUND(SUM(${billItems.amount}), 2)`.as("total_amount"),
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(and(...conditions))
    .groupBy(bills.billingPeriod, column)
    .orderBy(bills.billingPeriod, sql`total_amount DESC`)
    .all();
}

/** Get bill items for a specific bill, with optional filtering */
export function getBillItems(
  billId: number,
  filters?: { service?: string; region?: string; category?: string }
) {
  const query = db.select().from(billItems).where(eq(billItems.billId, billId));

  // Note: additional filters applied in-memory for simplicity with SQLite
  const results = query.all() as BillItemRecord[];
  const bill = db.select().from(bills).where(eq(bills.id, billId)).get() as
    | { provider: string }
    | undefined;
  const enrichedResults = enrichBillItemsWithDirectResourceMatches(results, bill?.provider);

  return enrichedResults.filter((item) => {
    if (filters?.service && item.service !== filters.service) return false;
    if (filters?.region && item.region !== filters.region) return false;
    if (filters?.category && item.usageCategory !== filters.category) return false;
    return true;
  });
}

/** Get all bills with optional provider filter */
export function getBills(provider?: string) {
  if (provider) {
    return db
      .select()
      .from(bills)
      .where(eq(bills.provider, provider))
      .orderBy(desc(bills.billingPeriod))
      .all();
  }
  return db.select().from(bills).orderBy(desc(bills.billingPeriod)).all();
}

/** Get resources with search/filter/sort */
export function getResources(filters?: {
  provider?: string;
  search?: string;
  category?: string;
  region?: string;
}) {
  const results = db.select().from(resources).all();

  return results.filter((r) => {
    if (filters?.provider && r.provider !== filters.provider) return false;
    if (filters?.category && r.usageCategory !== filters.category) return false;
    if (filters?.region && r.region !== filters.region) return false;
    if (filters?.search) {
      const s = filters.search.toLowerCase();
      return (
        (r.resourceName || "").toLowerCase().includes(s) ||
        r.resourceId.toLowerCase().includes(s) ||
        (r.resourceType || "").toLowerCase().includes(s)
      );
    }
    return true;
  });
}

/** Get cost history for a specific resource across months */
export function getResourceCostHistory(resourceId: string) {
  return db
    .select({
      billingPeriod: bills.billingPeriod,
      amount: billItems.amount,
      service: billItems.service,
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(eq(billItems.resourceId, resourceId))
    .orderBy(bills.billingPeriod)
    .all();
}

/** Get sync status for all providers */
export function getProviderSyncStatus() {
  // Get latest sync log per provider
  const allLogs = db
    .select()
    .from(syncLogs)
    .orderBy(desc(syncLogs.startedAt))
    .all();

  const statusMap = new Map<
    string,
    { lastSync: string; status: string; isStale: boolean }
  >();

  for (const log of allLogs) {
    if (!statusMap.has(log.provider)) {
      const lastSyncTime = new Date(log.startedAt);
      const hoursSinceSync =
        (Date.now() - lastSyncTime.getTime()) / (1000 * 60 * 60);

      statusMap.set(log.provider, {
        lastSync: log.startedAt,
        status: log.status,
        isStale: hoursSinceSync > 48,
      });
    }
  }

  return statusMap;
}

/** Get top N resources by cost for a billing period, optionally filtered by provider */
export function getTopResources(billingPeriod: string, limit: number = 10, provider?: string) {
  const conditions = [eq(bills.billingPeriod, billingPeriod), sql`${billItems.resourceId} IS NOT NULL`];
  if (provider) conditions.push(eq(bills.provider, provider));

  return db
    .select({
      resourceId: billItems.resourceId,
      resourceName: billItems.resourceName,
      service: billItems.service,
      usageCategory: sql<string>`COALESCE(
        CASE WHEN ${resources.usageCategory} IS NOT NULL AND ${resources.usageCategory} != 'other'
             THEN ${resources.usageCategory} END,
        ${billItems.usageCategory}
      )`.as("usage_category"),
      totalAmount: sql<number>`SUM(${billItems.amount})`.as("total_amount"),
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .leftJoin(resources, eq(billItems.resourceId, resources.resourceId))
    .where(and(...conditions))
    .groupBy(billItems.resourceId, billItems.resourceName, billItems.service, sql`usage_category`)
    .orderBy(sql`total_amount DESC`)
    .limit(limit)
    .all();
}

/** Get cost breakdown by a dimension (service, region, or category) */
export function getCostBreakdown(
  billingPeriod: string,
  dimension: "service" | "region" | "category",
  provider?: string
) {
  // Build where condition upfront to avoid chaining .where() calls
  const whereCondition = provider
    ? and(eq(bills.billingPeriod, billingPeriod), eq(bills.provider, provider))
    : eq(bills.billingPeriod, billingPeriod);

  // For category dimension, prefer resources table labels and distribute
  // unmatched bill_items by the region's known resource cost proportions.
  if (dimension === "category") {
    return getCategoryBreakdownWithInference(billingPeriod, provider);
  }

  const column =
    dimension === "service"
      ? billItems.service
      : billItems.region;

  return db
    .select({
      key: column,
      totalAmount: sql<number>`SUM(${billItems.amount})`.as("total_amount"),
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(whereCondition)
    .groupBy(column)
    .orderBy(sql`total_amount DESC`)
    .all();
}

/**
 * Category breakdown with inference: for bill_items that have a resource_id,
 * use the resource's label; for unmatched items (NULL resource_id), distribute
 * the amount proportionally based on the region's known resource cost shares.
 */
function getCategoryBreakdownWithInference(
  billingPeriod: string,
  provider?: string
): { key: string | null; totalAmount: number }[] {
  const providerFilter = provider ? `AND b.provider = '${provider}'` : "";

  // Step 1: get directly categorized amounts (items with a known category)
  const directRows = db.all<{ category: string; amount: number }>(sql`
    SELECT
      COALESCE(
        CASE WHEN r.usage_category IS NOT NULL AND r.usage_category != 'other'
             THEN r.usage_category END,
        CASE WHEN bi.usage_category IS NOT NULL AND bi.usage_category != 'other'
             THEN bi.usage_category END,
        'other'
      ) as category,
      SUM(bi.amount) as amount
    FROM bill_items bi
    INNER JOIN bills b ON bi.bill_id = b.id
    LEFT JOIN resources r ON bi.resource_id = r.resource_id
    WHERE b.billing_period = ${billingPeriod}
      AND bi.resource_id IS NOT NULL
      ${sql.raw(providerFilter)}
    GROUP BY category
  `);

  // Step 2: get unmatched amounts per provider+region
  const unmatchedRows = db.all<{ prov: string; region: string | null; amount: number }>(sql`
    SELECT b.provider as prov, bi.region, SUM(bi.amount) as amount
    FROM bill_items bi
    INNER JOIN bills b ON bi.bill_id = b.id
    WHERE b.billing_period = ${billingPeriod}
      AND bi.resource_id IS NULL
      ${sql.raw(providerFilter)}
    GROUP BY b.provider, bi.region
  `);

  // Step 3: build region→category cost proportions from resources table
  const regionShares = db.all<{ prov: string; region: string; category: string; cost: number }>(sql`
    SELECT provider as prov, region, usage_category as category,
           SUM(COALESCE(monthly_base_cost, 0)) as cost
    FROM resources
    WHERE usage_category != 'other'
      AND monthly_base_cost IS NOT NULL AND monthly_base_cost > 0
    GROUP BY provider, region, usage_category
  `);

  // Build lookup: provider+region → [{category, share}]
  const shareLookup = new Map<string, { category: string; share: number }[]>();
  const regionTotals = new Map<string, number>();
  for (const r of regionShares) {
    const key = `${r.prov}|${r.region}`;
    regionTotals.set(key, (regionTotals.get(key) ?? 0) + r.cost);
  }
  for (const r of regionShares) {
    const key = `${r.prov}|${r.region}`;
    const total = regionTotals.get(key) ?? 1;
    if (!shareLookup.has(key)) shareLookup.set(key, []);
    shareLookup.get(key)!.push({ category: r.category, share: r.cost / total });
  }

  // Step 4: distribute unmatched amounts
  const categoryTotals = new Map<string, number>();
  for (const row of directRows) {
    categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0) + row.amount);
  }

  for (const row of unmatchedRows) {
    const key = `${row.prov}|${row.region}`;
    const shares = shareLookup.get(key);
    if (shares && shares.length > 0) {
      // Distribute proportionally
      for (const s of shares) {
        const allocated = row.amount * s.share;
        categoryTotals.set(s.category, (categoryTotals.get(s.category) ?? 0) + allocated);
      }
    } else {
      // No region data — keep as other
      categoryTotals.set("other", (categoryTotals.get("other") ?? 0) + row.amount);
    }
  }

  return [...categoryTotals.entries()]
    .map(([key, totalAmount]) => ({ key, totalAmount: Math.round(totalAmount * 100) / 100 }))
    .sort((a, b) => b.totalAmount - a.totalAmount);
}

/** CRUD for manual costs */
export function getManualCosts(billingPeriod?: string) {
  if (billingPeriod) {
    return db
      .select()
      .from(manualCosts)
      .where(eq(manualCosts.billingPeriod, billingPeriod))
      .orderBy(desc(manualCosts.billingPeriod))
      .all();
  }
  return db.select().from(manualCosts).orderBy(desc(manualCosts.billingPeriod)).all();
}

export function createManualCost(data: {
  providerName: string;
  billingPeriod: string;
  amount: number;
  note?: string;
}) {
  return db.insert(manualCosts).values(data).returning().get();
}

export function updateManualCost(
  id: number,
  data: { providerName?: string; amount?: number; note?: string }
) {
  return db
    .update(manualCosts)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(manualCosts.id, id))
    .returning()
    .get();
}

export function deleteManualCost(id: number) {
  return db.delete(manualCosts).where(eq(manualCosts.id, id)).run();
}

// ─── Idle Resource Detection ─────────────────────────────────────────────────

/** Non-running resource with cost info, used for the "needs attention" panel */
export interface IdleResource {
  id: number;
  provider: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string | null;
  region: string | null;
  spec: string | null;
  status: string;
  /** Estimated monthly cost from the resources table or latest bill items */
  monthlyCost: number;
  /** Days since the resource was last updated (proxy for idle duration) */
  idleDays: number;
  updatedAt: string;
}

/**
 * Get idle/wasteful resources — stopped or unassociated resources that still
 * incur cost. Excludes "terminated" because terminated instances (e.g. AWS EC2)
 * are fully deallocated and no longer billed. Uses resources.monthlyBaseCost
 * when available, falls back to the most recent billing period's cost.
 */
export function getIdleResources(provider?: string): IdleResource[] {
  // Statuses where the resource still exists and may incur charges
  // (stopped EC2 = EBS still billed; unassociated EIP = hourly charge; etc.)
  // "terminated" is excluded: AWS fully deallocates terminated instances.
  const idleStatuses = ["stopped", "unassociated", "unattached"];

  const allResources = db.select().from(resources).all();

  // Get latest billing cost per resourceId for fallback pricing
  const latestCosts = db
    .select({
      resourceId: billItems.resourceId,
      totalAmount: sql<number>`SUM(${billItems.amount})`.as("total_amount"),
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(sql`${billItems.resourceId} IS NOT NULL`)
    .groupBy(billItems.resourceId)
    .all();

  const costMap = new Map(
    latestCosts.map((c) => [c.resourceId!, c.totalAmount])
  );

  const now = Date.now();

  return allResources
    .filter((r) => {
      if (provider && r.provider !== provider) return false;
      return idleStatuses.includes(r.status ?? "running");
    })
    .map((r) => {
      const monthlyCost = r.monthlyBaseCost ?? costMap.get(r.resourceId) ?? 0;
      const updatedMs = r.updatedAt ? new Date(r.updatedAt).getTime() : now;
      const idleDays = Math.max(0, Math.floor((now - updatedMs) / (1000 * 60 * 60 * 24)));

      return {
        id: r.id,
        provider: r.provider,
        resourceId: r.resourceId,
        resourceName: r.resourceName,
        resourceType: r.resourceType,
        region: r.region,
        spec: r.spec,
        status: r.status ?? "unknown",
        monthlyCost,
        idleDays,
        updatedAt: r.updatedAt,
      };
    })
    .sort((a, b) => b.monthlyCost - a.monthlyCost); // Highest cost first
}

/** Monthly bandwidth usage aggregated by region */
export interface BandwidthTrendItem {
  month: string; // YYYY-MM
  region: string;
  publicInGib: number;
  publicOutGib: number;
  privateInGib: number;
  privateOutGib: number;
}

/** Per-droplet bandwidth for a specific month */
export interface BandwidthDetailItem {
  resourceId: string;
  resourceName: string | null;
  region: string;
  publicInGib: number;
  publicOutGib: number;
  privateInGib: number;
  privateOutGib: number;
}

/** Bandwidth overage costs from invoice items */
export interface BandwidthOverageItem {
  billingPeriod: string;
  service: string;
  amount: number;
  resourceName: string | null;
}

/**
 * Get monthly bandwidth trend by region for the last N months.
 * Groups daily bandwidth_usage records by YYYY-MM and region.
 */
export function getBandwidthTrend(months: number = 6, provider = "digitalocean"): BandwidthTrendItem[] {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;

  const rows = db
    .select({
      month: sql<string>`substr(${bandwidthUsage.date}, 1, 7)`.as("month"),
      region: bandwidthUsage.region,
      publicInGib: sql<number>`ROUND(SUM(${bandwidthUsage.publicInGib}), 4)`.as("public_in_gib"),
      publicOutGib: sql<number>`ROUND(SUM(${bandwidthUsage.publicOutGib}), 4)`.as("public_out_gib"),
      privateInGib: sql<number>`ROUND(SUM(${bandwidthUsage.privateInGib}), 4)`.as("private_in_gib"),
      privateOutGib: sql<number>`ROUND(SUM(${bandwidthUsage.privateOutGib}), 4)`.as("private_out_gib"),
    })
    .from(bandwidthUsage)
    .where(
      and(
        eq(bandwidthUsage.provider, provider),
        gte(bandwidthUsage.date, startStr)
      )
    )
    .groupBy(sql`substr(${bandwidthUsage.date}, 1, 7)`, bandwidthUsage.region)
    .orderBy(sql`month`)
    .all();

  return rows.map((r) => ({
    month: r.month,
    region: r.region || "unknown",
    publicInGib: r.publicInGib,
    publicOutGib: r.publicOutGib,
    privateInGib: r.privateInGib,
    privateOutGib: r.privateOutGib,
  }));
}

/**
 * Get per-droplet bandwidth detail for a specific month.
 * Joins with resources table for human-readable names.
 */
export function getBandwidthDetail(period: string, provider = "digitalocean"): BandwidthDetailItem[] {
  const startStr = `${period}-01`;
  const endStr = `${period}-31`;

  const rows = db
    .select({
      resourceId: bandwidthUsage.resourceId,
      region: bandwidthUsage.region,
      publicInGib: sql<number>`ROUND(SUM(${bandwidthUsage.publicInGib}), 4)`.as("public_in_gib"),
      publicOutGib: sql<number>`ROUND(SUM(${bandwidthUsage.publicOutGib}), 4)`.as("public_out_gib"),
      privateInGib: sql<number>`ROUND(SUM(${bandwidthUsage.privateInGib}), 4)`.as("private_in_gib"),
      privateOutGib: sql<number>`ROUND(SUM(${bandwidthUsage.privateOutGib}), 4)`.as("private_out_gib"),
    })
    .from(bandwidthUsage)
    .where(
      and(
        eq(bandwidthUsage.provider, provider),
        gte(bandwidthUsage.date, startStr),
        lte(bandwidthUsage.date, endStr)
      )
    )
    .groupBy(bandwidthUsage.resourceId, bandwidthUsage.region)
    .orderBy(sql`public_out_gib DESC`)
    .all();

  // Batch-resolve resource names
  const resourceRows = db
    .select({ resourceId: resources.resourceId, resourceName: resources.resourceName })
    .from(resources)
    .where(eq(resources.provider, provider))
    .all();
  const nameMap = new Map(resourceRows.map((r) => [r.resourceId, r.resourceName]));

  return rows.map((r) => ({
    resourceId: r.resourceId,
    resourceName: nameMap.get(r.resourceId) || null,
    region: r.region || "unknown",
    publicInGib: r.publicInGib,
    publicOutGib: r.publicOutGib,
    privateInGib: r.privateInGib,
    privateOutGib: r.privateOutGib,
  }));
}

/**
 * Get bandwidth overage costs from bill items.
 * Matches services containing "Bandwidth" in the name (e.g. "VPC Peering Bandwidth").
 */
export function getBandwidthOverageCosts(months: number = 6, provider = "digitalocean"): BandwidthOverageItem[] {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startPeriod = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}`;

  return db
    .select({
      billingPeriod: bills.billingPeriod,
      service: billItems.service,
      amount: billItems.amount,
      resourceName: billItems.resourceName,
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(
      and(
        eq(bills.provider, provider),
        gte(bills.billingPeriod, startPeriod),
        sql`${billItems.service} LIKE '%Bandwidth%'`
      )
    )
    .orderBy(desc(bills.billingPeriod))
    .all();
}

// ─── Bandwidth Overage Analysis ───────────────────────────────────────────────

/** DO overage rate: $0.01 per GiB of public outbound traffic exceeding the pool */
const DO_OVERAGE_RATE_PER_GIB = 0.01;

/** Per-month analysis result comparing actual usage against the free transfer pool */
export interface BandwidthAnalysisItem {
  month: string; // YYYY-MM
  /** Total account-level transfer pool derived from active resources (GiB) */
  poolGib: number;
  /** Actual measured public outbound traffic (GiB) */
  usageGib: number;
  /** max(usageGib - poolGib, 0) */
  overageGib: number;
  /** overageGib × $0.01 */
  estimatedCostUsd: number;
  /** Actual billed bandwidth overage from invoices (USD) */
  billedCostUsd: number;
  /** estimatedCostUsd − billedCostUsd */
  discrepancyUsd: number;
  /** Whether this month has measured bandwidth_usage data (false = bill-only) */
  hasUsageData: boolean;
}

/**
 * Bandwidth overage analysis — compares measured public outbound against
 * the DO transfer pool (from resources.bandwidth_allowance_tib) and
 * cross-references with actual billed overage from invoices.
 *
 * The transfer pool is team-level shared; only public outbound counts.
 * Overage rate: $0.01/GiB (DO standard pricing).
 */
export function getBandwidthOverageAnalysis(
  months: number = 6,
  provider = "digitalocean"
): BandwidthAnalysisItem[] {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
  const startPeriod = startStr.slice(0, 7); // YYYY-MM

  // 1. Monthly usage — prefer CSV-imported precise data (bandwidth_reports),
  //    fall back to Monitoring API sampled data (bandwidth_usage).
  //    CSV data is authoritative; Monitoring API underestimates by ~2-2.5x.

  // 1a. Precise usage from bandwidth_reports (DO Bandwidth Detail CSV)
  const csvUsageRows = db
    .select({
      month: bandwidthReports.billingPeriod,
      totalOutGib: sql<number>`ROUND(SUM(${bandwidthReports.bandwidthGib}), 4)`.as("total_out_gib"),
    })
    .from(bandwidthReports)
    .where(and(eq(bandwidthReports.provider, provider), gte(bandwidthReports.billingPeriod, startPeriod)))
    .groupBy(bandwidthReports.billingPeriod)
    .all();

  const csvUsageMap = new Map(csvUsageRows.map((r) => [r.month, r.totalOutGib]));

  // 1b. Sampled usage from bandwidth_usage (Monitoring API) — for months without CSV data
  const monitoringUsageRows = db
    .select({
      month: sql<string>`substr(${bandwidthUsage.date}, 1, 7)`.as("month"),
      totalOutGib: sql<number>`ROUND(SUM(${bandwidthUsage.publicOutGib}), 4)`.as("total_out_gib"),
    })
    .from(bandwidthUsage)
    .where(and(eq(bandwidthUsage.provider, provider), gte(bandwidthUsage.date, startStr)))
    .groupBy(sql`substr(${bandwidthUsage.date}, 1, 7)`)
    .orderBy(sql`month`)
    .all();

  // Merge: CSV takes priority over Monitoring API
  const usageRows = [...new Set([
    ...csvUsageRows.map((r) => r.month),
    ...monitoringUsageRows.map((r) => r.month),
  ])].map((month) => ({
    month,
    totalOutGib: csvUsageMap.get(month) ?? monitoringUsageRows.find((r) => r.month === month)?.totalOutGib ?? 0,
  }));

  // 2. Per-month transfer pool — for months with CSV data, derive pool from
  //    resources that appear in the CSV; for other months, use bandwidth_usage records.

  // 2a. Pool from CSV months (resources that had bandwidth in that period)
  const csvPoolRows = db.all<{ month: string; pool_tib: number }>(sql`
    SELECT
      sub.billing_period AS month,
      COALESCE(SUM(r.bandwidth_allowance_tib), 0) AS pool_tib
    FROM (
      SELECT DISTINCT
        ${bandwidthReports.billingPeriod} AS billing_period,
        ${bandwidthReports.resourceId} AS resource_id
      FROM ${bandwidthReports}
      WHERE ${bandwidthReports.provider} = ${provider}
        AND ${bandwidthReports.billingPeriod} >= ${startPeriod}
    ) sub
    INNER JOIN ${resources} r
      ON r.provider = ${provider}
      AND r.resource_id = sub.resource_id
      AND r.bandwidth_allowance_tib IS NOT NULL
    GROUP BY sub.billing_period
  `);

  const csvPoolMap = new Map(csvPoolRows.map((r) => [r.month, r.pool_tib * 1024]));

  // 2b. Pool from Monitoring API months
  const monitoringPoolRows = db.all<{ month: string; pool_tib: number }>(sql`
    SELECT
      sub.month,
      COALESCE(SUM(r.bandwidth_allowance_tib), 0) AS pool_tib
    FROM (
      SELECT DISTINCT
        substr(${bandwidthUsage.date}, 1, 7) AS month,
        ${bandwidthUsage.resourceId} AS resource_id
      FROM ${bandwidthUsage}
      WHERE ${bandwidthUsage.provider} = ${provider}
        AND ${bandwidthUsage.date} >= ${startStr}
    ) sub
    INNER JOIN ${resources} r
      ON r.provider = ${provider}
      AND r.resource_id = sub.resource_id
      AND r.bandwidth_allowance_tib IS NOT NULL
    GROUP BY sub.month
  `);

  // Merge pool maps: CSV takes priority
  const monthlyPoolRows = [...new Set([
    ...csvPoolRows.map((r) => r.month),
    ...monitoringPoolRows.map((r) => r.month),
  ])].map((month) => ({
    month,
    pool_tib: (csvPoolMap.get(month) ?? (monitoringPoolRows.find((r) => r.month === month)?.pool_tib ?? 0) * 1024) / 1024,
  }));

  // Map: month → pool in GiB
  const poolMap = new Map(
    monthlyPoolRows.map((r) => [r.month, r.pool_tib * 1024])
  );

  // 3. Billed bandwidth costs from invoices (bill_items WHERE service LIKE '%Bandwidth%')
  const billedRows = db
    .select({
      billingPeriod: bills.billingPeriod,
      totalBilled: sql<number>`ROUND(SUM(${billItems.amount}), 2)`.as("total_billed"),
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(
      and(
        eq(bills.provider, provider),
        gte(bills.billingPeriod, startPeriod),
        sql`${billItems.service} LIKE '%Bandwidth%'`
      )
    )
    .groupBy(bills.billingPeriod)
    .all();

  const billedMap = new Map(billedRows.map((r) => [r.billingPeriod, r.totalBilled]));

  // 4. Build a continuous month sequence from startPeriod to the current month so
  //    months with zero bandwidth activity still appear in the table (no gaps).
  const usageMap = new Map(usageRows.map((r) => [r.month, r.totalOutGib]));
  // Track which months have CSV data (precise) vs Monitoring API (approximate)
  const csvMonths = new Set(csvUsageRows.map((r) => r.month));
  const allMonths: string[] = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const now = new Date();
  while (cursor <= now) {
    allMonths.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`
    );
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return allMonths.map((month) => {
    const usageGib = usageMap.get(month) ?? 0;
    const poolGib = poolMap.get(month) ?? 0;
    // Only calculate overage when we have usage data (CSV or Monitoring API)
    const hasUsageData = usageMap.has(month) || csvMonths.has(month);
    const overageGib = hasUsageData ? Math.max(usageGib - poolGib, 0) : 0;
    const estimatedCostUsd = hasUsageData
      ? Math.round(overageGib * DO_OVERAGE_RATE_PER_GIB * 100) / 100
      : 0;
    const billedCostUsd = billedMap.get(month) ?? 0;
    const discrepancyUsd = hasUsageData
      ? Math.round((estimatedCostUsd - billedCostUsd) * 100) / 100
      : 0;

    return {
      month,
      poolGib: Math.round(poolGib * 100) / 100,
      usageGib: Math.round(usageGib * 100) / 100,
      overageGib: Math.round(overageGib * 100) / 100,
      estimatedCostUsd,
      billedCostUsd,
      discrepancyUsd,
      /** Whether this month has measured bandwidth_usage data (vs bill-only) */
      hasUsageData,
    };
  });
}

/** Update resource usage category by resource id */
export function updateResourceCategory(id: number, usageCategory: string) {
  return db
    .update(resources)
    .set({ usageCategory, updatedAt: new Date().toISOString() })
    .where(eq(resources.id, id))
    .returning()
    .get();
}

/**
 * Sync usageCategory from resources table → bill_items table, then
 * apply name-based classification for items without a matching resource.
 * Two passes:
 *   1. Bulk SQL update from resources table (fast, covers matched items)
 *   2. In-memory classifyResource() for unmatched items with a resource_name
 * Returns the total number of bill_items updated.
 */
export function syncBillItemCategories(): number {
  // Pass 1: propagate categories from resources table
  const pass1 = db.run(sql`
    UPDATE bill_items
    SET usage_category = (
      SELECT r.usage_category
      FROM resources r
      WHERE r.resource_id = bill_items.resource_id
        AND r.usage_category IS NOT NULL
        AND r.usage_category != 'other'
      LIMIT 1
    )
    WHERE resource_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM resources r
        WHERE r.resource_id = bill_items.resource_id
          AND r.usage_category IS NOT NULL
          AND r.usage_category != 'other'
      )
  `);

  // Pass 2: classify by resource_name for items still marked "other"
  const uncategorized = db
    .select({ id: billItems.id, resourceName: billItems.resourceName })
    .from(billItems)
    .where(and(
      eq(billItems.usageCategory, "other"),
      sql`${billItems.resourceName} IS NOT NULL AND ${billItems.resourceName} != ''`
    ))
    .all();

  let pass2 = 0;
  for (const item of uncategorized) {
    const category = classifyResource(undefined, item.resourceName ?? undefined);
    if (category !== "other") {
      db.update(billItems)
        .set({ usageCategory: category })
        .where(eq(billItems.id, item.id))
        .run();
      pass2++;
    }
  }

  return pass1.changes + pass2;
}
