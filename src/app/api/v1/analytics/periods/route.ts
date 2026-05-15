/**
 * Analytics Periods API — returns available billing periods from the bills table.
 */
import { NextResponse } from "next/server";
import { getBills } from "@/services/billing";

export async function GET() {
  try {
    const allBills = getBills();
    // Deduplicate billing periods and sort descending
    const periods = [...new Set(allBills.map((b) => b.billingPeriod))].sort(
      (a, b) => b.localeCompare(a)
    );
    return NextResponse.json({ periods });
  } catch (error) {
    console.error("[API] Analytics periods error:", error);
    return NextResponse.json(
      { error: "Failed to fetch periods" },
      { status: 500 }
    );
  }
}
