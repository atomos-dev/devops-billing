/**
 * DigitalOcean Billing Provider — fetches billing data via DO REST API.
 * Uses native fetch (no SDK dependency), respects rate limits with batch delays.
 */
import type { BillingProvider, BillData, BillItemData, ResourceData, BandwidthDataPoint } from "./types";

const DO_API_BASE = "https://api.digitalocean.com/v2";
const BATCH_DELAY_MS = 200;

interface DoConfig {
  apiToken: string;
}

export class DigitalOceanProvider implements BillingProvider {
  readonly name = "digitalocean";
  readonly displayName = "DigitalOcean";
  private token: string;

  constructor(config: DoConfig) {
    this.token = config.apiToken;
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await this.doFetch("/account");
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchBills(start: Date, end: Date): Promise<BillData[]> {
    const bills: BillData[] = [];
    const invoices = await this.fetchInvoiceList();
    const invoicesByPeriod = new Map<string, InvoiceEntry>();
    for (const invoice of invoices) {
      const billingPeriod = getInvoicePeriod(invoice);
      if (billingPeriod) {
        invoicesByPeriod.set(billingPeriod, invoice);
      }
    }

    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth() + 1, 1);

    while (current < endMonth) {
      const billingPeriod = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;

      const invoice = invoicesByPeriod.get(billingPeriod);

      if (invoice) {
        bills.push({
          provider: this.name,
          billingPeriod,
          totalAmount: Math.abs(parseFloat(invoice.amount)),
          rawData: JSON.stringify(invoice),
        });
      }

      current.setMonth(current.getMonth() + 1);
    }

    // Also check current month balance
    try {
      const balanceRes = await this.doFetch("/customers/my/balance");
      if (balanceRes.ok) {
        const balance = await balanceRes.json();
        const now = new Date();
        const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

        // Add/update current month if not already present
        const existingIdx = bills.findIndex((b) => b.billingPeriod === currentPeriod);
        const monthToDateUsage = Math.abs(parseFloat(balance.month_to_date_usage || "0"));

        if (existingIdx >= 0) {
          bills[existingIdx].totalAmount = monthToDateUsage;
        } else if (monthToDateUsage > 0) {
          bills.push({
            provider: this.name,
            billingPeriod: currentPeriod,
            totalAmount: monthToDateUsage,
            rawData: JSON.stringify(balance),
          });
        }
      }
    } catch (error) {
      console.error("[DO] Failed to fetch current balance:", error);
    }

    return bills;
  }

  async fetchBillItems(billingPeriod: string): Promise<BillItemData[]> {
    const items: BillItemData[] = [];

    // Get invoices for this period
    const invoices = await this.fetchInvoiceList();
    const matchingInvoice = invoices.find((inv) => getInvoicePeriod(inv) === billingPeriod);

    if (!matchingInvoice) {
      return items;
    }

    // Fetch invoice line items
    try {
      let nextPagePath: string | null = `/customers/my/invoices/${matchingInvoice.invoice_uuid}`;
      while (nextPagePath) {
        const res = await this.doFetch(nextPagePath);
        if (!res.ok) break;

        const data = await res.json();
        for (const item of data.invoice_items || []) {
          const parsedDuration = parseOptionalNumber(item.duration);

          items.push({
            service: item.product || "Unknown",
            region: item.region || undefined,
            resourceId: item.resource_id || item.resource_uuid || undefined,
            resourceName: item.description || undefined,
            amount: parseFloat(item.amount || "0"),
            usageQuantity: parsedDuration,
            usageUnit: item.duration_unit || "Hrs",
            startDate: item.start_time,
            endDate: item.end_time,
          });
        }
        nextPagePath = getNextDoPagePath(data.links?.pages?.next);
      }
    } catch (error) {
      console.error(`[DO] Failed to fetch invoice items for ${billingPeriod}:`, error);
    }

    return normalizeDoBillItems(items);
  }

