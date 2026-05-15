/**
 * ELB Discoverer — discovers Amazon Elastic Load Balancers (v2) across configured regions.
 * Uses DescribeLoadBalancers + DescribeTagsCommand (batched by 20 ARNs) to
 * enumerate ALB / NLB / GWLB resources and their tags.
 */
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type {
  ResourceDiscoverer,
  DiscoveredResource,
  ProviderCredentials,
} from "../types";

/** Max ARNs per DescribeTagsCommand call (AWS hard limit is 20) */
const TAG_BATCH_SIZE = 20;

/**
 * Extracts the resource path portion from an ELB ARN.
 * e.g. "arn:aws:elasticloadbalancing:us-east-1:123456:loadbalancer/app/my-alb/abc123"
 *   → "app/my-alb/abc123"
 */
function extractResourceId(arn: string): string {
  const marker = "loadbalancer/";
  const idx = arn.indexOf(marker);
  return idx >= 0 ? arn.slice(idx + marker.length) : arn;
}

export class ElbDiscoverer implements ResourceDiscoverer {
  readonly serviceKey = "elb";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Elastic Load Balancing"];

  async discover(
    credentials: ProviderCredentials,
  ): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];
    const resources: DiscoveredResource[] = [];

    for (const region of credentials.resourceRegions) {
      try {
        const client = new ElasticLoadBalancingV2Client({
          region,
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        });

        const result = await client.send(
          new DescribeLoadBalancersCommand({}),
        );
        const lbs = result.LoadBalancers ?? [];
        if (lbs.length === 0) continue;

        // Batch-fetch tags for all load balancers in this region
        const arnToTags: Record<string, Record<string, string>> = {};
        const arns = lbs
          .map((lb) => lb.LoadBalancerArn)
          .filter((a): a is string => !!a);

        for (let i = 0; i < arns.length; i += TAG_BATCH_SIZE) {
          const batch = arns.slice(i, i + TAG_BATCH_SIZE);
          try {
            const tagResult = await client.send(
              new DescribeTagsCommand({ ResourceArns: batch }),
            );
            for (const desc of tagResult.TagDescriptions ?? []) {
              if (!desc.ResourceArn) continue;
              const tags: Record<string, string> = {};
              for (const tag of desc.Tags ?? []) {
                if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
              }
              arnToTags[desc.ResourceArn] = tags;
            }
          } catch {
            /* Tag fetch is best-effort */
          }
        }

        for (const lb of lbs) {
          const arn = lb.LoadBalancerArn ?? "";
          const tags = arnToTags[arn] ?? {};
          const name = tags["Name"] ?? lb.LoadBalancerName ?? "";
          const stateCode = lb.State?.Code;

          resources.push({
            provider: "aws",
            resourceId: extractResourceId(arn),
            resourceName: name,
            resourceType: "elb",
            region,
            spec: `${lb.Type ?? "unknown"} ${lb.Scheme ?? "unknown"}`,
            tags,
            status: stateCode === "active" ? "running" : (stateCode ?? "unknown"),
            monthlyBaseCost: null,
          });
        }
      } catch (error) {
        console.error(`[ELB Discoverer] Failed in ${region}:`, error);
      }
    }

    return resources;
  }
}
