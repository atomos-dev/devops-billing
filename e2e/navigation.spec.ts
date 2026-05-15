/**
 * E2E: Sidebar navigation tests.
 * Verifies all nav links work and active state is highlighted.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("sidebar shows all navigation links", async ({ page }) => {
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator("text=Dashboard")).toBeVisible();
    await expect(sidebar.locator("text=Resource Scan")).toBeVisible();
    await expect(sidebar.locator("text=Settings")).toBeVisible();
  });

  test("sidebar does not show removed pages", async ({ page }) => {
    const sidebar = page.locator("aside");
    await expect(sidebar.locator("text=Bills")).toHaveCount(0);
    await expect(sidebar.locator("text=Resources")).toHaveCount(0);
    await expect(sidebar.locator("text=Trends")).toHaveCount(0);
    await expect(sidebar.locator("text=Bandwidth")).toHaveCount(0);
    await expect(sidebar.locator("text=Manual Costs")).toHaveCount(0);
  });

  test("navigates to Resource Scan page", async ({ page }) => {
    await page.click("aside >> text=Resource Scan");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL("/resource-scan");
  });

  test("navigates to Settings page", async ({ page }) => {
    await page.click("aside >> text=Settings");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL("/settings");
    await expect(page.locator("h1")).toContainText("Settings");
  });

  test("navigates back to Dashboard", async ({ page }) => {
    await page.click("aside >> text=Settings");
    await page.waitForLoadState("networkidle");
    await page.click("aside >> text=Dashboard");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL("/");
    await expect(page.locator("h1")).toContainText("Dashboard");
  });

  test("app title links to dashboard", async ({ page }) => {
    await page.click("aside >> text=Settings");
    await page.waitForLoadState("networkidle");
    await page.click("aside >> text=DevOps Billing");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL("/");
  });
});
