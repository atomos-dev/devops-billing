/**
 * BillingProvider interface and shared data types.
 * All cloud provider integrations implement this interface.
 */

/** Summary billing data for a time period */
export interface BillData {
  provider: string;
  billingPeriod: string; // YYYY-MM format
  totalAmount: number; // USD
  rawData?: string; // Original JSON for audit
}

/** Line-item detail within a bill */
export interface BillItemData {
  service: string;
  region?: string;
  resourceId?: string;
  resourceName?: string;
  amount: number; // USD
  usageQuantity?: number;
  usageUnit?: string;
  startDate?: string;
  endDate?: string;
}

/** Cloud resource metadata for mapping and categorization */
export interface ResourceData {
  provider: string;
  resourceId: string;
  resourceName?: string;
  resourceType?: string;
  region?: string;
  spec?: string;
  tags?: Record<string, string>;
  monthlyBaseCost?: number;
  bandwidthAllowanceTib?: number; // Transfer pool per resource (TiB), from provider API (e.g. DO size.transfer)
  publicIp?: string; // Public IPv4 address(es), comma-separated if multiple
  privateIp?: string; // Private IPv4 address(es), comma-separated if multiple
  status?: string;
}

/** Daily bandwidth metrics for a single Droplet */
export interface BandwidthDataPoint {
  resourceId: string;
  region?: string;
  date: string; // YYYY-MM-DD
  publicInGib: number;
  publicOutGib: number;
  privateInGib: number;
  privateOutGib: number;
}

/**
 * Unified interface for cloud billing data collection.
 * New providers implement this interface and register in createProviders().
 */
export interface BillingProvider {
  readonly name: string;
  readonly displayName: string;

  /** Fetch billing summaries for the given date range */
  fetchBills(start: Date, end: Date): Promise<BillData[]>;

  /** Fetch line-item details for a specific billing period (YYYY-MM) */
  fetchBillItems(billingPeriod: string): Promise<BillItemData[]>;

  /** Fetch current resource inventory */
  fetchResources(): Promise<ResourceData[]>;

  /** Validate credentials and API connectivity */
  testConnection(): Promise<boolean>;

  /** Fetch daily bandwidth metrics for all resources (optional, DO-only) */
  fetchBandwidthMetrics?(start: Date, end: Date): Promise<BandwidthDataPoint[]>;
}
