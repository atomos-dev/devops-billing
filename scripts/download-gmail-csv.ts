/**
 * Download DO bandwidth CSV from Gmail.
 * Uses persistent browser profile — first run requires manual login.
 *
 * Usage: npx tsx scripts/download-gmail-csv.ts
 */
import "dotenv/config";
import { chromium, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BROWSER_STATE_DIR = path.resolve(__dirname, "../data/browser-state/gmail");
const OUTPUT_DIR = path.resolve(__dirname, "../data");

async function main() {
  if (!fs.existsSync(BROWSER_STATE_DIR)) fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(BROWSER_STATE_DIR, {
    headless: false,
    locale: "en-US",
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // ── Navigate to Gmail ─────────────────────────────────────────────────
    console.log("Opening Gmail...");
    await page.goto("https://mail.google.com/mail/u/0/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Check if login needed
    if (!page.url().includes("mail.google.com/mail")) {
      console.log("Please log in manually in the browser window...");
      await page.waitForURL("**/mail/**", { timeout: 5 * 60 * 1000 });
      await page.waitForTimeout(3000);
      console.log("Login successful.\n");
    } else {
      console.log("Using saved session.\n");
    }

    // ── Search for bandwidth email ────────────────────────────────────────
    console.log("Searching for DO bandwidth email...");
    const searchQuery = "from:digitalocean subject:bandwidth has:attachment";
    await page.goto(
      `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(searchQuery)}`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );

    // Wait for Gmail to fully render search results
    // Gmail renders rows asynchronously — wait for a visible, clickable row
    console.log("Waiting for search results to render...");
    const firstRow = page.locator("tr.zA").first();
    await firstRow.waitFor({ state: "visible", timeout: 15000 });
    console.log("Found email, opening...");

    await firstRow.click();

    // Wait for email content to load
    await page.waitForTimeout(5000);

    // ── Download CSV attachment ───────────────────────────────────────────
    console.log("Looking for CSV attachment...");

    // Take screenshot for debugging
    await page.screenshot({ path: path.join(OUTPUT_DIR, "gmail-email.png") });

    // Try method 1: download buttons with aria-label
    const downloadButtons = page.locator('[aria-label*="Download"], [data-tooltip*="Download"]');
    let dlCount = await downloadButtons.count();
    console.log(`Found ${dlCount} download buttons.`);

    for (let i = 0; i < dlCount; i++) {
      try {
        const btn = downloadButtons.nth(i);
        const label = await btn.getAttribute("aria-label") || await btn.getAttribute("data-tooltip") || "";
        console.log(`  Trying button ${i}: ${label}`);

        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 10000 }),
          btn.click(),
        ]);

        const filename = download.suggestedFilename();
        console.log(`  Downloaded: ${filename}`);

        if (filename.endsWith(".csv")) {
          const filePath = await download.path();
          if (filePath) {
            const content = fs.readFileSync(filePath, "utf-8");
            const outputPath = path.join(OUTPUT_DIR, filename);
            fs.writeFileSync(outputPath, content);

            const lines = content.split("\n").filter(Boolean);
            console.log(`\nCSV saved to: ${outputPath}`);
            console.log(`Size: ${(content.length / 1024).toFixed(1)} KB`);
            console.log(`Rows: ${lines.length - 1} (excluding header)`);
            console.log("\n--- Preview (first 5 rows) ---");
            lines.slice(0, 6).forEach((line) => console.log(line));
            return;
          }
        }
      } catch (e) {
        console.log(`  Button ${i} failed, trying next...`);
      }
    }

    // Try method 2: look for attachment chips at the bottom of email
    console.log("\nTrying attachment chips...");
    const attachmentChips = page.locator('[role="listitem"] [data-tooltip*="Download"]')
      .or(page.locator('.aZo [data-tooltip*="Download"]'))
      .or(page.locator('[download]'));

    dlCount = await attachmentChips.count();
    console.log(`Found ${dlCount} attachment chips.`);

    for (let i = 0; i < dlCount; i++) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 10000 }),
          attachmentChips.nth(i).click(),
        ]);

        const filename = download.suggestedFilename();
        if (filename.endsWith(".csv")) {
          const filePath = await download.path();
          if (filePath) {
            const content = fs.readFileSync(filePath, "utf-8");
            const outputPath = path.join(OUTPUT_DIR, filename);
            fs.writeFileSync(outputPath, content);
            console.log(`\nCSV saved to: ${outputPath}`);
            return;
          }
        }
      } catch {
        continue;
      }
    }

    console.log("\nCould not find CSV attachment to download.");
    console.log("Screenshot saved to data/gmail-email.png for debugging.");

  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
