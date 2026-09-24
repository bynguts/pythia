import { expect, test } from "@playwright/test";

// #79: every visible and assistive login string follows ID/EN through one
// catalog; the selected locale is available before authentication and
// persists after login.
test("login surface follows the selected locale end to end", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("jwis_lang", lang), "en");
  await page.goto("/");

  // Story panel + labels + placeholders in EN.
  await expect(page.locator(".login-story-kicker")).toContainText("Operations command center");
  await expect(page.locator(".login-story-copy h1")).toContainText("One decision.");
  await expect(page.locator(".login-story-copy p")).toContainText("Forecast service load");
  await expect(page.locator('label:has(input[autocomplete="username"]) > span')).toHaveText("Username");
  await expect(page.locator('label:has(input[autocomplete="current-password"]) > span')).toHaveText("Password");
  await expect(page.getByPlaceholder("e.g. dispatcher")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(".login-story-footer")).toContainText("Jakarta Environmental Agency");

  // Switch to ID on the login surface itself.
  await page.locator(".login-language button", { hasText: "ID" }).click();
  await expect(page.locator(".login-story-kicker")).toContainText("Pusat kendali operasional");
  await expect(page.locator(".login-story-copy h1")).toContainText("Satu keputusan.");
  await expect(page.locator('label:has(input[autocomplete="username"]) > span')).toHaveText("Nama pengguna");
  await expect(page.locator('label:has(input[autocomplete="current-password"]) > span')).toHaveText("Kata sandi");
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tampilkan kata sandi" })).toBeVisible();
  await expect(page.locator(".login-story-footer")).toContainText("Dinas Lingkungan Hidup");

  // The ID choice must survive authentication into the shell.
  await page.locator("input[autocomplete=\"username\"]").fill("dispatcher");
  await page.locator("input[autocomplete=\"current-password\"]").fill("dispatcher-demo-pass");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.locator(".command-nav-label")).toHaveText("Ruang kerja");
});

test("invalid credentials error follows the locale", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("jwis_lang", lang), "en");
  await page.goto("/");
  await page.locator("input[autocomplete=\"username\"]").fill("nope");
  await page.locator("input[autocomplete=\"current-password\"]").fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".login-error")).toContainText("Invalid username or password.");

  await page.locator(".login-language button", { hasText: "ID" }).click();
  await page.locator("input[autocomplete=\"username\"]").fill("nope");
  await page.locator("input[autocomplete=\"current-password\"]").fill("wrong");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.locator(".login-error")).toContainText("Nama pengguna atau kata sandi tidak valid.");
});
