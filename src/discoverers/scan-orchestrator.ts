/**
 * Scan Orchestrator — coordinates resource discovery across providers.
 *
 * Flow: check concurrency → create scan record → match billing services
 * → execute discoverers (serial per provider, parallel across providers)
 * → upsert resources → clean up terminated → finalize scan record.
 */
import { db } from "@/db";
import { billItems, bills, resources, resourceScans } from "@/db/schema";
import { eq, and, gt, sql } from "drizzle-orm";
import { matchBillingServices } from "./registry";
import { getEffectiveCredentials, isProviderEnabled } from "@/services/settings";
import { PROVIDER_REGISTRY } from "@/providers/registry";
import type { ProviderCredentials, DiscoveredResource, DiscovererResult, ScanDetails, ResourceDiscoverer } from "./types";

/** Max time (ms) a single discoverer is allowed before being aborted */
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

  /** Query current scan status and recent scan history */
  getScanStatus() {
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

  /** Start a resource scan. Returns error if one is already running. */
  async startScan(provider?: string): Promise<{ scanId?: number; error?: string }> {
    if (this.runningScan) {
      return { error: "A scan is already running" };
    }

    // Clean up stale scans from crashed processes (older than 10 minutes)
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.update(resourceScans)
      .set({ status: "failed", finishedAt: new Date().toISOString(), errorMessage: "Stale scan (process restart)" })
      .where(and(eq(resourceScans.status, "running"), sql`${resourceScans.startedAt} < ${staleCutoff}`))
      .run();

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
      this.finalizeScan(scanId, "failed", [], [], String(error));
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

      // Deduplicate discoverers (same serviceKey may appear from multiple billing names)
      const uniqueDiscoverers = [...new Map(discoverers.map((d) => [d.serviceKey, d])).values()];

      this.runningScan!.total = uniqueDiscoverers.length;

      // Step 3: Group by provider and execute
      const byProvider = new Map<string, ResourceDiscoverer[]>();
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
              const types = discoverer.resourceTypes ?? [discoverer.serviceKey];
              successfulTypes.push(...types);
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
      const hasFailures = details.discoverers.some((d) => d.status === "failed" || d.status === "timeout");
      const allFailed = details.discoverers.every((d) => d.status === "failed" || d.status === "timeout");
      const finalStatus = allFailed ? "failed" : hasFailures ? "partial" : "success";

      this.finalizeScan(scanId, finalStatus, details.discoverers, details.unmatchedServices);
    } catch (error) {
      console.error("[ScanOrchestrator] Scan execution error:", error);
      this.finalizeScan(scanId, "failed", details.discoverers, details.unmatchedServices, String(error));
    }
  }

  /**
   * Execute a single discoverer with timeout protection.
   * Returns both the per-discoverer result detail and the raw resources on success.
   */
  private async executeDiscoverer(
    discoverer: ResourceDiscoverer,
    credentials: ProviderCredentials
  ): Promise<{ detail: DiscovererResult; resources: DiscoveredResource[] }> {
    const startTime = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Discoverer timeout")), DISCOVERER_TIMEOUT_MS);
      });

      const result = await Promise.race([
        discoverer.discover(credentials),
        timeoutPromise,
      ]);

      clearTimeout(timer!);

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
      clearTimeout(timer!);
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

  /**
   * Query distinct billing services from the last 3 months.
   * These determine which discoverers need to run.
   */
  private getBillingServices(provider?: string): Array<{ provider: string; service: string }> {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, "0")}`;

    const conditions = [gt(bills.billingPeriod, cutoff)];
    if (provider) {
      conditions.push(eq(bills.provider, provider));
    }

    const rows = db
      .select({
        provider: bills.provider,
        service: billItems.service,
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(and(...conditions))
      .groupBy(bills.provider, billItems.service)
      .all();

    return rows.map((r) => ({ provider: r.provider, service: r.service }));
  }

  /**
   * Resolve provider credentials: check enabled state, decrypt/load creds,
   * then build the typed ProviderCredentials union.
   */
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

    if (providerKey === "alibaba-cloud") {
      return {
        provider: "alibaba-cloud",
        accessKeyId: config.accessKeyId as string,
        accessKeySecret: config.accessKeySecret as string,
        site: (config.site as string) || "china",
        regionId: (config.regionId as string) || "cn-hangzhou",
      };
    }

    return null;
  }

  /** Upsert discovered resources into the resources table (insert or update on conflict) */
  private upsertResources(discoveredResources: DiscoveredResource[]): void {
    // Wrap in transaction for SQLite performance (avoids per-row fsync)
    const upsertAll = db.transaction((tx) => {
      for (const r of discoveredResources) {
        tx.insert(resources)
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
            publicIp: r.publicIp ?? null,
            privateIp: r.privateIp ?? null,
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
              publicIp: r.publicIp ?? null,
              privateIp: r.privateIp ?? null,
              updatedAt: new Date().toISOString(),
            },
          })
          .run();
      }
    });

    upsertAll;
  }

  /**
   * Mark stale resources as terminated.
   * Only affects resource types that were successfully scanned — if a discoverer
   * for a resource type failed, we don't mark those resources as terminated
   * since the failure might be transient.
   */
  private cleanupTerminatedResources(successfulTypes: string[], provider?: string): void {
    // Resources not updated in the last 5 minutes are considered stale
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

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

  /** Update the scan record with final status and clear the running lock */
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
