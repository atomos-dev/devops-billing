/**
 * E2E: Login page layout tests.
 * Verifies the login page renders without sidebar/header (standalone layout),
 * uses dark background, and contains all expected UI elements.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Login Page Layout", () => {
  test("login page does NOT show sidebar", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Sidebar should not be present on the login page
    const sidebar = page.locator("aside");
    await expect(sidebar).not.toBeVisible();
  });

  test("login page does NOT show dashboard header", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Dashboard nav items should not be present
    await expect(page.locator("text=Dashboard")).not.toBeVisible();
    await expect(page.locator("text=Bills")).not.toBeVisible();
    await expect(page.locator("text=Resources")).not.toBeVisible();
  });

  test("login page has dark background", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // The wrapper div should have dark background
    const wrapper = page.locator("div.min-h-screen").first();
    const bgColor = await wrapper.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    );
    // bg-[#0F172A] → rgb(15, 23, 42)
    expect(bgColor).toBe("rgb(15, 23, 42)");
  });

  test("login page displays app logo and title", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // "DB" logo badge
    await expect(page.locator("text=DB").first()).toBeVisible();
    // App title
    await expect(page.locator("text=DevOps Billing")).toBeVisible();
  });

  test("login page has centered card layout", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const card = page.locator('[data-slot="card"]');
    await expect(card).toBeVisible();

    // Card should be roughly centered horizontally
    const box = await card.boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(viewport).toBeTruthy();
    // Card center should be near viewport center (within 100px tolerance)
    const cardCenter = box!.x + box!.width / 2;
    const viewportCenter = viewport!.width / 2;
    expect(Math.abs(cardCenter - viewportCenter)).toBeLessThan(100);
  });

  test("login page has sign-in form with required fields", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await expect(page.locator('input[type="text"], input[name="username"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText("Sign In");
  });

  test("login page shows version text", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Deeper Network")).toBeVisible();
  });

  test("login page form submission shows error for invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await page.fill('input[type="text"], input[name="username"]', "wrong");
    await page.fill('input[type="password"]', "wrong");
    await page.click('button[type="submit"]');

    // Should show error message
    await expect(page.locator("text=Invalid username or password")).toBeVisible({ timeout: 5000 });
    // Should still be on login page
    expect(page.url()).toContain("/login");
  });

  test("after login, dashboard DOES show sidebar", async ({ page }) => {
    await login(page);

    // After successful login, sidebar should be visible
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    // And navigation items should be present
    await expect(sidebar.locator("text=Dashboard")).toBeVisible();
    await expect(sidebar.locator("text=Settings")).toBeVisible();
  });

  test("login page uses full viewport height", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const wrapper = page.locator("div.min-h-screen").first();
    const box = await wrapper.boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(viewport).toBeTruthy();
    // Wrapper should fill at least the viewport height
    expect(box!.height).toBeGreaterThanOrEqual(viewport!.height - 1);
  });
});
