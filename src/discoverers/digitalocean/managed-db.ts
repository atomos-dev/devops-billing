/**
 * Managed Database Discoverer — discovers DigitalOcean managed database clusters.
 * Queries the DO /v2/databases API with pagination and maps each cluster
 * to a DiscoveredResource with engine/size/node-count spec.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

const DO_API_BASE = "https://api.digitalocean.com/v2";

export class ManagedDbDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "managed_db";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Managed Databases"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];
    const resources: DiscoveredResource[] = [];

    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`${DO_API_BASE}/databases?page=${page}&per_page=100`, {
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) break;
        const data = await res.json();

        for (const db of data.databases ?? []) {
          const tags: Record<string, string> = {};
          for (const tag of db.tags ?? []) {
            // DO tags are flat strings; parse key:value format if present
            const parts = tag.split(":");
            if (parts.length === 2) {
              tags[parts[0]] = parts[1];
            } else {
              tags[tag] = "true";
            }
          }

          resources.push({
            provider: "digitalocean",
            resourceId: db.id ?? "",
            resourceName: db.name ?? "",
            resourceType: "managed_db",
            region: db.region ?? "unknown",
            spec: `${db.engine ?? "unknown"} ${db.size_slug ?? "unknown"} ${db.num_nodes ?? 1}-node`,
            tags,
            // Map "online" → "running" for consistency with other discoverers
            status: db.status === "online" ? "running" : (db.status ?? "unknown"),
            monthlyBaseCost: null,
          });
        }

        const totalPages = Math.ceil((data.meta?.total ?? 0) / 100);
        hasMore = page < totalPages;
        page++;
      }
    } catch (error) {
      console.error("[Managed DB Discoverer] Failed:", error);
    }

    return resources;
  }
}
