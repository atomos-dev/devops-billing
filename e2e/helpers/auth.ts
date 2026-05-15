/**
 * E2E auth helper — login utility for Playwright tests.
 * Uses the default credentials (admin/admin) from NextAuth Credentials provider.
 */
import { type Page } from "@playwright/test";

/** Default test credentials (from AUTH_USER / AUTH_PASSWORD env vars or defaults) */
const TEST_USER = process.env.AUTH_USER || "admin";
const TEST_PASS = process.env.AUTH_PASSWORD || "admin";

/** Login and navigate to the dashboard */
export async function login(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  await page.fill('input[name="username"], input[type="text"]', TEST_USER);
  await page.fill('input[type="password"]', TEST_PASS);
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL("/", { timeout: 10000 });
}

/** Login with custom credentials */
export async function loginWith(
  page: Page,
  username: string,
  password: string
) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  await page.fill('input[name="username"], input[type="text"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}
