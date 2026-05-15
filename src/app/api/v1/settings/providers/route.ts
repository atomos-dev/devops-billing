/**
 * Settings providers list API — returns all provider configurations (credentials redacted).
 */
import { NextResponse } from "next/server";
import { getAllProviderSettings } from "@/services/settings";

/** GET /api/v1/settings/providers — list all provider settings */
export async function GET() {
  try {
    const providers = getAllProviderSettings();
    return NextResponse.json({ providers });
  } catch (error) {
    console.error("[API] Settings GET error:", error);
    return NextResponse.json({ error: "Failed to load provider settings" }, { status: 500 });
  }
}
