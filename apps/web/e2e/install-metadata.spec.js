import { expect, test } from "@playwright/test";

// #49: role-specific install entry points. The web app manifest must offer
// Field and Driver shortcuts so installed apps can jump straight into the
// right workspace. #85: install metadata (name/description/shortcuts) is
// localized — EN default, ID opt-in via pythia_lang.
test("both manifests serve valid metadata with field and driver shortcuts", async ({ request }) => {
  for (const [href, lang, name] of [
    ["/manifest.id.webmanifest", "id", "Pythia"],
    ["/manifest.webmanifest", "en", "Pythia"],
  ]) {
    const res = await request.get(href);
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();

    expect(manifest.name).toBe(name);
    expect(manifest.lang).toBe(lang);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");

    // #49: role shortcuts. /field merged into the
    // driver app, so the field shortcut opens its Instruksi tab.
    const urls = manifest.shortcuts.map((s) => s.url);
    expect(urls).toContain("/driver?tab=instruksi");
    expect(urls).not.toContain("/field");
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

test("default (no language set) installs with the English manifest", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("pythia_lang"));
  await page.reload();
  const href = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href);
  expect(href).toMatch(/\/manifest\.webmanifest$/);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
});

test("switching to ID swaps install metadata to the Indonesian manifest", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("pythia_lang", "id"));
  await page.reload();
  const href = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href);
  expect(href).toContain("/manifest.id.webmanifest");
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("id");
  await page.evaluate(() => localStorage.removeItem("pythia_lang"));
});
