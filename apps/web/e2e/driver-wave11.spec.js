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
    // Wave 13: the design's order, Instructions / Route / Report / TPA.
    await expect(tabs).toContainText(["Instruksi", "Rute", "Lapor", "TPA"]);
    await expect(page.getByTestId("driver-tab-rute")).toHaveAttribute("aria-current", "page");
    const nav = await box(page.locator(".driver-tabs"));
    expect(Math.round(nav.y + nav.height)).toBe(800);
    for (const tab of await tabs.all()) {
      const b = await box(tab);
      expect(b.height).toBeGreaterThanOrEqual(52);
      expect(b.width).toBeGreaterThanOrEqual(52);
    }
    await expectNoOverflow(page);
  });
}

test("the route screen leads with the current stop; the rest are in the all-stops sheet", async ({
  page,
  request,
}) => {
  await openWith(page, request, fakeSpj(["completed", "pending", "pending"]));

  // Wave 13: a full-bleed map with the current stop in the bottom sheet.
  const route = page.getByTestId("driver-route-overview");
  await expect(route).toBeVisible({ timeout: 15000 });
  await expect(route.getByTestId("driver-route-map")).toBeVisible();
  const sheet = page.getByTestId("stop-1");
  // The heading keeps "Titik n: name" for assistive tech while the name reads large.
  await expect(sheet.getByRole("heading", { name: "Titik 2: TPS W11 2" })).toBeVisible();
  const start = await box(sheet.getByTestId("stop-start"));
  expect(start.height).toBeGreaterThanOrEqual(48);

  // Done and later stops are rows in the "Semua titik" sheet, not cards.
  await page.getByTestId("driver-all-stops").click();
  const list = page.getByTestId("driver-stops-sheet");
  await expect(list.getByTestId("stop-0")).toHaveClass(/drt-stop is-done/);
  await expect(list.getByTestId("stop-0")).toContainText("SELESAI");
  await expect(list.getByTestId("stop-row-next")).toHaveAttribute("aria-current", "step");
  await expect(list.getByTestId("stop-2")).toHaveClass(/is-locked/);
  const rowMaps = list.getByTestId("stop-maps-2");
  await expect(rowMaps).toHaveAccessibleName("Buka rute ke TPS W11 3 di Google Maps");
  const rowBox = await box(rowMaps);
  expect(rowBox.width).toBeGreaterThanOrEqual(44);
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  await expect(list.getByTestId("destination-card")).toContainText("Tujuan: TPST Bantargebang");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // TPA before the stops are done: the screen says how many are left.
  await page.getByTestId("driver-tab-tpa").click();
  await expect(page.getByTestId("tpa-waiting")).toContainText("Selesaikan 2 titik lagi");
  await expect(page.getByTestId("delivery-card")).toHaveCount(0);
});

test("with every stop done the app opens on the TPA tab and its one action is the gate arrival", async ({
  page,
  request,
}) => {
  await openWith(page, request, fakeSpj(["completed", "completed"]));
  await expect(page.getByTestId("driver-tab-tpa")).toHaveAttribute("aria-current", "page");
  const delivery = page.getByTestId("delivery-card");
  await expect(delivery).toBeVisible({ timeout: 15000 });
  // Wave 13: one action at the gate first ("I'm at the gate"), then the ticket camera.
  const gate = await box(delivery.getByTestId("gate-arrival"));
  expect(gate.height).toBeGreaterThanOrEqual(48);
  await expect(page.getByTestId("destination-card")).toContainText("TPST Bantargebang");
  await expect(page.getByTestId("driver-route-overview")).toHaveCount(0);

  // An explicit tab choice is kept: the route is one tap away.
  await page.getByTestId("driver-tab-rute").click();
  await expect(page).toHaveURL(/tab=rute/);
  await page.getByTestId("driver-all-stops").click();
  await expect(page.getByTestId("driver-route-progress")).toHaveText("2 dari 2 titik");
  await expect(page.getByTestId("delivery-card")).toHaveCount(0);
});

test("the product login is the designed split with a statement and a pixel band", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", "id");
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Masuk ke Pythia" })).toBeVisible();
  const art = await box(page.locator(".si-art"));
  expect(Math.round(art.width)).toBeGreaterThanOrEqual(600);
  expect(art.x).toBeGreaterThan(600);
  await expect(page.locator(".si-band")).toHaveAttribute("aria-hidden", "true");
  const submit = page.getByRole("button", { name: "Masuk", exact: true });
  expect((await box(submit)).height).toBeGreaterThanOrEqual(44);

  // A phone gets the form alone with the brand above it.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator(".si-art")).toBeHidden();
  await expect(page.locator(".si-logo")).toBeVisible();
  await expectNoOverflow(page);
  for (const target of [
    page.getByTestId("login-lang-switch"),
    page.getByRole("button", { name: /Tampilkan kata sandi/ }),
  ]) {
    expect((await box(target)).height).toBeGreaterThanOrEqual(44);
  }
});
