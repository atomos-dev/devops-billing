/**
 * NAT Gateway Discoverer — discovers Amazon VPC NAT Gateways across configured regions.
 * Uses DescribeNatGatewaysCommand and filters out deleted gateways.
 */
import {
  EC2Client,
  DescribeNatGatewaysCommand,
} from "@aws-sdk/client-ec2";
import type {
  ResourceDiscoverer,
  DiscoveredResource,
  ProviderCredentials,
} from "../types";

/**
 * Maps NAT Gateway State to a normalised status.
 * "available" → "running"; other states are passed through as-is.
 */
function mapNatGatewayStatus(state: string | undefined): string {
  if (state === "available") return "running";
  return state ?? "unknown";
}

export class NatGatewayDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "nat_gateway";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Virtual Private Cloud"];

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
          new DescribeNatGatewaysCommand({}),
        );

        for (const gw of result.NatGateways ?? []) {
          // Skip deleted gateways — they are no longer billable
          if (gw.State === "deleted") continue;

          // Extract Name tag from inline Tags array
          let name = "";
          const tags: Record<string, string> = {};
          for (const tag of gw.Tags ?? []) {
            if (tag.Key && tag.Value) {
              tags[tag.Key] = tag.Value;
              if (tag.Key === "Name") name = tag.Value;
            }
          }

          resources.push({
            provider: "aws",
            resourceId: gw.NatGatewayId ?? "",
            resourceName: name,
            resourceType: "nat_gateway",
            region,
            spec: gw.ConnectivityType ?? "unknown",
            tags,
            status: mapNatGatewayStatus(gw.State),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(
          `[NAT Gateway Discoverer] Failed in ${region}:`,
          error,
        );
      }
    }

    return resources;
  }
}
