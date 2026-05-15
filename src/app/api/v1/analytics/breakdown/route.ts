/**
 * Analytics Breakdown API — returns cost breakdown by service, region, or category.
 * Requires ?period=YYYY-MM&dimension=service|region|category.
 * Optional ?provider=xxx filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCostBreakdown } from "@/services/billing";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const period = params.get("period");
  const dimension = params.get("dimension") as "service" | "region" | "category" | null;
  const provider = params.get("provider") || undefined;

  if (!period || !dimension || !["service", "region", "category"].includes(dimension)) {
    return NextResponse.json(
      { error: "Missing or invalid required parameters: period, dimension (service|region|category)" },
      { status: 400 }
    );
  }

  try {
    const breakdown = getCostBreakdown(period, dimension, provider);
    return NextResponse.json({ breakdown });
  } catch (error) {
    console.error("[API] Analytics breakdown error:", error);
    return NextResponse.json(
      { error: "Failed to fetch breakdown" },
      { status: 500 }
    );
  }
}
