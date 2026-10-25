// wave10 driver-field-app: /driver is the one field app — driver sign-in, truck search, the
// /field merge (Instruksi tab), offline exception buttons, the TPA guide card, small screens.
import { expect, test } from "@playwright/test";
import { API, apiLogin, authHeaders } from "./lib/driverSpj.js";

const TRUCK = "T-254";

async function freshPhone(page, lang = "id") {
  await page.goto("/");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", value);
  }, lang);
}

// Signed in with the shared demo account; `truck` set skips the picker.
async function openDriver(page, token, { truck = TRUCK, lang = "id", path = "/driver" } = {}) {
  await page.goto("/");
  await page.evaluate(
    ({ token, truck, lang }) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
      }
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_field_token", token);
      if (truck)
        localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: truck }));
    },
    { token, truck, lang },
  );
  await page.goto(path);
  await expect(page.getByTestId("driver-app")).toBeVisible({ timeout: 15000 });
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

async function expectTargets(page, selector, min) {
  const boxes = await page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((node) => node.offsetParent !== null)
      .map((node) => {
        const r = node.getBoundingClientRect();
        return {
          label: node.dataset.testid || node.textContent.trim().slice(0, 30),
          w: r.width,
          h: r.height,
        };
      }),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.h, `${box.label} height`).toBeGreaterThanOrEqual(min);
    expect(box.w, `${box.label} width`).toBeGreaterThanOrEqual(min);
  }
}

test("the driver sign-in is titled for drivers and drops the command-centre story", async ({ page }) => {
  await freshPhone(page);
  await page.goto("/driver");
  await expect(page.getByRole("heading", { name: "Masuk aplikasi sopir" })).toBeVisible();
  await expect(page.getByText("Masuk ke pusat kendali")).toHaveCount(0);
  await expect(page.locator(".login-story")).toHaveCount(0);
  const username = page.locator('input[autocomplete="username"]');
  await expect(username).toHaveValue("driver");
  await expect(username).toHaveAttribute("placeholder", "contoh: driver");
  await expectTargets(page, ".login-language button", 44);

  // The command centre keeps its own sign-in.
  await page.goto("/fleet");
  await expect(page.getByRole("heading", { name: "Masuk ke pusat kendali" })).toBeVisible();
});

test("/field redirects to the driver app's Instruksi tab behind the same sign-in", async ({ page }) => {
  await freshPhone(page);
  await page.goto("/field");
  await expect(page).toHaveURL(/\/driver\?tab=instruksi$/);
  await expect(page.getByRole("heading", { name: "Masuk aplikasi sopir" })).toBeVisible();
  await page.locator('input[autocomplete="current-password"]').fill("driver-demo-pass");
  await page.getByRole("button", { name: "Masuk" }).click();

  // One field token: the shared account picks its truck once, then lands on the tab.
  await page.getByTestId("driver-truck-search").fill(TRUCK);
  await page.getByTestId(`pick-${TRUCK}`).click();
  await expect(page.getByTestId("driver-tab-instruksi")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByTestId("driver-instructions-empty").or(page.getByTestId("driver-instructions")),
  ).toBeVisible();
  // No way back into the command centre from the driver app.
  await expect(page.getByText("Kembali ke pusat kendali")).toHaveCount(0);
  await expect(page.locator('a[href="/"]')).toHaveCount(0);
});

