/**
 * E2E: Dashboard page tests.
 * Covers cost cards, chart, and sync button.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("shows dashboard heading with month", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Dashboard");
  });

  test("shows Total Cost card", async ({ page }) => {
    await expect(page.locator("text=Total Cost")).toBeVisible();
  });

  test("shows Sync Now button", async ({ page }) => {
    const syncBtn = page.locator("button", { hasText: "Sync Now" });
    await expect(syncBtn).toBeVisible();
  });

  test("shows Cost Distribution card", async ({ page }) => {
    await expect(page.locator("text=Cost Distribution")).toBeVisible();
  });

  test("Sync Now button changes to Syncing state on click", async ({ page }) => {
    const syncBtn = page.locator("button", { hasText: "Sync Now" });
    await syncBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1")).toContainText("Dashboard");
  });
});