  async fetchResources(): Promise<ResourceData[]> {
    const resources: ResourceData[] = [];

    // Fetch all Droplets (paginated)
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      await delay(BATCH_DELAY_MS);
      const res = await this.doFetch(`/droplets?page=${page}&per_page=100`);
      if (!res.ok) break;

      const data = await res.json();
      for (const droplet of data.droplets || []) {
        const tags: Record<string, string> = {};
        for (const tag of droplet.tags || []) {
          // DO tags are flat strings; parse key:value format if present
          const parts = tag.split(":");
          if (parts.length === 2) {
            tags[parts[0]] = parts[1];
          } else {
            tags[tag] = "true";
          }
        }

        // Extract IPs from networks.v4 array
        const v4Nets: Array<{ ip_address: string; type: string }> = droplet.networks?.v4 || [];
        const publicIps = v4Nets.filter((n) => n.type === "public").map((n) => n.ip_address);
        const privateIps = v4Nets.filter((n) => n.type === "private").map((n) => n.ip_address);

        resources.push({
          provider: this.name,
          resourceId: String(droplet.id),
          resourceName: droplet.name || "",
          resourceType: "droplet",
          region: droplet.region?.slug || "",
          spec: droplet.size_slug || "",
          tags,
          monthlyBaseCost: droplet.size?.price_monthly || undefined,
          bandwidthAllowanceTib: droplet.size?.transfer || undefined,
          publicIp: publicIps.length > 0 ? publicIps.join(",") : undefined,
          privateIp: privateIps.length > 0 ? privateIps.join(",") : undefined,
          status: droplet.status || "unknown",
        });
      }

      // Check pagination
      const totalPages = Math.ceil((data.meta?.total || 0) / 100);
      hasMore = page < totalPages;
      page++;
    }

    // Fetch Load Balancers
    try {
      const res = await this.doFetch("/load_balancers");
      if (res.ok) {
        const data = await res.json();
        for (const lb of data.load_balancers || []) {
          resources.push({
            provider: this.name,
            resourceId: lb.id,
            resourceName: lb.name || "",
            resourceType: "load_balancer",
            region: lb.region?.slug || "",
            spec: `size_unit:${lb.size_unit || 1}`,
            tags: {},
            publicIp: lb.ip || undefined,
            status: lb.status || "unknown",
          });
        }
      }
    } catch (error) {
      console.error("[DO] Failed to fetch load balancers:", error);
    }