test("a bound account opens on its truck; the shared account searches and is remembered", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request, "driver");
  await page.route("**/api/driver/session", (route) =>
    route.fulfill({
      json: {
        username: "sopir-t238",
        role: "driver",
        truck_code: "T-238",
        display_name: "Sopir Uji",
        shared_account: false,
      },
    }),
  );
  await openDriver(page, token, { truck: null });
  await expect(page.locator(".driver-brand small")).toHaveText("T-238");
  await expect(page.getByTestId("driver-truck-search")).toHaveCount(0);
  await page.unroute("**/api/driver/session");

  // Shared demo account: no 59-row list, a search box instead.
  await openDriver(page, token, { truck: null });
  const search = page.getByTestId("driver-truck-search");
  await expect(search).toBeVisible();
  await expect(page.getByRole("heading", { name: "Masukkan kode truk" })).toBeVisible();
  await expect(page.locator('[data-testid^="pick-"]')).toHaveCount(0);
  await search.fill("2");
  await expect.poll(() => page.locator('[data-testid^="pick-"]').count()).toBeLessThanOrEqual(6);
  await search.fill("254");
  await expect(page.getByTestId(`pick-${TRUCK}`)).toBeVisible();
  await search.fill("T-999");
  await expect(page.getByTestId("driver-pick-none")).toBeVisible();
  await search.fill("254");
  await page.getByTestId(`pick-${TRUCK}`).click();
  await expect(page.locator(".driver-brand small")).toHaveText(TRUCK);

  // The choice survives a reload, and "Ganti" offers it again as a recent truck.
  await page.reload();
  await expect(page.locator(".driver-brand small")).toHaveText(TRUCK);
  await page.getByRole("button", { name: "Ganti" }).click();
  await expect(page.getByTestId("driver-pick-recent").getByTestId(`pick-${TRUCK}`)).toBeVisible();
});

test("an exception button queues offline, counts as waiting for signal, then syncs", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request, "driver");
  const dispatcher = await apiLogin(request, "dispatcher");
  await openDriver(page, token, { path: "/driver?tab=lapor" });
  await expect(page.getByTestId("driver-tab-lapor")).toHaveAttribute("aria-current", "page");
  await expectTargets(page, ".driver-exception-btn", 64);
  for (const kind of ["tps_empty", "road_closed", "truck_breakdown", "accident"]) {
    await expect(page.getByTestId(`exc-${kind}`)).toBeVisible();
  }

  await context.setOffline(true);
  await page.getByTestId("exc-road_closed").click();
  await page.getByTestId("exc-note").fill("E2E jalan ditutup");
  await page.getByTestId("exc-send").click();
  await expect(page.getByTestId("driver-queued-count")).toHaveText("1 item menunggu sinyal");
  await expect(page.getByTestId("exc-log")).toContainText("Menunggu sinyal");
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("pythia_driver_outbox") || "[]"));
  expect(queued).toHaveLength(1);
  expect(queued[0].path).toBe("/driver/exceptions");
  const operationId = queued[0].data.operation_id;
  expect(operationId).toMatch(/^exc-/);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("driver-queued-count")).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByTestId("exc-log")).toContainText("Terkirim");
  const listed = await request.get(`${API}/driver/exceptions?truck_code=${TRUCK}`, {
    headers: authHeaders(dispatcher.token),
  });
  const mine = (await listed.json()).exceptions.filter((e) => e.operation_id === operationId);
  expect(mine).toHaveLength(1);
  expect(mine[0].kind).toBe("road_closed");
  expect(mine[0].note).toBe("E2E jalan ditutup");
  expect(mine[0].reported_by).toBe("driver");
});

