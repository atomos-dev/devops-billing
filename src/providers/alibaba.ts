/**
 * Alibaba Cloud Billing Provider — fetches cost data via BSS OpenAPI,
 * resource metadata via ECS and SWAS (Simple Application Server), with
 * auto-discovery across all available regions.
 *
 * BSS SDK:  @alicloud/bssopenapi20171214
 * ECS SDK:  @alicloud/ecs20140526
 * SWAS SDK: @alicloud/swas-open20200601
 */
import BssClient, {
  QueryBillOverviewRequest,
  DescribeInstanceBillRequest,
} from "@alicloud/bssopenapi20171214";
import EcsClient, {
  DescribeInstancesRequest,
  DescribeRegionsRequest,
} from "@alicloud/ecs20140526";
import SwasClient, {
  ListInstancesRequest as SwasListInstancesRequest,
  ListRegionsRequest as SwasListRegionsRequest,
} from "@alicloud/swas-open20200601";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import type { BillingProvider, BillData, BillItemData, ResourceData } from "./types";

export interface AlibabaConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** "international" (default) or "china" — determines BSS endpoint */
  site: string;
  regionId: string;
}

export class AlibabaProvider implements BillingProvider {
  readonly name = "alibaba-cloud";
  readonly displayName = "Alibaba Cloud";
  private config: AlibabaConfig;
  private bssClient: InstanceType<typeof BssClient>;

  constructor(config: AlibabaConfig) {
    this.config = config;
    // BSS endpoint: 国际站用 ap-southeast-1，中国站（默认）用 SDK 自动解析
    const isIntl = config.site === "international";
    const bssConfig: Record<string, string> = {
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      regionId: isIntl ? "ap-southeast-1" : config.regionId,
    };
    if (isIntl) {
      bssConfig.endpoint = "business.ap-southeast-1.aliyuncs.com";
    }
    this.bssClient = new BssClient(new $OpenApiUtil.Config(bssConfig));
  }

  async testConnection(): Promise<boolean> {
    try {
      const resp = await this.bssClient.queryAccountBalance();
      return resp.body?.success === true;
    } catch {
      return false;
    }
  }

  async fetchBills(start: Date, end: Date): Promise<BillData[]> {
    const bills: BillData[] = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth() + 1, 1);

    while (current < endMonth) {
      const billingCycle = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;

      try {
        const resp = await this.bssClient.queryBillOverview(
          new QueryBillOverviewRequest({ billingCycle })
        );

        if (!resp.body?.success) {
          console.warn(`[Alibaba] queryBillOverview failed for ${billingCycle}: ${resp.body?.message}`);
          current.setMonth(current.getMonth() + 1);
          continue;
        }

        // Sum all product items for the total amount
        const items = resp.body.data?.items?.item || [];
        const totalAmount = items.reduce(
          (sum: number, item: Record<string, unknown>) =>
            sum + (parseFloat(String(item.pretaxAmount ?? item.afterDiscountAmount ?? 0))),
          0
        );

        bills.push({
          provider: this.name,
          billingPeriod: billingCycle,
          totalAmount: Math.round(totalAmount * 100) / 100,
          rawData: JSON.stringify(items),
        });
      } catch (error) {
        console.error(`[Alibaba] Failed to fetch bill for ${billingCycle}:`, error);
      }

      current.setMonth(current.getMonth() + 1);
    }

