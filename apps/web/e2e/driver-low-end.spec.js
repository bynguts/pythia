// #drv6-lowend: R1, R2 and R4 for /driver on a 2 GB phone without ARCore.
// AR is offered only after a capability check and never blocks a step;
// primary driver controls are at least 48 px (wave 13) with no overflow at 320 px;
// pre-trip is two taps and an instruction one; the route downloads at most
// 250 KB gzip of JS before the first interaction (no map, 3D or PDF chunks).
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { apiLogin, cancelSpj, createActiveSpj, finishPretrip, openDriver, PHOTO } from "./lib/driverSpj.js";

const STOP = { name: "TPS Ringan E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 2 });
    Object.defineProperty(Navigator.prototype, "xr", { configurable: true, get: () => undefined });
  });
});

test("a 2 GB phone without ARCore gets no AR button and finishes the stop with 48 px controls", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-230", [STOP]);
  // R1: a budget UNISOC/Helio CPU, emulated as Chromium's 4x slowdown.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await openDriver(page, request, { token, truck: "T-230" });
      await expect(page.getByTestId("stop-0").getByTestId("stop-start")).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId("ar-nav-open")).toHaveCount(0);

      const small = await page.evaluate(() => {
        const out = [];
        const check = (selector, min) =>
          document.querySelectorAll(selector).forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.height < min || r.width < min)) {
              out.push(
                `${selector} "${el.textContent.trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
              );
            }
          });
        // Wave 13: 48 px drawn buttons, 44 px icon and link hit boxes.
        check(".drt-btn", 48);
        check(".drt-icon-btn", 44);
        check(".drt-chip-btn", 44);
        check(".driver-tab", 44);
        return out;
      });
      expect(small, `controls below target at ${width}px`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }

    // Pre-trip: two taps; the stop flow runs with AR unavailable.
    await finishPretrip(page);
    await page.getByTestId("driver-tab-rute").click();
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();
    await card.getByTestId("arrival-input").setInputFiles(PHOTO);
    await card.getByTestId("officer-input").setInputFiles(PHOTO);
    await card.getByTestId("officer-name").fill("Petugas Ringan");
    await card.getByTestId("stop-finish").click();
    await page.getByTestId("driver-tab-tpa").click();
    await expect(page.getByTestId("delivery-card")).toBeVisible({ timeout: 15000 });
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("/driver loads at most 250 KB gzip of JS before the first interaction", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const scripts = [];
  page.on("response", (res) => {
    if (res.request().resourceType() === "script" && res.ok()) scripts.push(res);
  });
  await openDriver(page, request, { token, truck: "T-230" });
  scripts.length = 0; // count the /driver navigation only, not the bootstrap page
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("driver-app")).toBeVisible();

  const urls = scripts.map((r) => r.url());
  for (const heavy of [
    /maplibre/,
    /three\.module/,
    /TwinWorkspace/,
    /XrTabletop/,
    /html2pdf/,
    /LiveFleetMap/,
    /ArNavigator/,
  ]) {
    expect(
      urls.filter((u) => heavy.test(u)),
      `${heavy} must stay lazy on /driver`,
    ).toEqual([]);
  }
  let gzip = 0;
  for (const res of scripts) gzip += gzipSync(await res.body(), { level: 9 }).length;
  expect(gzip, `JS before interaction: ${(gzip / 1024).toFixed(1)} KB gzip`).toBeLessThanOrEqual(250 * 1024);
});
