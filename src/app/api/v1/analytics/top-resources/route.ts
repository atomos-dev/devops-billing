/**
 * Analytics Top Resources API — returns top N resources by cost for a billing period.
 * Requires ?period=YYYY-MM. Optional ?limit=N (default 10) and ?provider=xxx.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTopResources } from "@/services/billing";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const period = params.get("period");
  const limit = parseInt(params.get("limit") || "10", 10);
  const provider = params.get("provider") || undefined;

  if (!period) {
    return NextResponse.json(
      { error: "Missing required parameter: period" },
      { status: 400 }
    );
  }

  try {
    const resources = getTopResources(period, limit, provider);
    return NextResponse.json({ resources });
  } catch (error) {
    console.error("[API] Analytics top-resources error:", error);
    return NextResponse.json(
      { error: "Failed to fetch top resources" },
      { status: 500 }
    );
  }
}
