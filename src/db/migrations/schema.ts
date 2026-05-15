import { sqliteTable, AnySQLiteColumn, uniqueIndex, foreignKey, integer, text, real } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const billItems = sqliteTable("bill_items", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	billId: integer("bill_id").notNull().references(() => bills.id, { onDelete: "cascade" } ),
	service: text().notNull(),
	region: text(),
	resourceId: text("resource_id"),
	resourceName: text("resource_name"),
	usageCategory: text("usage_category").default("other"),
	amount: real().notNull(),
	usageQuantity: real("usage_quantity"),
	usageUnit: text("usage_unit"),
	startDate: text("start_date"),
	endDate: text("end_date"),
},
(table) => [
	uniqueIndex("bill_items_dedup").on(table.billId, table.service, table.region, table.resourceId, table.usageUnit),
]);

export const bills = sqliteTable("bills", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	provider: text().notNull(),
	billingPeriod: text("billing_period").notNull(),
	totalAmount: real("total_amount").notNull(),
	fetchedAt: text("fetched_at").default("sql`(datetime('now'))`").notNull(),
	rawData: text("raw_data"),
},
(table) => [
	uniqueIndex("bills_provider_period").on(table.provider, table.billingPeriod),
]);

export const manualCosts = sqliteTable("manual_costs", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	providerName: text("provider_name").notNull(),
	billingPeriod: text("billing_period").notNull(),
	amount: real().notNull(),
	note: text(),
	createdAt: text("created_at").default("sql`(datetime('now'))`").notNull(),
	updatedAt: text("updated_at").default("sql`(datetime('now'))`").notNull(),
},
(table) => [
	uniqueIndex("manual_costs_provider_period").on(table.providerName, table.billingPeriod),
]);

export const resources = sqliteTable("resources", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	provider: text().notNull(),
	resourceId: text("resource_id").notNull(),
	resourceName: text("resource_name"),
	resourceType: text("resource_type"),
	region: text(),
	spec: text(),
	tags: text(),
	usageCategory: text("usage_category").default("other"),
	monthlyBaseCost: real("monthly_base_cost"),
	status: text().default("running"),
	updatedAt: text("updated_at").default("sql`(datetime('now'))`").notNull(),
},
(table) => [
	uniqueIndex("resources_provider_rid").on(table.provider, table.resourceId),
]);

export const syncLogs = sqliteTable("sync_logs", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	provider: text().notNull(),
	syncType: text("sync_type").notNull(),
	status: text().default("running").notNull(),
	startedAt: text("started_at").default("sql`(datetime('now'))`").notNull(),
	finishedAt: text("finished_at"),
	recordsSynced: integer("records_synced").default(0),
	errorMessage: text("error_message"),
	details: text(),
});

export const providerSettings = sqliteTable("provider_settings", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	provider: text().notNull(),
	displayName: text("display_name").notNull(),
	enabled: integer().default(0).notNull(),
	credentials: text(),
	lastTestedAt: text("last_tested_at"),
	lastTestResult: integer("last_test_result"),
	createdAt: text("created_at").default("sql`(datetime('now'))`").notNull(),
	updatedAt: text("updated_at").default("sql`(datetime('now'))`").notNull(),
},
(table) => [
	uniqueIndex("provider_settings_provider_unique").on(table.provider),
]);

export const bandwidthUsage = sqliteTable("bandwidth_usage", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	provider: text().notNull(),
	resourceId: text("resource_id").notNull(),
	region: text(),
	date: text().notNull(),
	publicInGib: real("public_in_gib").notNull(),
	publicOutGib: real("public_out_gib").notNull(),
	privateInGib: real("private_in_gib").notNull(),
	privateOutGib: real("private_out_gib").notNull(),
	updatedAt: text("updated_at").default("sql`(datetime('now'))`").notNull(),
},
(table) => [
	uniqueIndex("bandwidth_usage_dedup").on(table.provider, table.resourceId, table.date),
]);

