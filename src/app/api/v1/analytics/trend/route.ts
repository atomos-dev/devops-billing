/**
 * Analytics Trend API — returns monthly cost trend data.
 *
 * Query params:
 *   ?months=N        — number of months (default 6)
 *   ?provider=xxx    — filter by provider
 *   ?groupBy=provider|service|region|category — grouping dimension (default: provider)
 *
 * When groupBy=provider (default), returns provider-level trend excluding manual costs.
 * When groupBy=service|region|category, returns dimension-level trend via getDimensionTrend.
 */
import { NextRequest, NextResponse } from "next/server";
import { getMonthlyTrend, getDimensionTrend } from "@/services/billing";

const VALID_DIMENSIONS = ["service", "region", "category"] as const;
type Dimension = (typeof VALID_DIMENSIONS)[number];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const months = parseInt(params.get("months") || "6", 10);
  const provider = params.get("provider") || undefined;
  const groupBy = params.get("groupBy") || "provider";

  try {
    // Dimension-level trend (service / region / category)
    if (VALID_DIMENSIONS.includes(groupBy as Dimension)) {
      const items = getDimensionTrend(months, groupBy as Dimension, provider);
      return NextResponse.json({ trend: items, groupBy });
    }

    // Default: provider-level trend, excluding manual costs
    const trend = getMonthlyTrend(months);
    const filtered = trend.map((m) => ({
      month: m.month,
      providers: m.providers
        .filter((p) => !p.isManual)
        .filter((p) => !provider || p.provider === provider),
      total: m.providers
        .filter((p) => !p.isManual)
        .filter((p) => !provider || p.provider === provider)
        .reduce((sum, p) => sum + p.amount, 0),
    }));

    return NextResponse.json({ trend: filtered, groupBy: "provider" });
  } catch (error) {
    console.error("[API] Analytics trend error:", error);
    return NextResponse.json(
      { error: "Failed to fetch trend" },
      { status: 500 }
    );
  }
}
