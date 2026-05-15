/**
 * Manual sync script — triggers billing data sync for all enabled providers.
 * Usage: npx tsx scripts/sync.ts
 */
import "dotenv/config";
import { createProviders } from "../src/providers";
import { syncAll } from "../src/services/sync";

async function main() {
  const backfillMonths = parseInt(process.env.SYNC_BACKFILL_MONTHS || "6", 10);

  console.log("Creating providers...");
  const providers = createProviders();

  if (providers.size === 0) {
    console.error("No providers enabled. Check AWS_ENABLED / DO_ENABLED in .env or Settings UI");
    process.exit(1);
  }

  console.log(`Enabled providers: ${[...providers.keys()].join(", ")}`);
  console.log(`Backfill months: ${backfillMonths}`);
  console.log("Starting sync...\n");

  const results = await syncAll(providers, "manual", backfillMonths);

  for (const result of results) {
    console.log(`\n--- ${result.provider} ---`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Records synced: ${result.recordsSynced}`);
    if (result.errorMessage) {
      console.log(`  Errors: ${result.errorMessage}`);
    }
    console.log(`  Sync Log ID: ${result.syncLogId}`);
  }

  console.log("\nSync complete.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
