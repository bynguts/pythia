// #drv6-install: the installed driver app opens /driver (not the command-centre
// login) and every manifest ships PNG icons (192 and 512, plus maskable) for
// Android WebAPK installs.
import { expect, test } from "@playwright/test";
import { apiLogin, openDriver } from "./lib/driverSpj.js";

test("driver manifests start at /driver and declare resolvable PNG icons", async ({ request }) => {
  for (const [href, lang, name] of [
    ["/manifest.driver.id.webmanifest", "id", "Pythia Sopir"],
    ["/manifest.driver.webmanifest", "en", "Pythia Driver"],
  ]) {
    const res = await request.get(href);
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toBe(name);
    expect(manifest.lang).toBe(lang);
    expect(manifest.start_url).toBe("/driver");
    expect(manifest.id).toBe("/driver");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.filter((i) => i.type === "image/png").map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.ok()).toBeTruthy();
      if (icon.type === "image/png") expect(iconRes.headers()["content-type"]).toContain("image/png");
    }
  }
  for (const href of ["/manifest.id.webmanifest", "/manifest.webmanifest"]) {
    const manifest = await (await request.get(href)).json();
    expect(manifest.icons.some((i) => i.type === "image/png" && i.sizes === "512x512")).toBe(true);
  }
});

test("/driver points the page at the driver manifest in the current language", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  await openDriver(page, request, { token, truck: "T-231" });
  const href = () =>
    page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute("href"));
  await expect.poll(href).toBe("/manifest.driver.id.webmanifest");
  await openDriver(page, request, { token, truck: "T-231", lang: "en" });
  await expect.poll(href).toBe("/manifest.driver.webmanifest");
});