    return resources;
  }

  /**
   * Fetch daily bandwidth metrics for all Droplets via DO Monitoring API.
   * Queries 4 combinations per Droplet (public/private × inbound/outbound),
   * then aggregates raw Mbps time-series into daily GiB totals.
   */
  async fetchBandwidthMetrics(start: Date, end: Date): Promise<BandwidthDataPoint[]> {
    // First, collect all droplet IDs and their regions
    const droplets = await this.fetchDropletList();
    if (droplets.length === 0) return [];

    const startTs = Math.floor(start.getTime() / 1000).toString();
    const endTs = Math.floor(end.getTime() / 1000).toString();

    const INTERFACES = ["public", "private"] as const;
    const DIRECTIONS = ["inbound", "outbound"] as const;

    // Per-droplet daily accumulator: Map<"resourceId:date", BandwidthDataPoint>
    const dailyMap = new Map<string, BandwidthDataPoint>();

    for (const droplet of droplets) {
      for (const iface of INTERFACES) {
        for (const dir of DIRECTIONS) {
          await delay(BATCH_DELAY_MS);
          try {
            const res = await this.doFetch(
              `/monitoring/metrics/droplet/bandwidth?host_id=${droplet.id}&interface=${iface}&direction=${dir}&start=${startTs}&end=${endTs}`
            );
            if (!res.ok) continue;

            const json = await res.json();
            // Response: { status: "success", data: { resultType: "matrix", result: [{ metric: {...}, values: [[ts, "mbps"], ...] }] } }
            const results = json?.data?.result || [];
            for (const series of results) {
              const values: [number, string][] = series.values || [];
              // Aggregate Mbps samples into daily GiB buckets
              const dailyBuckets = aggregateMbpsToDailyGib(values);

              for (const [date, gib] of Object.entries(dailyBuckets)) {
                const key = `${droplet.id}:${date}`;
                const existing = dailyMap.get(key) || {
                  resourceId: String(droplet.id),
                  region: droplet.region,
                  date,
                  publicInGib: 0,
                  publicOutGib: 0,
                  privateInGib: 0,
                  privateOutGib: 0,
                };

                if (iface === "public" && dir === "inbound") existing.publicInGib += gib;
                else if (iface === "public" && dir === "outbound") existing.publicOutGib += gib;
                else if (iface === "private" && dir === "inbound") existing.privateInGib += gib;
                else if (iface === "private" && dir === "outbound") existing.privateOutGib += gib;

                dailyMap.set(key, existing);
              }
            }
          } catch (error) {
            console.error(`[DO] Bandwidth fetch failed for droplet ${droplet.id} ${iface}/${dir}:`, error);
          }
        }
      }
    }

    return Array.from(dailyMap.values());
  }

  /** Fetch all Droplet IDs and regions for bandwidth metric queries */
  private async fetchDropletList(): Promise<{ id: number; region: string }[]> {
    const droplets: { id: number; region: string }[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      await delay(BATCH_DELAY_MS);
      const res = await this.doFetch(`/droplets?page=${page}&per_page=100`);
      if (!res.ok) break;
      const data = await res.json();
      for (const d of data.droplets || []) {
        droplets.push({ id: d.id, region: d.region?.slug || "" });
      }
      const totalPages = Math.ceil((data.meta?.total || 0) / 100);
      hasMore = page < totalPages;
      page++;
    }
    return droplets;
  }

  /** Fetch invoice list for matching periods */
  private async fetchInvoiceList(): Promise<InvoiceEntry[]> {
    const invoices: InvoiceEntry[] = [];
    try {
      let nextPagePath: string | null = "/customers/my/invoices";
      while (nextPagePath) {
        const res = await this.doFetch(nextPagePath);
        if (!res.ok) break;

        const data = await res.json();
        invoices.push(...(data.invoices || []));
        nextPagePath = getNextDoPagePath(data.links?.pages?.next);
      }
    } catch (error) {
      console.error("[DO] Failed to fetch invoice list:", error);
    }
    return invoices;
  }

  /** Authenticated fetch wrapper for DO API */
  private async doFetch(path: string): Promise<Response> {
    return fetch(`${DO_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
  }
}

interface InvoiceEntry {
  invoice_uuid: string;
  invoice_period?: string;
  billing_period?: string;
  amount: string;
}

/**
 * DigitalOcean invoice billing periods are expected to be YYYY-MM, but some
 * endpoints may return date-like values. Normalize both forms to YYYY-MM so
 * bill headers and invoice-item lookups stay aligned.
 */
function normalizeDoBillingPeriod(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getInvoicePeriod(invoice: InvoiceEntry): string | null {
  return normalizeDoBillingPeriod(invoice.invoice_period || invoice.billing_period);
}

function getNextDoPagePath(nextUrl: string | undefined): string | null {
  if (!nextUrl) return null;

  try {
    const url = new URL(nextUrl);
    const path = `${url.pathname}${url.search}`;
    return path.startsWith("/v2/") ? path.slice(3) : path;
  } catch {
    if (nextUrl.startsWith(DO_API_BASE)) {
      return nextUrl.slice(DO_API_BASE.length);
    }
    return nextUrl;
  }
}

/**
 * Normalizes duplicate DigitalOcean invoice lines to match the persisted bill item
 * identity used downstream during sync.
 */
function normalizeDoBillItems(items: BillItemData[]): BillItemData[] {
  const groupedItems = new Map<string, BillItemData>();

  for (const item of items) {
    const key = buildPersistedBillItemIdentityKey(item);
    const existing = groupedItems.get(key);

    if (!existing) {
      groupedItems.set(key, { ...item });
      continue;
    }

    existing.amount += item.amount;
    if (typeof item.usageQuantity === "number") {
      existing.usageQuantity = (existing.usageQuantity ?? 0) + item.usageQuantity;
    }
    if (!existing.resourceName && item.resourceName) {
      existing.resourceName = item.resourceName;
    }
    if (isEarlierDate(item.startDate, existing.startDate)) {
      existing.startDate = item.startDate;
    }
    if (isLaterDate(item.endDate, existing.endDate)) {
      existing.endDate = item.endDate;
    }
  }

  return Array.from(groupedItems.values());
}

/**
 * Builds the persisted bill item identity key used by downstream sync logic.
 */
function buildPersistedBillItemIdentityKey(item: BillItemData): string {
  return [item.service, item.region ?? "", item.resourceId ?? "", item.usageUnit].join("\u0000");
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const normalizedValue = String(value).trim();
  if (normalizedValue === "") {
    return undefined;
  }

  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalizedValue)) {
    return undefined;
  }

  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isEarlierDate(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate < current;
}

function isLaterDate(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate > current;
}

/**
 * Aggregates Prometheus-style [timestamp, "mbps"] time-series into daily GiB.
 *
 * DO Monitoring API returns downsampled data for large time ranges:
 *   - 1-day query  → ~216s intervals (~400 samples/day)
 *   - 90-day query → ~18,360s intervals (~5 samples/day)
 *
 * The sample interval is inferred from the first two timestamps so the
 * conversion stays accurate regardless of the query window.
 *
 * Formula per sample: Mbps × actual_interval_sec / 8 / 1024 = GiB contribution.
 */
export function aggregateMbpsToDailyGib(values: [number, string][]): Record<string, number> {
  if (values.length < 2) return {};

  // Infer the actual sample interval from consecutive timestamps
  const intervalSec = values[1][0] - values[0][0];
  if (intervalSec <= 0) return {};

  const daily: Record<string, number> = {};
  const mbpsToGibFactor = intervalSec / 8 / 1024;

  for (const [ts, mbpsStr] of values) {
    const mbps = parseFloat(mbpsStr);
    if (!Number.isFinite(mbps) || mbps < 0) continue;

    const date = new Date(ts * 1000);
    const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    daily[dateKey] = (daily[dateKey] || 0) + mbps * mbpsToGibFactor;
  }

  return daily;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
