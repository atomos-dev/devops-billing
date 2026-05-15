/**
 * Sync API — trigger manual sync, check status.
 */
import { NextRequest, NextResponse } from "next/server";
import { createProviders } from "@/providers";
import { syncProvider, syncAll } from "@/services/sync";
import { getProviderSyncStatus } from "@/services/billing";

/** POST — trigger sync (all providers or specific one) */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const targetProvider = body.provider as string | undefined;
    const backfillMonths = parseInt(
      process.env.SYNC_BACKFILL_MONTHS || "6",
      10
    );

    const providers = createProviders();

    if (targetProvider) {
      const provider = providers.get(targetProvider);
      if (!provider) {
        return NextResponse.json(
          { error: `Provider "${targetProvider}" not found or not enabled` },
          { status: 404 }
        );
      }
      const result = await syncProvider(provider, "manual", backfillMonths);
      return NextResponse.json({ result });
    }

    const results = await syncAll(providers, "manual", backfillMonths);
    return NextResponse.json({ results });
  } catch (error) {
    console.error("[API] Sync error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}

/** GET — check sync status */
export async function GET() {
  try {
    const status = getProviderSyncStatus();
    const statusObj: Record<string, unknown> = {};
    for (const [key, value] of status) {
      statusObj[key] = value;
    }
    return NextResponse.json({ status: statusObj });
  } catch (error) {
    console.error("[API] Sync status error:", error);
    return NextResponse.json({ error: "Failed to get sync status" }, { status: 500 });
  }
}
