/**
 * Summary API — returns monthly billing overview with auto + manual costs.
 */
import { NextRequest, NextResponse } from "next/server";
import { getMonthlySummary } from "@/services/billing";

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month") || undefined;

  try {
    const summary = getMonthlySummary(month);
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[API] Summary error:", error);
    return NextResponse.json(
      { error: "Failed to fetch summary" },
      { status: 500 }
    );
  }
}
