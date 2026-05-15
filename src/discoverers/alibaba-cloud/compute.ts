/**
 * Alibaba Cloud compute discoverer — discovers ECS and SWAS instances
 * by delegating to AlibabaProvider.fetchResources().
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";
import { AlibabaProvider } from "@/providers/alibaba";

export class AlibabaComputeDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "alibaba_compute";
  readonly provider = "alibaba-cloud" as const;
  /** Billing service names from BSS DescribeInstanceBill (中文=中国站, 英文=国际站) */
  readonly billingServiceNames = [
    "云服务器 ECS", "Elastic Compute Service",
    "轻量应用服务器", "Simple Application Server",
  ];
  readonly resourceTypes = ["ecs", "swas"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "alibaba-cloud") return [];

    const provider = new AlibabaProvider({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      site: credentials.site,
      regionId: credentials.regionId,
    });

    const resources = await provider.fetchResources();

    return resources.map((r) => ({
      provider: "alibaba-cloud" as const,
      resourceId: r.resourceId,
      resourceName: r.resourceName ?? "",
      resourceType: r.resourceType ?? "ecs",
      region: r.region ?? credentials.regionId,
      spec: r.spec ?? null,
      tags: r.tags ?? {},
      status: r.status ?? "unknown",
      monthlyBaseCost: r.monthlyBaseCost ?? null,
      publicIp: r.publicIp,
      privateIp: r.privateIp,
    }));
  }
}
