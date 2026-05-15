/**
 * Existing Resources Discoverer — wraps DigitalOceanProvider.fetchResources()
 * to reuse existing Droplet and Load Balancer discovery logic.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";
import { DigitalOceanProvider } from "@/providers/digitalocean";

export class ExistingResourcesDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "do_existing";
  readonly provider = "digitalocean" as const;
  readonly billingServiceNames = ["Droplets", "Load Balancers"];
  readonly resourceTypes = ["droplet", "load_balancer"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "digitalocean") return [];

    const doProvider = new DigitalOceanProvider({ apiToken: credentials.apiToken });
    const resources = await doProvider.fetchResources();

    return resources.map((r) => ({
      provider: "digitalocean" as const,
      resourceId: r.resourceId,
      resourceName: r.resourceName ?? "",
      resourceType: r.resourceType ?? "unknown",
      region: r.region ?? "unknown",
      spec: r.spec ?? null,
      tags: r.tags ?? {},
      status: r.status ?? "unknown",
      monthlyBaseCost: r.monthlyBaseCost ?? null,
      bandwidthAllowanceTib: r.bandwidthAllowanceTib,
      publicIp: r.publicIp,
      privateIp: r.privateIp,
    }));
  }
}
