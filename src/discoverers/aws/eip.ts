/**
 * EIP Discoverer — discovers Elastic IP addresses across configured regions.
 * Uses DescribeAddressesCommand from the EC2 client.
 */
import {
  EC2Client,
  DescribeAddressesCommand,
} from "@aws-sdk/client-ec2";
import type {
  ResourceDiscoverer,
  DiscoveredResource,
  ProviderCredentials,
} from "../types";

export class EipDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "eip";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["EC2 - Other"];

  async discover(
    credentials: ProviderCredentials,
  ): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];
    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new EC2Client({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(
          new DescribeAddressesCommand({}),
        );

        for (const addr of result.Addresses ?? []) {
          // Extract Name tag from inline Tags array
          let name = "";
          const tags: Record<string, string> = {};
          for (const tag of addr.Tags ?? []) {
            if (tag.Key && tag.Value) {
              tags[tag.Key] = tag.Value;
              if (tag.Key === "Name") name = tag.Value;
            }
          }

          // Fall back to PublicIp when no Name tag is present
          if (!name) name = addr.PublicIp ?? "";

          resources.push({
            provider: "aws",
            resourceId: addr.AllocationId ?? "",
            resourceName: name,
            resourceType: "eip",
            region,
            spec: addr.Domain ?? "unknown",
            tags,
            status: addr.AssociationId ? "associated" : "unassociated",
            monthlyBaseCost: null,
            publicIp: addr.PublicIp || undefined,
            privateIp: addr.PrivateIpAddress || undefined,
          });
        }
      } catch (error) {
        console.error(`[EIP Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
