/**
 * AWS Billing Provider — fetches cost data via Cost Explorer,
 * resource metadata via EC2 DescribeInstances,
 * and on-demand pricing via AWS Pricing API.
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
  type GetCostAndUsageCommandInput,
  type GroupDefinition,
} from "@aws-sdk/client-cost-explorer";
import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  PricingClient,
  GetProductsCommand,
} from "@aws-sdk/client-pricing";
import type { BillingProvider, BillData, BillItemData, ResourceData } from "./types";

interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  resourceRegions: string[];
}

const RESOURCE_LEVEL_COVERAGE_THRESHOLD = 0.9;

/**
 * AWS services eligible for resource-level Cost Explorer breakdown.
 * GetCostAndUsageWithResources requires a SERVICE filter, so we query
 * each service independently and replace aggregated rows when coverage ≥ 90%.
 */
const RESOURCE_LEVEL_SERVICES = [
  "Amazon Elastic Compute Cloud - Compute",
  "Amazon Relational Database Service",
  "Amazon Elastic Container Service for Kubernetes",
  "Amazon Elastic Load Balancing",
  "EC2 - Other",
];

export class AwsProvider implements BillingProvider {
  readonly name = "aws";
  readonly displayName = "Amazon Web Services";
  private ceClient: CostExplorerClient;
  private pricingClient: PricingClient;
  private config: AwsConfig;

  constructor(config: AwsConfig) {
    this.config = config;
    this.ceClient = new CostExplorerClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    // Pricing API is only available in us-east-1 and ap-south-1
    this.pricingClient = new PricingClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 2);
      await this.ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: {
            Start: formatDate(start),
            End: formatDate(end),
          },
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async fetchBills(start: Date, end: Date): Promise<BillData[]> {
    const bills: BillData[] = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth() + 1, 1);

    while (current < endMonth) {
      const periodStart = new Date(current);
      const periodEnd = new Date(current.getFullYear(), current.getMonth() + 1, 1);
      const billingPeriod = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;

      try {
        const result = await this.ceClient.send(
          new GetCostAndUsageCommand({
            TimePeriod: {
              Start: formatDate(periodStart),
              End: formatDate(periodEnd),
            },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
          })
        );

        const totalAmount = parseFloat(
          result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || "0"
        );

        bills.push({
          provider: this.name,
          billingPeriod,
          totalAmount,
          rawData: JSON.stringify(result.ResultsByTime?.[0]),
        });
      } catch (error) {
        console.error(`[AWS] Failed to fetch bill for ${billingPeriod}:`, error);
      }

      current.setMonth(current.getMonth() + 1);
    }

