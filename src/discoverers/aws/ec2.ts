/**
 * EC2 Discoverer — wraps AwsProvider.fetchResources() to reuse
 * existing EC2 instance discovery and pricing logic.
 */
import type { ResourceDiscoverer, DiscoveredResource, ProviderCredentials } from "../types";
import { AwsProvider } from "@/providers/aws";

export class Ec2Discoverer implements ResourceDiscoverer {
  readonly serviceKey = "ec2";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Elastic Compute Cloud - Compute"];

  async discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const awsProvider = new AwsProvider({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region: credentials.region,
      resourceRegions: credentials.resourceRegions,
    });

    const resources = await awsProvider.fetchResources();

    return resources.map((r) => ({
      provider: "aws" as const,
      resourceId: r.resourceId,
      resourceName: r.resourceName ?? "",
      resourceType: "ec2",
      region: r.region ?? credentials.region,
      spec: r.spec ?? null,
      tags: r.tags ?? {},
      status: r.status ?? "unknown",
      monthlyBaseCost: r.monthlyBaseCost ?? null,
      publicIp: r.publicIp,
      privateIp: r.privateIp,
    }));
  }
}
