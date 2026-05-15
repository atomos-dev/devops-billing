/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to initialize the cron-based billing sync schedule.
 */
export async function register() {
  // Only start cron in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCronSync } = await import("@/lib/cron");
    startCronSync();
  }
}