    return bills;
  }

  async fetchBillItems(billingPeriod: string): Promise<BillItemData[]> {
    const [year, month] = billingPeriod.split("-").map(Number);
    const periodStart = new Date(year, month - 1, 1);
    const periodEnd = new Date(year, month, 1);
    const items: BillItemData[] = [];

    // Fetch by service
    const byService = await this.getCostGroupedBy(
      periodStart,
      periodEnd,
      [{ Type: "DIMENSION", Key: "SERVICE" }]
    );
    for (const group of byService) {
      const service = group.keys[0] || "Unknown";
      if (group.amount > 0) {
        items.push({
          service,
          amount: group.amount,
          usageUnit: "USD",
        });
      }
    }

    // Fetch by service + region for region breakdown
    const byServiceRegion = await this.getCostGroupedBy(
      periodStart,
      periodEnd,
      [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "REGION" },
      ]
    );
    // Replace flat service items with region-level detail
    if (byServiceRegion.length > 0) {
      items.length = 0;
      for (const group of byServiceRegion) {
        const service = group.keys[0] || "Unknown";
        const region = group.keys[1] || "global";
        if (group.amount > 0) {
          items.push({
            service,
            region,
            amount: group.amount,
            usageUnit: "USD",
          });
        }
      }
    }

    // GetCostAndUsageWithResources enforces a hard 14-day lookback limit.
    // Only attempt resource-level breakdown for the current (incomplete) month.
    const daysSinceStart = Math.floor((Date.now() - periodStart.getTime()) / 86400000);
    if (daysSinceStart > 14) {
      return items;
    }

    // Try resource-level breakdown for each eligible service
    let result = items;
    for (const serviceName of RESOURCE_LEVEL_SERVICES) {
      const fallbackItems = result.filter((item) => item.service === serviceName);
      if (fallbackItems.length === 0) continue;

      const resourceItems = await this.getResourceLevelItems(serviceName, periodStart, periodEnd);
      if (resourceItems.length === 0) continue;

      const fallbackTotal = fallbackItems.reduce((sum, item) => sum + item.amount, 0);
      const resourceTotal = resourceItems.reduce((sum, item) => sum + item.amount, 0);
      const coverageRatio = fallbackTotal > 0 ? resourceTotal / fallbackTotal : 0;

      if (coverageRatio < RESOURCE_LEVEL_COVERAGE_THRESHOLD) {
        console.warn(
          `[AWS] Resource-level CE coverage for ${serviceName} in ${billingPeriod} is only ${(coverageRatio * 100).toFixed(0)}%; keeping aggregated rows`
        );
        continue;
      }

      result = [
        ...result.filter((item) => item.service !== serviceName),
        ...resourceItems,
      ];
    }

    return result;
  }

  async fetchResources(): Promise<ResourceData[]> {
    const resources: ResourceData[] = [];

    for (const region of this.config.resourceRegions) {
      try {
        const ec2Client = new EC2Client({
          region,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
        });

        let nextToken: string | undefined;
        do {
          const result = await ec2Client.send(
            new DescribeInstancesCommand({ NextToken: nextToken })
          );

          for (const reservation of result.Reservations || []) {
            for (const instance of reservation.Instances || []) {
              const tags: Record<string, string> = {};
              let name = "";
              for (const tag of instance.Tags || []) {
                if (tag.Key && tag.Value) {
                  tags[tag.Key] = tag.Value;
                  if (tag.Key === "Name") name = tag.Value;
                }
              }

              resources.push({
                provider: this.name,
                resourceId: instance.InstanceId || "",
                resourceName: name,
                resourceType: "ec2",
                region,
                spec: instance.InstanceType || "",
                tags,
                publicIp: instance.PublicIpAddress || undefined,
                privateIp: instance.PrivateIpAddress || undefined,
                status: instance.State?.Name || "unknown",
              });
            }
          }

          nextToken = result.NextToken;
        } while (nextToken);
      } catch (error) {
        console.error(`[AWS] Failed to fetch resources in ${region}:`, error);
      }
    }

    // Batch lookup on-demand pricing for all unique (instanceType, region) pairs
    await this.fillMonthlyBaseCost(resources);

    return resources;
  }

  /**
   * Fill monthlyBaseCost for EC2 resources via AWS Pricing API.
   * Queries are batched by unique (instanceType, region) to minimize API calls.
   */
  private async fillMonthlyBaseCost(resources: ResourceData[]): Promise<void> {
    // Collect unique (instanceType, region) pairs
    const seen = new Set<string>();
    const pairs: { instanceType: string; region: string }[] = [];
    for (const r of resources) {
      if (!r.spec || !r.region) continue;
      const key = `${r.spec}|${r.region}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ instanceType: r.spec, region: r.region });
      }
    }

    // Query pricing for each unique pair, cache results
    const priceCache = new Map<string, number>();
    for (const { instanceType, region } of pairs) {
      try {
        const regionName = AWS_REGION_NAMES[region];
        if (!regionName) {
          console.warn(`[AWS Pricing] Unknown region name for: ${region}`);
          continue;
        }

        const result = await this.pricingClient.send(
          new GetProductsCommand({
            ServiceCode: "AmazonEC2",
            Filters: [
              { Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
              { Type: "TERM_MATCH", Field: "location", Value: regionName },
              { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
              { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
              { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
              { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
            ],
            MaxResults: 1,
          })
        );

        const priceJson = result.PriceList?.[0];
        if (priceJson) {
          const hourlyPrice = extractOnDemandHourlyPrice(priceJson);
          if (hourlyPrice > 0) {
            // ~730 hours/month (365 * 24 / 12)
            const monthlyCost = hourlyPrice * 730;
            priceCache.set(`${instanceType}|${region}`, monthlyCost);
          }
        }
      } catch (error) {
        console.error(`[AWS Pricing] Failed for ${instanceType} in ${region}:`, error);
      }
    }

    // Apply cached prices to resources
    for (const r of resources) {
      const price = priceCache.get(`${r.spec}|${r.region}`);
      if (price) {
        r.monthlyBaseCost = Math.round(price * 100) / 100;
      }
    }

    console.log(`[AWS Pricing] Resolved ${priceCache.size}/${pairs.length} instance type prices`);
  }

  /** Helper: query Cost Explorer with GROUP_BY dimensions */
  private async getCostGroupedBy(
    start: Date,
    end: Date,
    groupBy: GroupDefinition[]
  ): Promise<{ keys: string[]; amount: number }[]> {
    const results: { keys: string[]; amount: number }[] = [];

    const params: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: formatDate(start),
        End: formatDate(end),
      },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: groupBy,
    };

    let nextToken: string | undefined;
    do {
      const result = await this.ceClient.send(
        new GetCostAndUsageCommand({ ...params, NextPageToken: nextToken })
      );

      for (const timePeriod of result.ResultsByTime || []) {
        for (const group of timePeriod.Groups || []) {
          const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
          results.push({
            keys: group.Keys || [],
            amount,
          });
        }
      }

      nextToken = result.NextPageToken;
    } while (nextToken);

    return results;
  }

  /**
   * Best-effort resource-level monthly cost lookup for a single AWS service.
   * Uses GetCostAndUsageWithResources with DAILY granularity (the API enforces
   * a 14-day max span per request), splits the month into ≤14-day windows,
   * then aggregates daily results per resource.
   */
  private async getResourceLevelItems(
    serviceName: string,
    start: Date,
    end: Date
  ): Promise<BillItemData[]> {
    // Aggregate daily costs per resource across the entire month
    const resourceMap = new Map<string, { region?: string; amount: number }>();

    // Split the date range into ≤14-day windows
    const windows: { start: Date; end: Date }[] = [];
    const cursor = new Date(start);
    while (cursor < end) {
      const windowEnd = new Date(cursor);
      windowEnd.setDate(windowEnd.getDate() + 14);
      if (windowEnd > end) windowEnd.setTime(end.getTime());
      windows.push({ start: new Date(cursor), end: windowEnd });
      cursor.setTime(windowEnd.getTime());
    }

    try {
      for (const window of windows) {
        let nextToken: string | undefined;
        do {
          const result = await this.ceClient.send(
            new GetCostAndUsageWithResourcesCommand({
              TimePeriod: {
                Start: formatDate(window.start),
                End: formatDate(window.end),
              },
              Granularity: "DAILY",
              Metrics: ["UnblendedCost"],
              Filter: {
                Dimensions: {
                  Key: "SERVICE",
                  Values: [serviceName],
                },
              },
              GroupBy: [
                { Type: "DIMENSION", Key: "RESOURCE_ID" },
                { Type: "DIMENSION", Key: "REGION" },
              ],
              NextPageToken: nextToken,
            })
          );

          for (const timePeriod of result.ResultsByTime || []) {
            for (const group of timePeriod.Groups || []) {
              const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
              const resourceId = group.Keys?.[0]?.trim();
              const region = group.Keys?.[1]?.trim();
              if (!resourceId || amount <= 0) continue;

              const existing = resourceMap.get(resourceId);
              if (existing) {
                existing.amount += amount;
              } else {
                resourceMap.set(resourceId, { region: region || undefined, amount });
              }
            }
          }

          nextToken = result.NextPageToken;
        } while (nextToken);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[AWS] Resource-level CE data unavailable for ${serviceName}. Reason: ${msg.split("\n")[0]}`);
      return [];
    }

    return [...resourceMap.entries()].map(([resourceId, data]) => ({
      service: serviceName,
      region: data.region,
      resourceId,
      amount: Math.round(data.amount * 100) / 100,
      usageUnit: "USD",
    }));
  }
}

