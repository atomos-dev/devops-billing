/**
 * Fetch DigitalOcean Bandwidth Detail CSV via browser automation.
 *
 * Flow:
 *   1. Opens DO control panel (visible browser) → triggers CSV report
 *   2. Opens Gmail (visible browser) → polls for CSV email → downloads attachment
 *   3. Saves CSV to data/do-bandwidth-detail-YYYY-MM.csv
 *
 * Both DO and Gmail use persistent browser profiles in data/browser-state/
 * so login only needs to happen once per site.
 *
 * Usage:
 *   npx tsx scripts/fetch-do-bandwidth-csv.ts          # current month
 *   npx tsx scripts/fetch-do-bandwidth-csv.ts 3 2026   # March 2026
 *
 * Required env vars:
 *   DO_EMAIL    — DigitalOcean login email
 *   DO_PASSWORD — DigitalOcean login password
 */
import "dotenv/config";
import { chromium, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const DO_EMAIL = process.env.DO_EMAIL;
const DO_PASSWORD = process.env.DO_PASSWORD;

const targetMonth = parseInt(process.argv[2], 10) || new Date().getMonth() + 1;
const targetYear = parseInt(process.argv[3], 10) || new Date().getFullYear();

const GMAIL_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const GMAIL_POLL_INTERVAL_MS = 20 * 1000;

const BROWSER_STATE_DIR = path.resolve(__dirname, "../data/browser-state");

async function main() {
  if (!DO_EMAIL || !DO_PASSWORD) {
    console.error("Missing required env vars: DO_EMAIL, DO_PASSWORD");
    process.exit(1);
  }

  const period = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  console.log(`Target period: ${period}`);
  console.log(`DO Email: ${DO_EMAIL}\n`);

  // ── Step 1: Trigger CSV report on DO ────────────────────────────────────
  console.log("[1/3] Triggering CSV report on DigitalOcean...");
  await triggerBandwidthReport();
  console.log("[1/3] Done.\n");

  // ── Step 2: Fetch CSV from Gmail ────────────────────────────────────────
  console.log("[2/3] Fetching CSV from Gmail...");
  const csvContent = await fetchCsvFromGmail();

  if (!csvContent) {
    console.error("\nFailed to retrieve CSV from Gmail.");
    process.exit(1);
  }

  // ── Step 3: Save CSV ────────────────────────────────────────────────────
  const outputDir = path.resolve(__dirname, "../data");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `do-bandwidth-detail-${period}.csv`);
  fs.writeFileSync(outputPath, csvContent);

  const lines = csvContent.split("\n").filter(Boolean);
  console.log(`\n[3/3] CSV saved to: ${outputPath}`);
  console.log(`      Size: ${(csvContent.length / 1024).toFixed(1)} KB`);
  console.log(`      Rows: ${lines.length - 1} (excluding header)`);
  console.log("\n--- Preview (first 5 rows) ---");
  lines.slice(0, 6).forEach((line) => console.log(line));
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Trigger bandwidth report on DO
// ═══════════════════════════════════════════════════════════════════════════

async function triggerBandwidthReport(): Promise<void> {
  const doStateDir = path.resolve(BROWSER_STATE_DIR, "do");
  if (!fs.existsSync(doStateDir)) fs.mkdirSync(doStateDir, { recursive: true });

  const context = await chromium.launchPersistentContext(doStateDir, {
    headless: false,
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    // Go to billing directly — persistent context may still be logged in
    await page.goto("https://cloud.digitalocean.com/account/billing", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // If redirected to login, try auto-fill first, fall back to manual
    if (page.url().includes("/login")) {
      console.log("      DO login required...");

      const consentButton = page.locator("#truste-consent-button");
      if (await consentButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await consentButton.click();
        await page.waitForTimeout(500);
      }

      // Try to auto-fill login
      const emailInput = page.locator("#email");
      if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await emailInput.fill(DO_EMAIL!);
        await page.fill("#password", DO_PASSWORD!);
        await page.click('button[type="submit"]');
      } else {
        console.log("      Could not find login form. Please log in manually...");
      }

      // Wait for login to complete (auto or manual)
      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60000 });
      await page.waitForTimeout(3000);

      // Navigate to billing
      await page.goto("https://cloud.digitalocean.com/account/billing", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }

    // Wait for billing page content to fully render
    await page.waitForTimeout(8000);
    console.log("      On billing page. URL:", page.url());

    // Scroll to make sure bandwidth section is loaded
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Find the CSV button — use exact name to avoid matching "Download Project Spend (CSV)"
    const csvButton = page.getByRole("button", { name: "Bandwidth Detail CSV" });

    await csvButton.waitFor({ timeout: 20000 });
    await csvButton.click();
    await page.waitForTimeout(2000);
    console.log("      Opened CSV dialog.");

    // Select month/year
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const selects = page.locator("select");
    if (await selects.count() >= 2) {
      await selects.first().selectOption({ label: monthNames[targetMonth - 1] }).catch(() => {});
      await selects.last().selectOption(String(targetYear)).catch(() => {});
      console.log(`      Selected: ${monthNames[targetMonth - 1]} ${targetYear}`);
    }

    // Click Submit
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/graphql") && (res.request().postData()?.includes("requestBandwidthReport") ?? false),
        { timeout: 10000 }
      ).catch(() => null),
      page.getByRole("button", { name: /submit/i }).or(page.locator('button:has-text("Submit")')).click(),
    ]);

    if (response) {
      console.log("      Report requested successfully.");
    } else {
      console.log("      Submit clicked.");
    }
    console.log("      CSV will be sent to email.");

  } finally {
    await context.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Fetch CSV from Gmail (manual login on first run, persistent after)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchCsvFromGmail(): Promise<string | null> {
  const gmailStateDir = path.resolve(BROWSER_STATE_DIR, "gmail");
  if (!fs.existsSync(gmailStateDir)) fs.mkdirSync(gmailStateDir, { recursive: true });

  const context = await chromium.launchPersistentContext(gmailStateDir, {
    headless: false,
    locale: "en-US",
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // Navigate to Gmail
    await page.goto("https://mail.google.com/mail/u/0/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Check if login is needed
    if (!page.url().includes("mail.google.com/mail")) {
      console.log("      Gmail login required. Please log in manually in the browser window.");
      console.log("      Waiting for you to complete login...\n");

      // Wait for Gmail inbox to load (up to 5 min for manual login)
      await page.waitForURL("**/mail/**", { timeout: 5 * 60 * 1000 });
      await page.waitForTimeout(3000);
      console.log("      Gmail login successful. Session saved for future runs.\n");
    } else {
      console.log("      Using saved Gmail session.");
    }

    // ── Poll for the bandwidth CSV email ──────────────────────────────────
    const deadline = Date.now() + GMAIL_POLL_TIMEOUT_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      process.stdout.write(`      Attempt ${attempt}... `);

      // Search Gmail
      const searchQuery = "from:digitalocean subject:bandwidth has:attachment newer_than:1h";
      await page.goto(
        `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(searchQuery)}`,
        { waitUntil: "domcontentloaded", timeout: 20000 }
      );
      await page.waitForTimeout(3000);

      // Check for email rows — wait for them to be visible (Gmail lazy-renders)
      const emailRows = page.locator("tr.zA");
      const firstRow = emailRows.first();
      const isVisible = await firstRow.isVisible({ timeout: 3000 }).catch(() => false);

      if (isVisible) {
        // Click to open the email
        await firstRow.scrollIntoViewIfNeeded();
        await firstRow.click({ timeout: 5000 });
        await page.waitForTimeout(4000);

        // Try to download CSV attachment
        const csvContent = await downloadCsvAttachment(page);
        if (csvContent) {
          return csvContent;
        }

        // Go back to search results for next attempt
        await page.goBack();
        await page.waitForTimeout(2000);
      }

      console.log("not yet.");
      await sleep(GMAIL_POLL_INTERVAL_MS);
    }

    console.log("\n      Timed out waiting for CSV email.");
    return null;

  } finally {
    await context.close();
  }
}

/** Download CSV attachment from the currently open Gmail email */
async function downloadCsvAttachment(page: Page): Promise<string | null> {
  // Look for download buttons on attachments
  const downloadButtons = page.locator('[aria-label*="Download"], [data-tooltip="Download"]');
  const dlCount = await downloadButtons.count();

  for (let i = 0; i < dlCount; i++) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        downloadButtons.nth(i).click(),
      ]);

      if (download) {
        const filename = download.suggestedFilename();
        if (filename.endsWith(".csv")) {
          const filePath = await download.path();
          if (filePath) {
            console.log(`found! (${filename})`);
            return fs.readFileSync(filePath, "utf-8");
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Fallback: direct CSV links
  const csvLinks = page.locator('a[href*=".csv"], a[download*=".csv"]');
  if (await csvLinks.count() > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        csvLinks.first().click(),
      ]);
      if (download?.suggestedFilename().endsWith(".csv")) {
        const filePath = await download.path();
        if (filePath) {
          console.log(`found! (${download.suggestedFilename()})`);
          return fs.readFileSync(filePath, "utf-8");
        }
      }
    } catch {}
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
