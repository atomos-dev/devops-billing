/**
 * Resource Scan API — trigger scans and query scan status/history.
 *
 * Routes:
 *   GET  /api/v1/resource-scan  — current scan status + recent scan history
 *   POST /api/v1/resource-scan  — trigger a resource scan (optionally for a single provider)
 */
import { NextRequest, NextResponse } from "next/server";
import { scanOrchestrator } from "@/discoverers/scan-orchestrator";

/** GET — query current scan status and recent scan history */
export async function GET() {
  try {
    const status = scanOrchestrator.getScanStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("[API] Resource scan status error:", error);
    return NextResponse.json({ error: "Failed to get scan status" }, { status: 500 });
  }
}

/** POST — trigger a resource scan (optionally for a single provider) */
export async function POST(request: NextRequest) {
  try {
    let provider: string | undefined;
    try {
      const body = await request.json();
      provider = body.provider;
    } catch {
      // No body or invalid JSON — scan all providers
    }

    const result = await scanOrchestrator.startScan(provider);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    return NextResponse.json({
      scanId: result.scanId,
      status: "running",
      message: "Resource scan started",
    });
  } catch (error) {
    console.error("[API] Resource scan trigger error:", error);
    return NextResponse.json({ error: "Failed to start scan" }, { status: 500 });
  }
}
