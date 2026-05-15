/**
 * Volume Discoverer — discovers DigitalOcean block storage volumes.
 * Queries the DO /v2/volumes API with pagination and maps each volume
 * to a DiscoveredResource with size/filesystem spec and attachment status.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";

const DO_API_BASE = "https://api.digitalocean.com/v2";

export class VolumeDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "volume";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Volumes"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];
    const resources: DiscoveredResource[] = [];

    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`${DO_API_BASE}/volumes?page=${page}&per_page=100`, {
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) break;
        const data = await res.json();

        for (const vol of data.volumes ?? []) {
          const tags: Record<string, string> = {};
          for (const tag of vol.tags ?? []) {
            // DO tags are flat strings; parse key:value format if present
            const parts = tag.split(":");
            if (parts.length === 2) {
              tags[parts[0]] = parts[1];
            } else {
              tags[tag] = "true";
            }
          }

          const dropletIds = vol.droplet_ids ?? [];
          resources.push({
            provider: "digitalocean",
            resourceId: vol.id ?? "",
            resourceName: vol.name ?? "",
            resourceType: "volume",
            region: vol.region?.slug ?? "unknown",
            spec: `${vol.size_gigabytes ?? 0}GiB ${vol.filesystem_type ?? "unknown"}`,
            tags,
            // Derive status from whether the volume is attached to any droplet
            status: dropletIds.length > 0 ? "attached" : "unattached",
            monthlyBaseCost: null,
          });
        }

        const totalPages = Math.ceil((data.meta?.total ?? 0) / 100);
        hasMore = page < totalPages;
        page++;
      }
    } catch (error) {
      console.error("[Volume Discoverer] Failed:", error);
    }

    return resources;
  }
}
