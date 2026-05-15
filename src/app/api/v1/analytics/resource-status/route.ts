/**
 * Analytics Resource Status API — returns resource counts grouped by status and provider.
 * Optional ?provider=xxx filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider") || undefined;

  try {
    const conditions = provider ? [eq(resources.provider, provider)] : [];

    const rows = db
      .select({
        provider: resources.provider,
        status: resources.status,
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(resources)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(resources.provider, resources.status)
      .orderBy(resources.provider, resources.status)
      .all();

    return NextResponse.json({ statusBreakdown: rows });
  } catch (error) {
    console.error("[API] Analytics resource-status error:", error);
    return NextResponse.json(
      { error: "Failed to fetch resource status" },
      { status: 500 }
    );
  }
}
