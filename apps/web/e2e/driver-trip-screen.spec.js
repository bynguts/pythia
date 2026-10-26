// #w13-driver-trip: the route and TPA screens read GET /driver/trip/{truck} (sent the
// phone's position rounded to ~100 m): a road ETA only for the stop it was computed
// for, the plan's tons per stop and the gate slot as model output, the modelled gate
// queue as bars, and a call button only when a dispatch number is set up. The Report
// tab shows what dispatch did with the driver's own reports.
import { expect, test } from "@playwright/test";
import { apiLogin } from "./lib/driverSpj.js";

const TRUCK = "T-254";

test.use({
  permissions: ["geolocation"],
  geolocation: { latitude: -6.2812345, longitude: 106.7954321, accuracy: 15 },
});

function fakeSpj(statuses) {
  return {
    spj_id: "SPJ-E2E-TRIP",
    spj_number: "DLH-DKI/SPJ/26-10-2026/0471",
    truck_code: TRUCK,
    driver_name: "E2E",
    destination: "TPST Bantargebang",
    status: "aktif",
    stops: statuses.map((status, i) => ({
      name: `TPS Trip ${i + 1}`,
      kecamatan: "Kalideres",
      address: `Jl. Trip ${i + 1}`,
      lat: -6.14 - i * 0.01,
      lng: 106.7 + i * 0.01,
      status,
    })),
  };
}

function tripPayload(over = {}) {
  return {
    truck_code: TRUCK,
    date: "2026-10-26",
    generated_at: new Date().toISOString(),
    spj_id: "SPJ-E2E-TRIP",
    spj_number: "DLH-DKI/SPJ/26-10-2026/0471",
    next_stop: {
      index: 1,
      name: "TPS Trip 2",
      eta_minutes: 6,
      distance_km: 4.7,
      eta_source: "osrm_duration",
      eta_label: "road",
      reason: null,
    },
    next_stop_reason: null,
    stops: [
      { index: 0, name: "TPS Trip 1", status: "completed", expected_tons: null },
      { index: 1, name: "TPS Trip 2", status: "pending", expected_tons: 5.8 },
    ],
    to_tpa: {
      destination: "TPST Bantargebang",
      eta_minutes: 34,
      distance_km: 28.1,
      eta_source: "osrm_duration",
      eta_label: "road",
      reason: null,
    },
    gate_slot: {
      facility: "TPST Bantargebang",
      start: "10:00",
      end: "10:15",
      depart_at: "09:20",
      source: "plan",
      classification: "MODEL_OUTPUT",
    },
    queue_ahead: {
      slots: [
        { start: "09:30", end: "09:45", expected_wait_min: 12, load: 3 },
        { start: "09:45", end: "10:00", expected_wait_min: 18, load: 7 },
        { start: "10:00", end: "10:15", expected_wait_min: 21, load: 8 },
        { start: "10:15", end: "10:30", expected_wait_min: 9, load: 2 },
      ],
      window_minutes: 120,
      classification: "SIMULATED",
      reason: null,
    },
    position_source: "device",
    dispatch_contact: {
      phone: "6281234567890",
      tel: "tel:+6281234567890",
      whatsapp: "https://wa.me/6281234567890",
      reason: null,
    },
    ...over,
  };
}

async function openWith(page, request, spj, trip, { path = "/driver", log = null } = {}) {
  const { token } = await apiLogin(request, "driver");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/spj\?status=aktif(&|$)/, (route) =>
    route.fulfill({ json: { spj: [spj], count: 1 } }),
  );
  await page.route(/\/api\/spj\?status=selesai(&|$)/, (route) =>
    route.fulfill({ json: { spj: [], count: 0 } }),
  );
  await page.route(`**/api/pretrip/today/${TRUCK}`, (route) =>
    route.fulfill({ json: { done: true, truck_code: TRUCK } }),
  );
  const tripUrls = [];
  await page.route(`**/api/driver/trip/${TRUCK}*`, (route) => {
    tripUrls.push(route.request().url());
    return route.fulfill({ json: trip });
  });
  await page.goto("/");
  await page.evaluate(
    ({ token, truck, log }) => {
      localStorage.clear();
      localStorage.setItem("pythia_lang", "id");
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: truck }));
      if (log) localStorage.setItem("pythia_driver_exception_log", JSON.stringify(log));
    },
    { token, truck: TRUCK, log },
  );
  await page.goto(path);
  await expect(page.getByTestId("driver-app")).toBeVisible({ timeout: 15000 });
  return tripUrls;
}

