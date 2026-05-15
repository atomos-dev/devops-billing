/**
 * Idle Resources API — returns non-active resources that still incur cost.
 * Surfaces stopped, terminated, and unassociated resources for the
 * "needs attention" panel on the Cost Analytics page.
 * Optional ?provider=xxx filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { getIdleResources } from "@/services/billing";

export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider") || undefined;

  try {
    const idle = getIdleResources(provider);
    const totalWaste = idle.reduce((sum, r) => sum + r.monthlyCost, 0);

    return NextResponse.json({
      resources: idle,
      count: idle.length,
      totalMonthlyCost: Math.round(totalWaste * 100) / 100,
    });
  } catch (error) {
    console.error("[API] Idle resources error:", error);
    return NextResponse.json(
      { error: "Failed to fetch idle resources" },
      { status: 500 }
    );
  }
}