    return bills;
  }

  async fetchBillItems(billingPeriod: string): Promise<BillItemData[]> {
    const items: BillItemData[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const req = new DescribeInstanceBillRequest({
          billingCycle: billingPeriod,
          granularity: "MONTHLY",
          maxResults: 300,
          ...(nextToken ? { nextToken } : {}),
        });

        const resp = await this.bssClient.describeInstanceBill(req);

        if (!resp.body?.success) {
          console.warn(`[Alibaba] describeInstanceBill failed for ${billingPeriod}: ${resp.body?.message}`);
          break;
        }

        const billItems = resp.body.data?.items || [];
        for (const item of billItems) {
          const amount = parseFloat(String(item.pretaxAmount ?? item.afterDiscountAmount ?? 0));
          if (amount === 0) continue;

          items.push({
            service: String(item.productName || item.productCode || "Unknown").trim(),
            region: String(item.region || "").trim(),
            resourceId: String(item.instanceID || "").trim(),
            resourceName: String(item.nickName || item.instanceID || "").trim(),
            amount: Math.round(amount * 100) / 100,
            usageQuantity: item.usage ? parseFloat(String(item.usage)) : undefined,
            usageUnit: item.usageUnit ? String(item.usageUnit) : undefined,
            startDate: billingPeriod + "-01",
            endDate: undefined,
          });
        }

        nextToken = resp.body.data?.nextToken || undefined;
      } while (nextToken);
    } catch (error) {
      console.error(`[Alibaba] Failed to fetch bill items for ${billingPeriod}:`, error);
    }

    return items;
  }

  async fetchResources(): Promise<ResourceData[]> {
    // Scan ECS and SWAS in parallel across all regions
    const [ecsResources, swasResources] = await Promise.all([
      this.scanEcsInstances(),
      this.scanSwasInstances(),
    ]);

    const total = ecsResources.length + swasResources.length;
    console.log(`[Alibaba] Found ${total} resources (${ecsResources.length} ECS, ${swasResources.length} SWAS)`);
    return [...ecsResources, ...swasResources];
  }

  // ── ECS scanning ──────────────────────────────────────────────────────────

  /** Scan ECS instances across all auto-discovered regions */
  private async scanEcsInstances(): Promise<ResourceData[]> {
    const resources: ResourceData[] = [];
    const regions = await this.discoverEcsRegions();
    console.log(`[Alibaba] Scanning ECS across ${regions.length} regions...`);

    for (const regionId of regions) {
      try {
        const ecsClient = this.createEcsClient(regionId);
        let pageNumber = 1;
        let totalCount = 0;

        do {
          const resp = await ecsClient.describeInstances(
            new DescribeInstancesRequest({
              regionId,
              pageSize: 100,
              pageNumber,
            })
          );

          totalCount = resp.body?.totalCount ?? 0;
          const instances = resp.body?.instances?.instance || [];

          for (const inst of instances) {
            const tags: Record<string, string> = {};
            for (const tag of inst.tags?.tag || []) {
              if (tag.tagKey && tag.tagValue) {
                tags[tag.tagKey] = tag.tagValue;
              }
            }

            // ECS public IP: prefer EIP, then classic public IP
            const eipAddr = inst.eipAddress?.ipAddress;
            const classicPublicIps: string[] = inst.publicIpAddress?.ipAddress || [];
            const publicIp = eipAddr || (classicPublicIps.length > 0 ? classicPublicIps.join(",") : undefined);
            // ECS private IP from VPC or Classic network
            const vpcPrivateIps: string[] = inst.vpcAttributes?.privateIpAddress?.ipAddress || [];
            const classicPrivateIps: string[] = inst.innerIpAddress?.ipAddress || [];
            const privateIpList = [...vpcPrivateIps, ...classicPrivateIps];

            resources.push({
              provider: this.name,
              resourceId: inst.instanceId || "",
              resourceName: inst.instanceName || inst.hostName || "",
              resourceType: "ecs",
              region: regionId,
              spec: inst.instanceType || "",
              tags,
              publicIp: publicIp || undefined,
              privateIp: privateIpList.length > 0 ? privateIpList.join(",") : undefined,
              status: mapEcsStatus(inst.status),
            });
          }

          pageNumber++;
        } while ((pageNumber - 1) * 100 < totalCount);
      } catch {
        // Skip regions with no ECS access — this is expected for most regions
      }
    }

    return resources;
  }

  private async discoverEcsRegions(): Promise<string[]> {
    try {
      const ecsClient = this.createEcsClient(this.config.regionId);
      const resp = await ecsClient.describeRegions(new DescribeRegionsRequest({}));
      const regions = resp.body?.regions?.region || [];
      return regions
        .map((r: Record<string, unknown>) => String(r.regionId || ""))
        .filter(Boolean)
        .sort();
    } catch (error) {
      console.error("[Alibaba] Failed to discover ECS regions:", error);
      return [this.config.regionId];
    }
  }

  private createEcsClient(regionId: string): InstanceType<typeof EcsClient> {
    return new EcsClient(
      new $OpenApiUtil.Config({
        accessKeyId: this.config.accessKeyId,
        accessKeySecret: this.config.accessKeySecret,
        regionId,
        endpoint: `ecs.${regionId}.aliyuncs.com`,
      })
    );
  }

  // ── SWAS (轻量应用服务器) scanning ────────────────────────────────────────

  /** Scan SWAS instances across all SWAS-available regions */
  private async scanSwasInstances(): Promise<ResourceData[]> {
    const resources: ResourceData[] = [];
    const regions = await this.discoverSwasRegions();
    console.log(`[Alibaba] Scanning SWAS across ${regions.length} regions...`);

    for (const regionId of regions) {
      try {
        const swasClient = this.createSwasClient(regionId);
        let pageNumber = 1;
        let totalCount = 0;

        do {
          const resp = await swasClient.listInstances(
            new SwasListInstancesRequest({
              regionId,
              pageSize: 100,
              pageNumber,
            })
          );

          totalCount = resp.body?.totalCount ?? 0;
          const instances = (resp.body?.instances || []) as Record<string, unknown>[];

          for (const inst of instances) {
            resources.push({
              provider: this.name,
              resourceId: String(inst.instanceId || ""),
              resourceName: String(inst.instanceName || ""),
              resourceType: "swas",
              region: regionId,
              spec: String(inst.planId || ""),
              tags: {},
              publicIp: inst.publicIpAddress ? String(inst.publicIpAddress) : undefined,
              privateIp: inst.innerIpAddress ? String(inst.innerIpAddress) : undefined,
              status: mapSwasStatus(inst.status as string | undefined),
            });
          }

          pageNumber++;
        } while ((pageNumber - 1) * 100 < totalCount);
      } catch {
        // Skip regions with no SWAS access
      }
    }

    return resources;
  }

  private async discoverSwasRegions(): Promise<string[]> {
    try {
      const swasClient = this.createSwasClient(this.config.regionId);
      const resp = await swasClient.listRegions(new SwasListRegionsRequest({}));
      const regions = (resp.body?.regions || []) as Record<string, unknown>[];
      return regions
        .map((r) => String(r.regionId || ""))
        .filter(Boolean)
        .sort();
    } catch (error) {
      console.error("[Alibaba] Failed to discover SWAS regions:", error);
      return [this.config.regionId];
    }
  }

  private createSwasClient(regionId: string): InstanceType<typeof SwasClient> {
    return new SwasClient(
      new $OpenApiUtil.Config({
        accessKeyId: this.config.accessKeyId,
        accessKeySecret: this.config.accessKeySecret,
        regionId,
        endpoint: `swas.${regionId}.aliyuncs.com`,
      })
    );
  }
}

// ── Status mappers ────────────────────────────────────────────────────────

function mapEcsStatus(status: string | undefined): string {
  switch (status) {
    case "Running": return "running";
    case "Stopped": return "stopped";
    case "Starting":
    case "Stopping": return status.toLowerCase();
    default: return "unknown";
  }
}

function mapSwasStatus(status: string | undefined): string {
  switch (status) {
    case "Running": return "running";
    case "Stopped": return "stopped";
    case "Disabled":
    case "Expired": return "stopped";
    case "Resetting":
    case "Starting": return status.toLowerCase();
    default: return "unknown";
  }
}
