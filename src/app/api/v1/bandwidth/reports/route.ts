/**
 * Bandwidth Reports API — import DO CSV data and query per-resource bandwidth.
 *
 * POST: Import CSV content for a billing period
 * GET:  Query bandwidth reports by period, optionally filtered by resource
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bandwidthReports, resources } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";

/** POST — import bandwidth CSV data */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { billingPeriod, csvContent } = body;

    if (!billingPeriod || !csvContent) {
      return NextResponse.json(
        { error: "billingPeriod and csvContent are required" },
        { status: 400 }
      );
    }

    // Parse CSV
    const lines = csvContent.trim().split("\n");
    if (lines.length < 2) {
      return NextResponse.json({ error: "CSV is empty" }, { status: 400 });
    }

    // Skip header: Team Name,Team UUID,Region,Product,Resource ID,Resource UUID,Bandwidth Usage (GiB)
    const records = lines.slice(1).map((line: string) => {
      const parts = line.split(",");
      return {
        region: parts[2]?.trim() || null,
        product: parts[3]?.trim() || null,
        resourceId: parts[4]?.trim() || parts[5]?.trim() || "",
        bandwidthGib: parseFloat(parts[6]) || 0,
      };
    }).filter((r: { resourceId: string }) => r.resourceId);

    // Upsert into bandwidth_reports
    let imported = 0;
    db.transaction((tx) => {
      for (const r of records) {
        tx.insert(bandwidthReports)
          .values({
            billingPeriod,
            provider: "digitalocean",
            resourceId: r.resourceId,
            region: r.region,
            product: r.product,
            bandwidthGib: r.bandwidthGib,
          })
          .onConflictDoUpdate({
            target: [bandwidthReports.billingPeriod, bandwidthReports.provider, bandwidthReports.resourceId],
            set: {
              region: r.region,
              product: r.product,
              bandwidthGib: r.bandwidthGib,
              importedAt: new Date().toISOString(),
            },
          })
          .run();
        imported++;
      }
    });

    return NextResponse.json({
      imported,
      billingPeriod,
      totalBandwidthGib: Math.round(records.reduce((s: number, r: { bandwidthGib: number }) => s + r.bandwidthGib, 0) * 100) / 100,
    });
  } catch (error) {
    console.error("[API] Bandwidth report import error:", error);
    return NextResponse.json({ error: "Failed to import bandwidth report" }, { status: 500 });
  }
}

/** GET — query bandwidth reports, enriched with resource names */
export async function GET(request: NextRequest) {
  try {
    const period = request.nextUrl.searchParams.get("period");

    if (!period) {
      // Return available periods
      const periods = db
        .select({
          billingPeriod: bandwidthReports.billingPeriod,
          totalGib: sql<number>`ROUND(SUM(${bandwidthReports.bandwidthGib}), 2)`,
          resourceCount: sql<number>`COUNT(*)`,
        })
        .from(bandwidthReports)
        .groupBy(bandwidthReports.billingPeriod)
        .orderBy(sql`${bandwidthReports.billingPeriod} DESC`)
        .all();

      return NextResponse.json({ periods });
    }

    // Get reports for a specific period, joined with resource names
    const reports = db
      .select({
        resourceId: bandwidthReports.resourceId,
        region: bandwidthReports.region,
        product: bandwidthReports.product,
        bandwidthGib: bandwidthReports.bandwidthGib,
        resourceName: resources.resourceName,
        resourceType: resources.resourceType,
        spec: resources.spec,
        status: resources.status,
      })
      .from(bandwidthReports)
      .leftJoin(
        resources,
        and(
          eq(bandwidthReports.resourceId, resources.resourceId),
          eq(resources.provider, "digitalocean")
        )
      )
      .where(eq(bandwidthReports.billingPeriod, period))
      .orderBy(sql`${bandwidthReports.bandwidthGib} DESC`)
      .all();

    const totalGib = reports.reduce((s, r) => s + r.bandwidthGib, 0);

    return NextResponse.json({
      billingPeriod: period,
      totalBandwidthGib: Math.round(totalGib * 100) / 100,
      resources: reports,
    });
  } catch (error) {
    console.error("[API] Bandwidth report query error:", error);
    return NextResponse.json({ error: "Failed to query bandwidth reports" }, { status: 500 });
  }
}
