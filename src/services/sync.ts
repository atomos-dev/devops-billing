/**
 * Data sync service — orchestrates billing data collection from all providers.
 * Handles upsert logic, concurrency locks, error handling, and sync log recording.
 */
import { db } from "@/db";
import { bills, billItems, resources, syncLogs, bandwidthUsage } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { BillingProvider, BillData, BillItemData, ResourceData, BandwidthDataPoint } from "@/providers/types";
import { classifyResource } from "./category";
import { syncBillItemCategories } from "./billing";

/** Track active syncs to prevent concurrent operations per provider */
const activeSyncs = new Set<string>();

/**
 * Build a null-safe equality condition for optional bill item identity fields.
 * Bill items are persisted with `null` for absent values, so matching against empty
 * strings would miss existing rows and cause duplicate inserts on subsequent syncs.
 */
function matchNullableBillItemField<TColumn>(
  column: TColumn,
  value: string | undefined
) {
  return value ? eq(column as never, value) : isNull(column as never);
}

export interface SyncResult {
  provider: string;
  status: "success" | "failed" | "partial";
  recordsSynced: number;
  errorMessage?: string;
  syncLogId: number;
}

/**
 * Run a full sync for a provider: bills, bill items, and resources.
 * Prevents concurrent syncs for the same provider.
 */
export async function syncProvider(
  provider: BillingProvider,
  syncType: "scheduled" | "manual",
  backfillMonths = 6
): Promise<SyncResult> {
  if (activeSyncs.has(provider.name)) {
    return {
      provider: provider.name,
      status: "failed",
      recordsSynced: 0,
      errorMessage: "Sync already in progress for this provider",
      syncLogId: -1,
    };
  }

  activeSyncs.add(provider.name);

  // Create sync log entry
  const logEntry = db
    .insert(syncLogs)
    .values({
      provider: provider.name,
      syncType,
      status: "running",
    })
    .returning()
    .get();

  let totalRecords = 0;
  const errors: string[] = [];

  try {
    // Calculate date range for backfill
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - backfillMonths);
    start.setDate(1);

    // 1. Fetch and upsert bills
    try {
      const billsData = await provider.fetchBills(start, end);
      for (const bill of billsData) {
        await upsertBill(bill);
        totalRecords++;
      }
    } catch (error) {
      const msg = `Bills fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(msg);
      console.error(`[Sync][${provider.name}] ${msg}`);
    }

    // 2. Fetch and upsert bill items for each period
    try {
      const existingBills = db
        .select()
        .from(bills)
        .where(eq(bills.provider, provider.name))
        .all();

      for (const bill of existingBills) {
        try {
          const items = await provider.fetchBillItems(bill.billingPeriod);
          if (provider.name === "digitalocean") {
            await replaceBillItemsForBill(bill.id, items, provider.name);
            totalRecords += items.length;
            continue;
          }

          for (const item of items) {
            await upsertBillItem(bill.id, item, provider.name);
            totalRecords++;
          }
        } catch (error) {
          const msg = `Bill items for ${bill.billingPeriod} failed: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(msg);
          console.error(`[Sync][${provider.name}] ${msg}`);
        }
      }
    } catch (error) {
      errors.push(`Bill items fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 3. Fetch and upsert resources
    try {
      const resourcesData = await provider.fetchResources();
      for (const resource of resourcesData) {
        await upsertResource(resource);
        totalRecords++;
      }
    } catch (error) {
      const msg = `Resources fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(msg);
      console.error(`[Sync][${provider.name}] ${msg}`);
    }

    // 4. Fetch bandwidth metrics (optional, DO-only)
    if (provider.fetchBandwidthMetrics) {
      try {
        const bwEnd = new Date();
        const bwStart = new Date();
        // DO Monitoring API retains up to 90 days of metrics
        bwStart.setDate(bwStart.getDate() - 90);
        const bwData = await provider.fetchBandwidthMetrics(bwStart, bwEnd);
        for (const point of bwData) {
          await upsertBandwidthUsage(point, provider.name);
          totalRecords++;
        }
      } catch (error) {
        const msg = `Bandwidth fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(msg);
        console.error(`[Sync][${provider.name}] ${msg}`);
      }
    }

    // 5. Sync resource categories → bill_items so analytics queries reflect current labels
    try {
      const updated = syncBillItemCategories();
      if (updated > 0) console.log(`[Sync][${provider.name}] Synced categories for ${updated} bill items`);
    } catch (error) {
      const msg = `Category sync failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(msg);
      console.error(`[Sync][${provider.name}] ${msg}`);
    }

    const status = errors.length > 0 ? "partial" : "success";
    const errorMessage = errors.length > 0 ? errors.join("; ") : null;

    // Update sync log
    db.update(syncLogs)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        recordsSynced: totalRecords,
        errorMessage,
        details: JSON.stringify({ errors, totalRecords }),
      })
      .where(eq(syncLogs.id, logEntry.id))
      .run();

    return {
      provider: provider.name,
      status,
      recordsSynced: totalRecords,
      errorMessage: errorMessage || undefined,
      syncLogId: logEntry.id,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    db.update(syncLogs)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
        errorMessage: msg,
      })
      .where(eq(syncLogs.id, logEntry.id))
      .run();

    return {
      provider: provider.name,
      status: "failed",
      recordsSynced: totalRecords,
      errorMessage: msg,
      syncLogId: logEntry.id,
    };
  } finally {
    activeSyncs.delete(provider.name);
  }
}

/** Sync all registered providers */
export async function syncAll(
  providers: Map<string, BillingProvider>,
  syncType: "scheduled" | "manual",
  backfillMonths = 6
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const [, provider] of providers) {
    const result = await syncProvider(provider, syncType, backfillMonths);
    results.push(result);
  }
  return results;
}

