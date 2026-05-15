/**
 * RDS Discoverer — discovers Amazon RDS database instances across configured regions.
 * Iterates over each configured region, calling DescribeDBInstances and enriching
 * results with tags via ListTagsForResource.
 */
import {
  RDSClient,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-rds";
import type {
  ResourceDiscoverer,
  DiscoveredResource,
  ProviderCredentials,
} from "../types";

/**
 * Maps RDS DBInstanceStatus to a normalised status string.
 * "available" → "running", "stopped" → "stopped",
 * transitional states → "pending", terminal states → "terminated".
 */
function mapRdsStatus(status: string | undefined): string {
  switch (status) {
    case "available":
      return "running";
    case "stopped":
      return "stopped";
    case "deleting":
    case "deleted":
      return "terminated";
    case "creating":
    case "starting":
    case "rebooting":
    case "modifying":
      return "pending";
    default:
      return status ?? "unknown";
  }
}

export class RdsDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "rds";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Relational Database Service"];

  async discover(
    credentials: ProviderCredentials,
  ): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];
    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new RDSClient({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(
          new DescribeDBInstancesCommand({}),
        );

        for (const db of result.DBInstances ?? []) {
          let tags: Record<string, string> = {};
          let name = db.DBInstanceIdentifier ?? "";

          // Attempt to fetch tags; non-critical so failures are swallowed
          if (db.DBInstanceArn) {
            try {
              const tagResult = await client.send(
                new ListTagsForResourceCommand({
                  ResourceName: db.DBInstanceArn,
                }),
              );
              for (const tag of tagResult.TagList ?? []) {
                if (tag.Key && tag.Value) {
                  tags[tag.Key] = tag.Value;
                  if (tag.Key === "Name") name = tag.Value;
                }
              }
            } catch {
              /* Tags are optional — continue without them */
            }
          }

          resources.push({
            provider: "aws",
            resourceId: db.DBInstanceIdentifier ?? "",
            resourceName: name,
            resourceType: "rds",
            region,
            spec: `${db.Engine ?? "unknown"} ${db.DBInstanceClass ?? "unknown"}`,
            tags,
            status: mapRdsStatus(db.DBInstanceStatus),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[RDS Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
