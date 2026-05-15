/**
 * E2E tests for the Resource Scan page.
 * Tests navigation, page rendering, scan triggering, and error handling.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Resource Scan Page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("navigates to resource scan page via sidebar", async ({ page }) => {
    await page.click('a[href="/resource-scan"]');
    await page.waitForURL("/resource-scan");
    await expect(page.locator("h1")).toHaveText("Resource Scan");
  });

  test("renders page header and scan button", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h1")).toHaveText("Resource Scan");
    await expect(page.getByRole("button", { name: /scan resources/i })).toBeVisible();
  });

  test("shows provider selector with options", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Open the provider select
    const trigger = page.locator('button[role="combobox"]');
    await trigger.click();

    await expect(page.getByRole("option", { name: "All Providers" })).toBeVisible();
    await expect(page.getByRole("option", { name: "AWS" })).toBeVisible();
    await expect(page.getByRole("option", { name: "DigitalOcean" })).toBeVisible();
  });

  test("shows scan history section", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Scan History")).toBeVisible();
  });

  test("shows empty state or table for scan history", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    const hasEmptyState = await page.getByText("No scans yet").isVisible().catch(() => false);
    const hasTable = await page.locator("table").isVisible().catch(() => false);

    expect(hasEmptyState || hasTable).toBe(true);
  });

  test("scan button triggers API call", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    const scanRequest = page.waitForRequest(
      (req) => req.url().includes("/api/v1/resource-scan") && req.method() === "POST"
    );

    await page.getByRole("button", { name: /scan resources/i }).click();

    const req = await scanRequest;
    expect(req.method()).toBe("POST");
  });

  test("handles scan error gracefully (409 conflict)", async ({ page }) => {
    await page.goto("/resource-scan");
    await page.waitForLoadState("networkidle");

    // Mock the scan endpoint to return 409
    await page.route("**/api/v1/resource-scan", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "A scan is already running" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.getByRole("button", { name: /scan resources/i }).click();

    // Should show error toast
    await expect(page.getByText(/already running/i)).toBeVisible({ timeout: 5000 });
  });

  test("resource scan link is visible in sidebar", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const scanLink = page.locator('a[href="/resource-scan"]');
    await expect(scanLink).toBeVisible();
    await expect(scanLink).toHaveText(/resource scan/i);
  });
});
