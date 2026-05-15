/**
 * Resource Scan Services API — list billing services with discoverer support status.
 *
 * Route:
 *   GET /api/v1/resource-scan/services           — latest month per provider
 *   GET /api/v1/resource-scan/services?period=... — specific month
 *   GET /api/v1/resource-scan/services?list=periods — list available periods
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { billItems, bills } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getDiscoverersForProvider, ACCOUNT_LEVEL_SERVICES } from "@/discoverers/registry";

export async function GET(request: NextRequest) {
  try {
    const listParam = request.nextUrl.searchParams.get("list");
    const periodParam = request.nextUrl.searchParams.get("period");

    // ── List available billing periods ──────────────────────────────────────
    if (listParam === "periods") {
      const periods = db
        .select({
          period: bills.billingPeriod,
          providers: sql<string>`GROUP_CONCAT(DISTINCT ${bills.provider})`,
        })
        .from(billItems)
        .innerJoin(bills, eq(billItems.billId, bills.id))
        .groupBy(bills.billingPeriod)
        .orderBy(sql`${bills.billingPeriod} DESC`)
        .all();

      return NextResponse.json({
        periods: periods.map((p) => ({
          period: p.period,
          providers: p.providers.split(","),
        })),
      });
    }

    // ── Determine which period(s) to query ─────────────────────────────────
    let periodFilter: Array<{ provider: string; period: string }>;

    if (periodParam) {
      // Specific period requested — use same period for all providers that have data
      const providers = db
        .select({ provider: bills.provider })
        .from(billItems)
        .innerJoin(bills, eq(billItems.billId, bills.id))
        .where(eq(bills.billingPeriod, periodParam))
        .groupBy(bills.provider)
        .all();

      periodFilter = providers.map((p) => ({ provider: p.provider, period: periodParam }));

      if (periodFilter.length === 0) {
        return NextResponse.json({ billingPeriod: periodParam, services: {} });
      }
    } else {
      // No period specified — find the latest period where ALL providers have data
      const allProviderPeriods = db
        .select({
          period: bills.billingPeriod,
          providerCount: sql<number>`COUNT(DISTINCT ${bills.provider})`,
        })
        .from(billItems)
        .innerJoin(bills, eq(billItems.billId, bills.id))
        .groupBy(bills.billingPeriod)
        .orderBy(sql`${bills.billingPeriod} DESC`)
        .all();

      // Total number of providers that have any billing data
      const totalProviders = new Set(
        db.select({ provider: bills.provider }).from(bills).all().map((r) => r.provider)
      ).size;

      // Pick the latest period with all providers, or fall back to the overall latest
      const fullPeriod = allProviderPeriods.find((p) => p.providerCount >= totalProviders);
      const latestPeriod = fullPeriod?.period ?? allProviderPeriods[0]?.period;

      if (!latestPeriod) {
        return NextResponse.json({ billingPeriod: null, services: {} });
      }

      // Get all providers that have data for this period
      const providers = db
        .select({ provider: bills.provider })
        .from(billItems)
        .innerJoin(bills, eq(billItems.billId, bills.id))
        .where(eq(bills.billingPeriod, latestPeriod))
        .groupBy(bills.provider)
        .all();

      periodFilter = providers.map((p) => ({ provider: p.provider, period: latestPeriod }));
    }

    // ── Query services for the selected period(s) ──────────────────────────
    const rows = db
      .select({
        provider: bills.provider,
        service: billItems.service,
        totalAmount: sql<number>`SUM(${billItems.amount})`,
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(
        sql`(${bills.provider}, ${bills.billingPeriod}) IN (${sql.raw(
          periodFilter.map((p) => `('${p.provider}', '${p.period}')`).join(", ")
        )})`
      )
      .groupBy(bills.provider, billItems.service)
      .orderBy(sql`SUM(${billItems.amount}) DESC`)
      .all();

    const displayPeriod = periodParam ?? periodFilter.reduce((a, b) => (a.period > b.period ? a : b)).period;

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

    return NextResponse.json({ billingPeriod: displayPeriod, services: result });
  } catch (error) {
    console.error("[API] Resource scan services error:", error);
    return NextResponse.json({ error: "Failed to get services" }, { status: 500 });
  }
}
