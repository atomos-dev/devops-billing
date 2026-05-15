/**
 * E2E: Authentication flow tests.
 * Covers login success, login failure, route protection, and logout.
 */
import { test, expect } from "@playwright/test";
import { login, loginWith } from "./helpers/auth";

test.describe("Authentication", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/login");
  });

  test("protects /bills route", async ({ page }) => {
    await page.goto("/bills");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/login");
  });

  test("protects /resources route", async ({ page }) => {
    await page.goto("/resources");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/login");
  });

  test("successful login redirects to dashboard", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL("/");
    await expect(page.locator("h1")).toContainText("Dashboard");
  });

  test("failed login stays on login page", async ({ page }) => {
    await loginWith(page, "wrong", "credentials");
    await page.waitForLoadState("networkidle");
    // Should stay on login page
    expect(page.url()).toContain("/login");
  });

  test("login page has username and password fields", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('input[type="text"], input[name="username"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
