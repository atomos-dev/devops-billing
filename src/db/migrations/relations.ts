import { relations } from "drizzle-orm/relations";
import { bills, billItems } from "./schema";

export const billItemsRelations = relations(billItems, ({one}) => ({
	bill: one(bills, {
		fields: [billItems.billId],
		references: [bills.id]
	}),
}));

export const billsRelations = relations(bills, ({many}) => ({
	billItems: many(billItems),
}));