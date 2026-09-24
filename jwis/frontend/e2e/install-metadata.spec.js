import { expect, test } from "@playwright/test";

// #49: role-specific install entry points. The web app manifest must offer
// Field and Driver shortcuts so installed apps can jump straight into the
// right workspace. #85: install metadata (name/description/shortcuts) is
// localized — ID default, EN opt-in via jwis_lang.
test("both manifests serve valid metadata with field and driver shortcuts", async ({ request }) => {
  for (const [href, lang, name] of [
    ["/manifest.id.webmanifest", "id", "Sistem Intelijen Sampah Jakarta"],
    ["/manifest.webmanifest", "en", "Jakarta Waste Intelligence System"],
  ]) {
    const res = await request.get(href);
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();

    expect(manifest.name).toBe(name);
    expect(manifest.lang).toBe(lang);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");

    // #49: role shortcuts for the two PWA surfaces.
    const urls = manifest.shortcuts.map((s) => s.url);
    expect(urls).toContain("/field");
    expect(urls).toContain("/driver");
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.name.length).toBeGreaterThan(0);
      expect(shortcut.icons.length).toBeGreaterThan(0);
    }

    // Declared icons must resolve.
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.ok()).toBeTruthy();
    }
  }
});

test("default (no language set) installs with the Indonesian manifest", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("jwis_lang"));
  await page.reload();
  const href = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href);
  expect(href).toContain("/manifest.id.webmanifest");
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("id");
});

test("switching to EN swaps install metadata to the English manifest", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("jwis_lang", "en"));
  await page.reload();
  const href = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href);
  expect(href).toContain("/manifest.webmanifest");
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
  await page.evaluate(() => localStorage.removeItem("jwis_lang"));
});
