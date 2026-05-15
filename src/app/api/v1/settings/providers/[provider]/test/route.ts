/**
 * Provider connection test API — validates credentials by calling testConnection().
 * Supports testing with temporary credentials (not yet saved) or saved credentials.
 */
import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_REGISTRY } from "@/providers/registry";
import { getEffectiveCredentials, updateTestResult } from "@/services/settings";
import { AwsProvider } from "@/providers/aws";
import { DigitalOceanProvider } from "@/providers/digitalocean";
import { AlibabaProvider } from "@/providers/alibaba";
import type { BillingProvider } from "@/providers/types";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

/** Create a temporary provider instance for connection testing */
function createTestProvider(providerKey: string, config: Record<string, unknown>): BillingProvider | null {
  switch (providerKey) {
    case "aws":
      return new AwsProvider(config as any);
    case "digitalocean":
      return new DigitalOceanProvider(config as any);
    case "alibaba-cloud":
      return new AlibabaProvider(config as any);
    default:
      return null;
  }
}

/** POST /api/v1/settings/providers/[provider]/test — test connection */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { provider: providerKey } = await params;

    const meta = PROVIDER_REGISTRY[providerKey];
    if (!meta) {
      return NextResponse.json(
        { success: false, message: `Unknown provider: ${providerKey}` },
        { status: 400 }
      );
    }

    // Check if request contains temporary credentials for testing
    const body = await request.json().catch(() => ({}));
    let creds: Record<string, string> | null = null;

    if (
      body.credentials &&
      typeof body.credentials === "object" &&
      !Array.isArray(body.credentials) &&
      Object.values(body.credentials).every((v) => typeof v === "string")
    ) {
      // Use provided temporary credentials for testing
      creds = body.credentials;
    } else {
      // Use saved credentials (DB or env)
      creds = getEffectiveCredentials(providerKey);
    }

    if (!creds) {
      return NextResponse.json({
        success: false,
        message: "No credentials available. Configure credentials first.",
      });
    }

    // Transform and create temporary provider
    const config = meta.toProviderConfig(creds);
    const testProvider = createTestProvider(providerKey, config);

    if (!testProvider) {
      return NextResponse.json({
        success: false,
        message: `No test implementation for provider: ${providerKey}`,
      });
    }

    // Run connection test
    const success = await testProvider.testConnection();
    updateTestResult(providerKey, success);

    return NextResponse.json({
      success,
      message: success ? "Connection successful" : "Connection failed — check credentials",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API] Connection test error:", msg);
    return NextResponse.json({
      success: false,
      message: `Connection test failed: ${msg}`,
    });
  }
}
