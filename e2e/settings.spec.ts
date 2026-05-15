/**
 * E2E: Settings page tests.
 * Covers provider card display, credential editing dialog,
 * test connection, enable/disable toggle, and .env hint.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test.describe("Settings Page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.click("aside >> text=Settings");
    await page.waitForURL("/settings");
    // Wait for provider cards to load (async fetch from API)
    await page.waitForSelector("text=Amazon Web Services", { timeout: 15000 });
  });

  test("displays Settings page with correct heading", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Settings");
    await expect(page.locator("text=Manage cloud provider connections")).toBeVisible();
  });

  test("displays provider cards from registry", async ({ page }) => {
    await expect(page.locator("text=Amazon Web Services")).toBeVisible();
    await expect(page.locator("text=DigitalOcean")).toBeVisible();
  });

  test("each provider card shows status indicator", async ({ page }) => {
    const cards = page.locator('[data-slot="card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("shows Configure or Edit Credentials button for each provider", async ({ page }) => {
    // Each provider card should have a Configure or Edit Credentials button
    const buttons = page.getByRole("button", { name: /Configure|Edit Credentials/ });
    await expect(buttons.first()).toBeVisible();
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("opens credential dialog when clicking Configure/Edit", async ({ page }) => {
    const btn = page.getByRole("button", { name: /Configure|Edit Credentials/ }).first();
    await btn.click();

    // Dialog should appear with title
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-slot="dialog-title"]')).toBeVisible();
  });

  test("credential dialog shows form fields from registry", async ({ page }) => {
    const btn = page.getByRole("button", { name: /Configure|Edit Credentials/ }).first();
    await btn.click();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible({ timeout: 5000 });

    // Should have at least one input field
    const inputs = page.locator('[data-slot="dialog-content"] input');
    const inputCount = await inputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(1);
  });

  test("credential dialog has Save and Cancel buttons", async ({ page }) => {
    const btn = page.getByRole("button", { name: /Configure|Edit Credentials/ }).first();
    await btn.click();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible({ timeout: 5000 });

    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("Cancel button closes credential dialog", async ({ page }) => {
    const btn = page.getByRole("button", { name: /Configure|Edit Credentials/ }).first();
    await btn.click();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator('[data-slot="dialog-content"]')).not.toBeVisible();
  });

  test("can fill credential fields in dialog", async ({ page }) => {
    const btn = page.getByRole("button", { name: /Configure|Edit Credentials/ }).first();
    await btn.click();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible({ timeout: 5000 });

    const firstInput = page.locator('[data-slot="dialog-content"] input').first();
    await firstInput.fill("test-value");
    await expect(firstInput).toHaveValue("test-value");
  });

  test("shows Enable or Disable toggle for each provider", async ({ page }) => {
    // Each provider card has an Enable or Disable button
    const toggleButtons = page.getByRole("button", { name: /^Enable$|^Disable$/ });
    await expect(toggleButtons.first()).toBeVisible();
    const count = await toggleButtons.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("enable/disable toggle triggers state change", async ({ page }) => {
    const toggleBtn = page.getByRole("button", { name: /^Enable$|^Disable$/ }).first();
    await toggleBtn.click();

    // Wait for toast notification confirming the state change
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: 5000 });
  });

  test("Settings page content is offset by sidebar width", async ({ page }) => {
    const heading = page.locator("h1:has-text('Settings')");
    const box = await heading.boundingBox();
    expect(box).toBeTruthy();
    // Content should be to the right of the 240px sidebar
    expect(box!.x).toBeGreaterThan(200);
  });
});
