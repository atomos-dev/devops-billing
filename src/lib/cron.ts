/**
 * Cron job management — schedules periodic billing data sync.
 */
import * as cron from "node-cron";
import { createProviders } from "@/providers";
import { syncAll } from "@/services/sync";

let cronJob: cron.ScheduledTask | null = null;

/** Start the sync cron job */
export function startCronSync() {
  const schedule = process.env.SYNC_CRON_SCHEDULE || "0 6 * * *";
  const backfillMonths = parseInt(process.env.SYNC_BACKFILL_MONTHS || "6", 10);

  if (cronJob) {
    cronJob.stop();
  }

  cronJob = cron.schedule(schedule, async () => {
    console.log(`[Cron] Starting scheduled sync at ${new Date().toISOString()}`);
    try {
      const providers = createProviders();
      const results = await syncAll(providers, "scheduled", backfillMonths);

      for (const result of results) {
        console.log(
          `[Cron] ${result.provider}: ${result.status} (${result.recordsSynced} records)`
        );
        if (result.errorMessage) {
          console.error(`[Cron] ${result.provider} errors: ${result.errorMessage}`);
        }
      }
    } catch (error) {
      console.error("[Cron] Scheduled sync failed:", error);
    }
  });

  console.log(`[Cron] Sync scheduled: ${schedule} (UTC)`);
}

/** Stop the cron job */
export function stopCronSync() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("[Cron] Sync stopped");
  }
}