test("the TPA guide walks gate, weighbridge and zone with labelled modelled values", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request, "driver");
  const fake = {
    spj_id: "SPJ-E2E-TPA-GUIDE",
    spj_number: "DLH-DKI/SPJ/E2E-TPA",
    truck_code: TRUCK,
    driver_name: "E2E",
    destination: "TPST Bantargebang",
    status: "aktif",
    stops: [
      {
        name: "TPS Satu",
        kecamatan: "Cilandak",
        address: "Jl. Satu",
        lat: -6.29,
        lng: 106.79,
        status: "completed",
      },
      {
        name: "TPS Dua",
        kecamatan: "Cilandak",
        address: "Jl. Dua",
        lat: -6.3,
        lng: 106.81,
        status: "completed",
      },
    ],
  };
  await page.route(/\/api\/spj\?status=aktif(&|$)/, (route) =>
    route.fulfill({ json: { spj: [fake], count: 1 } }),
  );
  await page.route(/\/api\/spj\?status=selesai(&|$)/, (route) =>
    route.fulfill({ json: { spj: [], count: 0 } }),
  );
  await page.route("**/api/safety/gate-arrival", (route) =>
    route.fulfill({ status: 201, json: { truck_code: TRUCK, classification: "OBSERVED_APP_EVENTS" } }),
  );
  await openDriver(page, token);

  // wave11 driver: every stop is done, so the app opens on its TPA tab; the route
  // overview now lives on the Rute tab, one task per screen.
  await expect(page.getByTestId("driver-tab-tpa")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("driver-tab-rute").click();

  // L4: today's route in order before the per-stop cards.
  await expect(page.getByTestId("driver-route-overview")).toBeVisible();
  await expect(page.getByTestId("driver-route-progress")).toHaveText("2 dari 2 titik");
  await expect(page.getByTestId("driver-route-sketch")).toBeVisible();
  await expect(page.getByTestId("driver-route-overview")).toContainText("bukan peta jalan");

  await page.getByTestId("driver-tab-tpa").click();
  const guide = page.getByTestId("tpa-guide");
  await expect(guide).toBeVisible({ timeout: 15000 });
  await expect(guide.getByTestId("tpa-guide-sim")).toHaveText("SIMULASI");
  await expect(guide.getByTestId("tpa-queue-ahead")).toContainText("(model)");
  await expect(guide.getByTestId("tpa-queue-ahead")).toContainText(/± \d+ truk/);
  await expect(guide.getByTestId("tpa-queue-eta")).toContainText(/\d+ mnt/);
  await expect(guide.getByTestId("tpa-model-note")).toContainText("simulasi");
  await expect(guide.getByTestId("tpa-step-zone")).toContainText("belum punya data zona aktif");
  // No immersive-ar in the test browser: the 2D card stands alone.
  await expect(guide.getByTestId("tpa-ar-open")).toHaveCount(0);

  await guide.getByTestId("gate-arrival").click();
  await expect(guide.getByTestId("gate-arrived")).toBeVisible();
  await expect(guide.getByTestId("tpa-waited")).toContainText("jam HP");
  await expect(page.getByTestId("receipt-camera")).toBeVisible();
});

for (const width of [320, 390]) {
  test(`every driver tab fits ${width} px with touch-sized controls`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 800 });
    await freshPhone(page);
    await page.goto("/driver");
    await expect(page.getByRole("heading", { name: "Masuk aplikasi sopir" })).toBeVisible();
    await expectNoOverflow(page);

    const { token } = await apiLogin(request, "driver");
    await openDriver(page, token, { truck: null });
    await page.getByTestId("driver-truck-search").fill("254");
    await expect(page.getByTestId(`pick-${TRUCK}`)).toBeVisible({ timeout: 15000 });
    await expectNoOverflow(page);
    await expectTargets(page, ".driver-pick", 44);
    await page.getByTestId(`pick-${TRUCK}`).click();

    for (const tab of ["rute", "instruksi", "tpa", "lapor"]) {
      await page.getByTestId(`driver-tab-${tab}`).click();
      await expect(page.getByTestId(`driver-tab-${tab}`)).toHaveAttribute("aria-current", "page");
      await expectNoOverflow(page);
      await expectTargets(page, ".driver-tab", 44);
    }
    await expectTargets(page, ".driver-exception-btn", 64);
    await page.getByTestId("exc-accident").click();
    await expect(page.getByTestId("exc-call-112")).toHaveAttribute("href", "tel:112");
    await expectNoOverflow(page);
    await expectTargets(page, ".driver-exception-sheet .driver-btn", 44);
    await expect(page.getByRole("main")).toHaveCount(1);
  });
}

test("English mode names the tabs and the exception buttons", async ({ page, request }) => {
  const { token } = await apiLogin(request, "driver");
  await openDriver(page, token, { lang: "en", path: "/driver?tab=lapor" });
  await expect(page.getByTestId("driver-tab-rute")).toHaveText("Route");
  await expect(page.getByTestId("driver-tab-lapor")).toHaveText("Report");
  await expect(page.getByTestId("exc-tps_empty")).toHaveText("TPS empty / waste not put out");
  await expect(page.getByTestId("exc-truck_breakdown")).toHaveText("Truck broken down");
});
