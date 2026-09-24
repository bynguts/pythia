import { expect, test } from "@playwright/test";

/**
 * #84: the service-worker update prompt must follow the command-center locale
 * (id/en), including when the locale changes while the banner is visible.
 *
 * The prompt lives outside React, so this spec drives it through the real
 * integration hooks (`window.jwisShowUpdatePrompt`) and checks both locales
 * plus a live locale switch.
 */

const COPY = {
  id: "Versi baru tersedia — Muat ulang",
  en: "New version available — Reload",
};

async function setLocale(page, lang) {
  await page.evaluate((l) => localStorage.setItem("jwis_lang", l), lang);
}

test("update prompt follows the stored locale and switches live", async ({ page }) => {
  await page.goto("/");
  await setLocale(page, "id");
  await page.reload();

  // Show the imperative prompt the way the SW update flow would.
  await page.evaluate(() => window.jwisShowUpdatePrompt());
  const banner = page.getByRole("button", { name: COPY.id });
  await expect(banner).toBeVisible();

  // Switch locale while the banner is visible: copy must update in place.
  await setLocale(page, "en");
  await page.evaluate(() => window.dispatchEvent(new Event("jwis-lang-change")));
  await expect(page.getByRole("button", { name: COPY.en })).toBeVisible();

  // Reload re-picks up the stored locale for a fresh prompt.
  await page.evaluate(() => document.querySelector(".sw-update-banner")?.remove());
  await setLocale(page, "id");
  await page.reload();
  await page.evaluate(() => window.jwisShowUpdatePrompt());
  await expect(page.getByRole("button", { name: COPY.id })).toBeVisible();
});
