/**
 * Debug script — capture DO login page structure to identify the correct selectors.
 */
import "dotenv/config";
import { chromium } from "@playwright/test";
import * as path from "path";

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto("https://cloud.digitalocean.com/login", { waitUntil: "networkidle", timeout: 30000 });

  // Screenshot
  const screenshotPath = path.resolve(__dirname, "../data/do-login-page.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log("Screenshot saved to:", screenshotPath);

  // Dump page URL (might redirect)
  console.log("Current URL:", page.url());

  // Dump all input elements
  const inputs = await page.locator("input").all();
  console.log(`\nFound ${inputs.length} input elements:`);
  for (const input of inputs) {
    const attrs = await input.evaluate((el) => {
      const a: Record<string, string> = {};
      for (const attr of el.attributes) a[attr.name] = attr.value;
      return a;
    });
    console.log("  <input", Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" "), "/>");
  }

  // Dump all buttons
  const buttons = await page.locator("button").all();
  console.log(`\nFound ${buttons.length} button elements:`);
  for (const btn of buttons) {
    const text = await btn.textContent();
    const attrs = await btn.evaluate((el) => {
      const a: Record<string, string> = {};
      for (const attr of el.attributes) a[attr.name] = attr.value;
      return a;
    });
    console.log(`  <button ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}>${text?.trim()}</button>`);
  }

  // Dump all links that look like login-related
  const links = await page.locator("a").all();
  console.log(`\nFound ${links.length} link elements (showing login-related):`);
  for (const link of links) {
    const href = await link.getAttribute("href");
    const text = await link.textContent();
    if (href && (href.includes("login") || href.includes("sign") || href.includes("auth") || href.includes("sso"))) {
      console.log(`  <a href="${href}">${text?.trim()}</a>`);
    }
  }

  // Keep browser open for 30 seconds for manual inspection
  console.log("\nBrowser will stay open for 30 seconds...");
  await page.waitForTimeout(30000);

  await browser.close();
}

main().catch(console.error);