/** Format Date to YYYY-MM-DD for AWS Cost Explorer */
function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * AWS Pricing API uses human-readable region names, not codes.
 * Map region codes to the "location" filter values.
 */
const AWS_REGION_NAMES: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ca-central-1": "Canada (Central)",
  "eu-central-1": "Europe (Frankfurt)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-west-3": "Europe (Paris)",
  "eu-north-1": "Europe (Stockholm)",
  "sa-east-1": "South America (Sao Paulo)",
  "me-south-1": "Middle East (Bahrain)",
  "af-south-1": "Africa (Cape Town)",
};

/**
 * Extract the on-demand hourly price (USD) from a Pricing API response item.
 * Note: AWS SDK v3 returns PriceList items as String objects (boxed), so
 * always use String() coercion before JSON.parse.
 * Structure: terms.OnDemand.<sku>.priceDimensions.<dim>.pricePerUnit.USD
 */
function extractOnDemandHourlyPrice(priceJson: string): number {
  try {
    const data = JSON.parse(String(priceJson));
    const onDemand = data.terms?.OnDemand;
    if (!onDemand) return 0;

    const skuKey = Object.keys(onDemand)[0];
    if (!skuKey) return 0;

    const dimensions = onDemand[skuKey].priceDimensions;
    if (!dimensions) return 0;

    const dimKey = Object.keys(dimensions)[0];
    if (!dimKey) return 0;

    return parseFloat(dimensions[dimKey].pricePerUnit?.USD || "0");
  } catch {
    return 0;
  }
}
