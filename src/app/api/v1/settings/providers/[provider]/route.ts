/**
 * Settings provider CRUD API — update a specific provider's configuration.
 */
import { NextRequest, NextResponse } from "next/server";
import { upsertProviderSetting, getConfigSource } from "@/services/settings";
import { PROVIDER_REGISTRY } from "@/providers/registry";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

/** PUT /api/v1/settings/providers/[provider] — create or update provider settings */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { provider } = await params;

    // Validate provider exists in registry
    if (!PROVIDER_REGISTRY[provider]) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { enabled, credentials } = body;

    // Validate input types
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }

    // Validate credentials: must be a plain object with string values, or null
    if (credentials !== undefined && credentials !== null) {
      if (typeof credentials !== "object" || Array.isArray(credentials)) {
        return NextResponse.json(
          { error: "credentials must be an object or null" },
          { status: 400 }
        );
      }
      const hasInvalidValues = Object.values(credentials).some((v) => typeof v !== "string");
      if (hasInvalidValues) {
        return NextResponse.json(
          { error: "All credential values must be strings" },
          { status: 400 }
        );
      }
    }

    const row = upsertProviderSetting(provider, { enabled, credentials });

    // Determine effective config source from service (DB > env > none)
    const configSource = getConfigSource(provider);

    return NextResponse.json({
      success: true,
      provider,
      enabled: row.enabled,
      configSource,
    });
  } catch (error) {
    console.error("[API] Settings PUT error:", error);
    return NextResponse.json({ error: "Failed to update provider settings" }, { status: 500 });
  }
}
