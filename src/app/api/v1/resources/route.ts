/**
 * Resources API — list discovered cloud resources.
 * Used by the resource-scan page to display per-service resource details.
 */
import { NextRequest, NextResponse } from "next/server";
import { getResources } from "@/services/billing";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const resources = getResources({
      provider: sp.get("provider") ?? undefined,
      search: sp.get("search") ?? undefined,
      category: sp.get("category") ?? undefined,
      region: sp.get("region") ?? undefined,
    });
    return NextResponse.json({ resources });
  } catch (error) {
    console.error("[API] Resources error:", error);
    return NextResponse.json({ error: "Failed to fetch resources" }, { status: 500 });
  }
}