test("the route sheet shows the server's road ETA, the plan's tons and a call button", async ({
  page,
  request,
}) => {
  const urls = await openWith(page, request, fakeSpj(["completed", "pending"]), tripPayload());
  const eta = page.getByTestId("driver-eta");
  await expect(eta).toHaveAttribute("data-eta-source", "osrm_duration", { timeout: 15000 });
  await expect(eta).toContainText("~6 mnt");
  await expect(eta).toHaveAttribute("title", "Perkiraan rute jalan");
  await expect(page.getByTestId("driver-load")).toHaveText("~5,8 t untuk dimuat");
  await expect(page.getByTestId("driver-load")).toHaveAttribute("title", /model/i);
  await expect(page.getByTestId("driver-gate-slot")).toHaveText("Slot gerbang 10:00");
  await expect(page.getByTestId("driver-call-dispatch")).toHaveAttribute("href", "tel:+6281234567890");
  // The phone's position leaves the phone rounded to three decimals (~100 m).
  expect(urls.some((u) => u.includes("lat=-6.281") && u.includes("lng=106.795"))).toBe(true);
  expect(urls.every((u) => !u.includes("6.2812345"))).toBe(true);
});

test("an ETA for another stop is not reused and no dispatch number hides the call button", async ({
  page,
  request,
}) => {
  const trip = tripPayload({
    next_stop: { index: 0, name: "TPS Trip 1", eta_minutes: 3, eta_source: "osrm_duration" },
    stops: [],
    dispatch_contact: { phone: null, tel: null, whatsapp: null, reason: "not_configured" },
  });
  await openWith(page, request, fakeSpj(["completed", "pending"]), trip);
  const eta = page.getByTestId("driver-eta");
  await expect(eta).toHaveAttribute("data-eta-source", "fallback_estimate", { timeout: 15000 });
  await expect(eta).toHaveAttribute("title", "Perkiraan garis lurus dari GPS Anda, bukan rute jalan");
  await expect(page.getByTestId("driver-load")).toHaveCount(0);
  await expect(page.getByTestId("stop-start")).toBeVisible();
  await expect(page.getByTestId("driver-call-dispatch")).toHaveCount(0);
});

test("the TPA screen shows the slot's modelled wait, the drive and the queue bars", async ({
  page,
  request,
}) => {
  await openWith(page, request, fakeSpj(["completed", "completed"]), tripPayload(), {
    path: "/driver?tab=tpa",
  });
  const guide = page.getByTestId("tpa-guide");
  await expect(guide.getByTestId("tpa-slot")).toContainText("10:00", { timeout: 15000 });
  await expect(guide.getByTestId("tpa-queue-eta")).toContainText("21 mnt");
  await expect(guide.getByTestId("tpa-queue-eta")).toHaveAttribute("data-provenance", "simulated");
  await expect(guide.getByTestId("destination-maps")).toContainText("~34 mnt perjalanan");
  const bars = page.getByTestId("tpa-queue-bars");
  await expect(bars).toHaveAttribute("data-provenance", "simulated");
  await expect(bars.locator(".drt-bars span")).toHaveCount(4);
  await expect(bars.locator(".drt-bars span.is-mine")).toHaveCount(1);
  await expect(page.getByText("Antrean di gerbang, 2 jam ke depan")).toBeVisible();
});

test("a skipped stop is closed in the stops sheet and never the next stop", async ({ page, request }) => {
  await openWith(page, request, fakeSpj(["completed", "skipped", "pending"]), tripPayload({ stops: [] }));
  // The app's own next-stop pick lives in DriverApp; here the sheet shows the skip.
  await page.getByTestId("driver-all-stops").click({ timeout: 15000 });
  const sheet = page.getByTestId("driver-stops-sheet");
  await expect(sheet.getByTestId("stop-1")).toContainText("DILEWATI");
  await expect(sheet.getByTestId("stop-maps-1")).toHaveCount(0);
  await expect(sheet.getByTestId("driver-route-progress")).toHaveText("2 dari 3 titik");
});

test("the Report tab shows dispatch's follow-up on the driver's own reports", async ({ page, request }) => {
  const at = new Date().toISOString();
  const log = [
    { op: "exc-e2e-seen", kind: "road_closed", at, stop: null },
    { op: "exc-e2e-handled", kind: "tps_empty", at, stop: "TPS Trip 1" },
    { op: "exc-e2e-sent", kind: "accident", at, stop: null },
  ];
  await page.route(`**/api/driver/exceptions?truck_code=${TRUCK}`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            exceptions: [
              { operation_id: "exc-e2e-seen", report_status: "seen" },
              { operation_id: "exc-e2e-handled", report_status: "handled" },
              { operation_id: "exc-e2e-sent", report_status: "sent" },
            ],
            count: 3,
          },
        })
      : route.fallback(),
  );
  await openWith(page, request, fakeSpj(["pending"]), tripPayload(), { path: "/driver?tab=lapor", log });
  const items = page.getByTestId("exc-log").locator("li");
  await expect(items.nth(0).locator("[data-status]")).toHaveText("Dilihat dispatch", { timeout: 15000 });
  await expect(items.nth(1).locator("[data-status]")).toHaveText("Sudah ditangani");
  await expect(items.nth(1)).toContainText("TPS Trip 1");
  await expect(items.nth(2).locator("[data-status]")).toHaveText("Terkirim");
});
