/**
 * Database schema definitions for the DevOps Billing System.
 * Defines 5 core tables: bills, billItems, manualCosts, resources, syncLogs.
 * Uses Drizzle ORM with SQLite (better-sqlite3).
 */
import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Monthly billing records per cloud provider */
export const bills = sqliteTable(
  "bills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(), // aws | digitalocean
    billingPeriod: text("billing_period").notNull(), // 2026-03
    totalAmount: real("total_amount").notNull(), // USD
    fetchedAt: text("fetched_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    rawData: text("raw_data"), // Original JSON for audit
  },
  (table) => [unique("bills_provider_period").on(table.provider, table.billingPeriod)]
);

/** Line-item details within a bill */
export const billItems = sqliteTable(
  "bill_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    billId: integer("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    service: text("service").notNull(), // EC2, RDS, Droplets, Bandwidth...
    region: text("region"), // us-east-1, sgp1...
    resourceId: text("resource_id"), // i-xxx, droplet-xxx
    resourceName: text("resource_name"), // Human-readable name
    usageCategory: text("usage_category").default("other"), // dpn|mainnet|devops|dbg|gc|other
    amount: real("amount").notNull(), // USD
    usageQuantity: real("usage_quantity"),
    usageUnit: text("usage_unit"), // Hrs, GB, Requests
    startDate: text("start_date"),
    endDate: text("end_date"),
  },
  (table) => [
    unique("bill_items_dedup").on(
      table.billId,
      table.service,
      table.region,
      table.resourceId,
      table.usageUnit
    ),
  ]
);

/** Manually entered costs for providers without auto-collection */
export const manualCosts = sqliteTable(
  "manual_costs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerName: text("provider_name").notNull(), // cloudflare, mongodb, etc.
    billingPeriod: text("billing_period").notNull(), // 2026-03
    amount: real("amount").notNull(), // USD
    note: text("note"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique("manual_costs_provider_period").on(table.providerName, table.billingPeriod),
  ]
);

/** Cached cloud resource information for name/tag mapping */
export const resources = sqliteTable(
  "resources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceName: text("resource_name"),
    resourceType: text("resource_type"), // ec2, droplet, rds, load_balancer
    region: text("region"),
    spec: text("spec"), // t3a.xlarge, s-1vcpu-1gb
    tags: text("tags"), // JSON string
    usageCategory: text("usage_category").default("other"),
    monthlyBaseCost: real("monthly_base_cost"),
    bandwidthAllowanceTib: real("bandwidth_allowance_tib"), // Transfer pool per resource (TiB), from provider API
    publicIp: text("public_ip"), // Public IPv4 address(es), comma-separated if multiple
    privateIp: text("private_ip"), // Private IPv4 address(es), comma-separated if multiple
    status: text("status").default("running"), // running, stopped, terminated
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique("resources_provider_rid").on(table.provider, table.resourceId),
  ]
);

/** Cloud provider configuration and encrypted credentials */
export const providerSettings = sqliteTable("provider_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().unique(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  credentials: text("credentials"), // AES-256-GCM encrypted JSON
  lastTestedAt: text("last_tested_at"),
  lastTestResult: integer("last_test_result", { mode: "boolean" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Daily bandwidth usage per Droplet, collected from DO Monitoring API */
export const bandwidthUsage = sqliteTable(
  "bandwidth_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(), // digitalocean
    resourceId: text("resource_id").notNull(), // Droplet ID
    region: text("region"), // sgp1, nyc1...
    date: text("date").notNull(), // YYYY-MM-DD
    publicInGib: real("public_in_gib").notNull().default(0),
    publicOutGib: real("public_out_gib").notNull().default(0),
    privateInGib: real("private_in_gib").notNull().default(0),
    privateOutGib: real("private_out_gib").notNull().default(0),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique("bandwidth_usage_dedup").on(table.provider, table.resourceId, table.date),
  ]
);

/** Monthly bandwidth usage per resource from DO Bandwidth Detail CSV (precise billing data) */
export const bandwidthReports = sqliteTable(
  "bandwidth_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    billingPeriod: text("billing_period").notNull(), // 2026-03
    provider: text("provider").notNull(), // digitalocean
    resourceId: text("resource_id").notNull(),
    region: text("region"),
    product: text("product"), // droplet, load_balancer, kubernetes
    bandwidthGib: real("bandwidth_gib").notNull().default(0),
    importedAt: text("imported_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique("bandwidth_reports_dedup").on(table.billingPeriod, table.provider, table.resourceId),
  ]
);

/** Sync operation logs for monitoring and debugging */
export const syncLogs = sqliteTable("sync_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  syncType: text("sync_type").notNull(), // scheduled | manual
  status: text("status").notNull().default("running"), // running | success | failed | partial
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  recordsSynced: integer("records_synced").default(0),
  errorMessage: text("error_message"),
  details: text("details"), // JSON with timing, skipped records, etc.
});

/** Resource scan operation logs — tracks independent resource discovery runs */
export const resourceScans = sqliteTable("resource_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider"),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  servicesScanned: integer("services_scanned").default(0),
  resourcesFound: integer("resources_found").default(0),
  errorMessage: text("error_message"),
  details: text("details"),
});
