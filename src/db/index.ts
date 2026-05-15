/**
 * Database connection singleton for the DevOps Billing System.
 * Uses Drizzle ORM with better-sqlite3 for SQLite access.
 * Uses globalThis caching to prevent multiple connections during HMR.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const dbPath = process.env.DATABASE_URL || path.join(process.cwd(), "data", "billing.db");

// Ensure the data directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Use globalThis cache to prevent multiple DB connections during HMR in development
const globalForDb = globalThis as unknown as {
  _sqlite: Database.Database | undefined;
};

if (!globalForDb._sqlite) {
  globalForDb._sqlite = new Database(dbPath);
  globalForDb._sqlite.pragma("journal_mode = WAL");
}

export const db = drizzle(globalForDb._sqlite, { schema });
export type DB = typeof db;