/** Upsert a bill record (by provider + billing_period) */
async function upsertBill(data: BillData): Promise<void> {
  const existing = db
    .select()
    .from(bills)
    .where(and(eq(bills.provider, data.provider), eq(bills.billingPeriod, data.billingPeriod)))
    .get();

  if (existing) {
    db.update(bills)
      .set({
        totalAmount: data.totalAmount,
        fetchedAt: new Date().toISOString(),
        rawData: data.rawData,
      })
      .where(eq(bills.id, existing.id))
      .run();
  } else {
    db.insert(bills)
      .values({
        provider: data.provider,
        billingPeriod: data.billingPeriod,
        totalAmount: data.totalAmount,
        rawData: data.rawData,
      })
      .run();
  }
}

/**
 * Build the persisted bill-item payload, reusing the same enrichment semantics for
 * both generic upserts and DigitalOcean's delete-and-rebuild path.
 */
function buildBillItemValuesSync(
  billId: number,
  data: BillItemData,
  providerName: string,
  reader: Pick<typeof db, "select"> = db
): typeof billItems.$inferInsert {
  // Auto-classify usage category from resource info.
  let usageCategory = "other";
  let resourceName = data.resourceName || null;

  if (data.resourceId) {
    const resource = reader
      .select()
      .from(resources)
      .where(
        and(eq(resources.provider, providerName), eq(resources.resourceId, data.resourceId))
      )
      .get();

    if (resource) {
      usageCategory = resource.usageCategory || "other";
      if (!resourceName && resource.resourceName) {
        resourceName = resource.resourceName;
      }
    }
  }

  return {
    billId,
    service: data.service,
    region: data.region || null,
    resourceId: data.resourceId || null,
    resourceName,
    usageCategory,
    amount: data.amount,
    usageQuantity: data.usageQuantity ?? null,
    usageUnit: data.usageUnit || null,
    startDate: data.startDate || null,
    endDate: data.endDate || null,
  };
}

/** Upsert a bill item (by bill_id + service + region + resource_id + usage_unit) */
async function upsertBillItem(
  billId: number,
  data: BillItemData,
  providerName: string
): Promise<void> {
  const values = buildBillItemValuesSync(billId, data, providerName);

  const existing = db
    .select()
    .from(billItems)
    .where(
      and(
        eq(billItems.billId, billId),
        eq(billItems.service, data.service),
        matchNullableBillItemField(billItems.region, data.region),
        matchNullableBillItemField(billItems.resourceId, data.resourceId),
        matchNullableBillItemField(billItems.usageUnit, data.usageUnit)
      )
    )
    .get();

  if (existing) {
    db.update(billItems).set(values).where(eq(billItems.id, existing.id)).run();
  } else {
    db.insert(billItems).values(values).run();
  }
}

/**
 * Replace all persisted bill items for a bill with the provider's authoritative
 * snapshot. This intentionally avoids the generic matcher for DigitalOcean, whose
 * invoice lines can legitimately collapse into one normalized item per persisted
 * identity during provider fetch.
 */
async function replaceBillItemsForBill(
  billId: number,
  items: BillItemData[],
  providerName: string
): Promise<void> {
  db.transaction((tx) => {
    tx.delete(billItems).where(eq(billItems.billId, billId)).run();

    for (const item of items) {
      const values = buildBillItemValuesSync(billId, item, providerName, tx);
      tx.insert(billItems).values(values).run();
    }
  });
}

/** Upsert a resource record */
async function upsertResource(data: ResourceData): Promise<void> {
  const tagsJson = data.tags ? JSON.stringify(data.tags) : null;
  const usageCategory = classifyResource(data.tags, data.resourceName);

  const existing = db
    .select()
    .from(resources)
    .where(
      and(eq(resources.provider, data.provider), eq(resources.resourceId, data.resourceId))
    )
    .get();

  const values = {
    provider: data.provider,
    resourceId: data.resourceId,
    resourceName: data.resourceName || null,
    resourceType: data.resourceType || null,
    region: data.region || null,
    spec: data.spec || null,
    tags: tagsJson,
    usageCategory,
    monthlyBaseCost: data.monthlyBaseCost || null,
    bandwidthAllowanceTib: data.bandwidthAllowanceTib ?? null,
    status: data.status || "running",
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    // Preserve manual category override
    if (existing.usageCategory !== "other" && usageCategory === "other") {
      delete (values as Record<string, unknown>).usageCategory;
    }
    db.update(resources).set(values).where(eq(resources.id, existing.id)).run();
  } else {
    db.insert(resources).values(values).run();
  }
}

/** Upsert a daily bandwidth usage record (by provider + resource_id + date) */
async function upsertBandwidthUsage(data: BandwidthDataPoint, providerName: string): Promise<void> {
  const existing = db
    .select()
    .from(bandwidthUsage)
    .where(
      and(
        eq(bandwidthUsage.provider, providerName),
        eq(bandwidthUsage.resourceId, data.resourceId),
        eq(bandwidthUsage.date, data.date)
      )
    )
    .get();

  const values = {
    provider: providerName,
    resourceId: data.resourceId,
    region: data.region || null,
    date: data.date,
    publicInGib: data.publicInGib,
    publicOutGib: data.publicOutGib,
    privateInGib: data.privateInGib,
    privateOutGib: data.privateOutGib,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(bandwidthUsage).set(values).where(eq(bandwidthUsage.id, existing.id)).run();
  } else {
    db.insert(bandwidthUsage).values(values).run();
  }
}
