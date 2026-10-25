// wave11 driver: the driver PWA in the approved world. Four bottom tabs in shift order
// (Instruksi, Rute, TPA, Lapor), one task per screen: the current stop is the hero of the
// route screen with a 64 px start button, other stops are flat rows, and the landfill
// (gate, weighbridge, receipt camera) is its own TPA tab that opens by itself once every
// stop is done. The product login is a full-bleed split with no case-study footer.
import { expect, test } from "@playwright/test";
import { apiLogin } from "./lib/driverSpj.js";

const TRUCK = "T-254";

function fakeSpj(statuses) {
  return {
    spj_id: "SPJ-E2E-W11",
    spj_number: "DLH-DKI/SPJ/E2E-W11",
    truck_code: TRUCK,
    driver_name: "E2E",
    destination: "TPST Bantargebang",
    status: "aktif",
    stops: statuses.map((status, i) => ({
      name: `TPS W11 ${i + 1}`,
      kecamatan: "Cilandak",
      address: `Jl. Uji ${i + 1}`,
      lat: -6.29 - i * 0.01,
      lng: 106.79 + i * 0.01,
      status,
    })),
  };
}

async function openWith(page, request, spj, { width = 390, path = "/driver" } = {}) {
  const { token } = await apiLogin(request, "driver");
  await page.setViewportSize({ width, height: 800 });
  await page.route(/\/api\/spj\?status=aktif(&|$)/, (route) =>
    route.fulfill({ json: { spj: spj ? [spj] : [], count: spj ? 1 : 0 } }),
  );
  await page.route(/\/api\/spj\?status=selesai(&|$)/, (route) =>
    route.fulfill({ json: { spj: [], count: 0 } }),
  );
  await page.route(`**/api/pretrip/today/${TRUCK}`, (route) =>
    route.fulfill({ json: { done: true, truck_code: TRUCK } }),
  );
  await page.goto("/");
  await page.evaluate(
    ({ token, truck }) => {
      localStorage.clear();
      localStorage.setItem("pythia_lang", "id");
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: truck }));
    },
    { token, truck: TRUCK },
  );
  await page.goto(path);
  await expect(page.getByTestId("driver-app")).toBeVisible({ timeout: 15000 });
}

async function box(locator) {
  const b = await locator.boundingBox();
  expect(b, "element has a box").not.toBeNull();
  return b;
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

for (const width of [390, 320]) {
  test(`four bottom tabs in shift order, pinned to the bottom at ${width} px`, async ({ page, request }) => {
    await openWith(page, request, fakeSpj(["pending", "pending"]), { width });
    const tabs = page.locator(".driver-tabs .driver-tab");
    await expect(tabs).toContainText(["Instruksi", "Rute", "TPA", "Lapor"]);
    await expect(page.getByTestId("driver-tab-rute")).toHaveAttribute("aria-current", "page");
    const nav = await box(page.locator(".driver-tabs"));
    expect(Math.round(nav.y + nav.height)).toBe(800);
    for (const tab of await tabs.all()) {
      const b = await box(tab);
      expect(b.height).toBeGreaterThanOrEqual(56);
      expect(b.width).toBeGreaterThanOrEqual(56);
    }
    await expectNoOverflow(page);
  });
}

test("the route screen leads with the current stop; the rest are flat rows", async ({ page, request }) => {
  await openWith(page, request, fakeSpj(["completed", "pending", "pending"]));

  const hero = page.getByTestId("stop-1");
  await expect(hero).toHaveClass(/stop-hero/);
  await expect(hero.getByText("Titik berikutnya")).toBeVisible();
  // The heading keeps "Titik n: name" for assistive tech while the name reads large.
  await expect(hero.getByRole("heading", { name: "Titik 2: TPS W11 2" })).toBeVisible();
  const start = await box(hero.getByTestId("stop-start"));
  expect(start.height).toBeGreaterThanOrEqual(64);
  expect((await box(hero.getByTestId("stop-maps-1"))).height).toBeGreaterThanOrEqual(56);

  // Hero sits above the route list; done and locked stops are rows, not cards.
  const route = page.getByTestId("driver-route-overview");
  expect((await box(hero)).y).toBeLessThan((await box(route)).y);
  await expect(page.getByTestId("stop-0")).toHaveClass(/stop-row is-done/);
  await expect(page.getByTestId("stop-0")).toContainText("SELESAI");
  await expect(page.getByTestId("stop-2")).toHaveClass(/is-locked/);
  const rowMaps = page.getByTestId("stop-maps-2");
  await expect(rowMaps).toHaveAccessibleName("Buka rute ke TPS W11 3 di Google Maps");
  const rowBox = await box(rowMaps);
  expect(rowBox.width).toBeGreaterThanOrEqual(56);
  expect(rowBox.height).toBeGreaterThanOrEqual(56);
  await expect(route.getByTestId("destination-card")).toContainText("Tujuan: TPST Bantargebang");
  await expect(page.getByTestId("pretrip-done")).toBeVisible();
  await expect(page.locator(".driver-card .driver-card")).toHaveCount(0);

  // TPA before the stops are done: the screen says how many are left.
  await page.getByTestId("driver-tab-tpa").click();
  await expect(page.getByTestId("tpa-waiting")).toContainText("Selesaikan 2 titik lagi");
  await expect(page.getByTestId("delivery-card")).toHaveCount(0);
});

test("with every stop done the app opens on the TPA tab and its one action is the receipt camera", async ({
  page,
  request,
}) => {
  await openWith(page, request, fakeSpj(["completed", "completed"]));
  await expect(page.getByTestId("driver-tab-tpa")).toHaveAttribute("aria-current", "page");
  const delivery = page.getByTestId("delivery-card");
  await expect(delivery).toBeVisible({ timeout: 15000 });
  const camera = await box(page.getByTestId("receipt-camera"));
  expect(camera.height).toBeGreaterThanOrEqual(64);
  await expect(page.getByTestId("destination-card")).toContainText("TPST Bantargebang");
  await expect(page.getByTestId("driver-route-overview")).toHaveCount(0);

  // An explicit tab choice is kept: the route is one tap away.
  await page.getByTestId("driver-tab-rute").click();
  await expect(page).toHaveURL(/tab=rute/);
  await expect(page.getByTestId("driver-route-progress")).toHaveText("2 dari 2 titik");
  await expect(page.getByTestId("delivery-card")).toHaveCount(0);
});

test("the product login is a full-bleed split with a drawn route and no case-study footer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", "id");
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Masuk ke pusat kendali" })).toBeVisible();
  const story = await box(page.locator(".login-story"));
  expect(Math.round(story.x)).toBe(0);
  expect(Math.round(story.height)).toBe(900);
  await expect(page.locator(".login-story-art")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".login-story-footer")).toHaveCount(0);
  await expect(page.locator(".login-eyebrow")).toHaveCount(0);
  const submit = page.getByRole("button", { name: "Masuk", exact: true });
  expect((await box(submit)).height).toBeGreaterThanOrEqual(48);
  expect(await submit.evaluate((el) => getComputedStyle(el).borderRadius)).toMatch(/^9\d\dpx$/);

  // A phone gets the form alone with the brand above it.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator(".login-story")).toBeHidden();
  await expect(page.locator(".login-mobile-brand")).toBeVisible();
  await expectNoOverflow(page);
  for (const button of await page.locator(".login-language button").all()) {
    expect((await box(button)).width).toBeGreaterThanOrEqual(44);
  }
});
