// driver AR navigation — fake camera + emulated GPS + synthetic
// compass events drive the arrow and distance; arriving inside 35 m captures
// the camera frame into the stop's normal arrival-evidence flow.
import { expect, test } from "@playwright/test";
import {
  ARRIVAL_RADIUS_M,
  cameraHeading,
  circularMean,
  formatDistance,
  haversineMeters,
  headingFromOrientation,
  initialBearing,
  normalizeAngle,
  relativeAngle,
  unwrapAngle,
} from "../src/surfaces/driver/arMath.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const PHOTO = "e2e/fixtures/test-photo.png";
const TEST_TRUCK = "T-247";
const STOP = { lat: -6.29, lng: 106.79 };
const FAR = { latitude: -6.2925, longitude: 106.7878, accuracy: 12 }; // ~370 m SW of the stop
const NEAR = { latitude: -6.2911, longitude: 106.7893, accuracy: 12 }; // ~145 m
const ARRIVED = { latitude: -6.29008, longitude: 106.79006, accuracy: 12 }; // ~11 m

async function apiLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dispatcher", password: "dispatcher-demo-pass" }),
  });
  expect(res.ok).toBeTruthy();
  return res.json();
}

async function cancelTruckSpj(headers) {
  for (const status of ["aktif", "draft"]) {
    const body = await (await fetch(`${API}/spj?status=${status}`)).json();
    for (const s of body.spj || []) {
      if (s.truck_code === TEST_TRUCK) {
        await fetch(`${API}/spj/${s.spj_id}/cancel`, { method: "POST", headers });
      }
    }
  }
}

async function createActiveSpj(headers) {
  const fleet = await (await fetch(`${API}/fleet`)).json();
  const truck = (Array.isArray(fleet) ? fleet : fleet.trucks).find((t) => t.truck_code === TEST_TRUCK);
  const res = await fetch(`${API}/spj`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      driver_name: truck.driver_name,
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: true,
      note: "e2e driver AR",
      stops: [
        { name: "TPS AR Cilandak", kecamatan: "Cilandak", address: "Jl. AR E2E 1", ...STOP },
        {
          name: "TPS AR Kebayoran",
          kecamatan: "Kebayoran Baru",
          address: "Jl. AR E2E 2",
          lat: -6.24,
          lng: 106.8,
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const spj = await res.json();
  const activate = await fetch(`${API}/spj/${spj.spj_id}/activate`, { method: "POST", headers });
  expect(activate.status).toBe(200);
  return { spj, truck };
}

async function openDriver(page, principal, truck, lang = "id") {
  await page.goto("/");
  await page.evaluate(
    ({ token, driver, lang }) => {
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify(driver));
      localStorage.removeItem("pythia_driver_outbox");
    },
    {
      token: principal.token,
      driver: { driver_name: truck.driver_name, truck_code: truck.truck_code },
      lang,
    },
  );
  await page.goto("/driver");
}

// Several identical readings so the circular-mean smoother settles exactly.
async function orient(page, alpha) {
  await page.evaluate((a) => {
    for (let i = 0; i < 8; i += 1) {
      window.dispatchEvent(
        new DeviceOrientationEvent("deviceorientationabsolute", {
          alpha: a,
          beta: 90,
          gamma: 0,
          absolute: true,
        }),
      );
    }
  }, alpha);
}

// Chromium's synthetic camera (a moving test pattern) stands in for the phone
// camera; the fallback tests stub getUserMedia to fail instead.
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

const arrowAngle = async (page) =>
  Number(await page.getByTestId("ar-arrow").getAttribute("data-relative-angle"));
const fixOf = (g) => ({ lat: g.latitude, lng: g.longitude });

test("arMath: distance, bearing, relative angle and circular smoothing", () => {
  // One degree of latitude ≈ 111.2 km; due north/east bearings.
  expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeGreaterThan(111000);
  expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeLessThan(111400);
  expect(initialBearing({ lat: -6.3, lng: 106.8 }, { lat: -6.2, lng: 106.8 })).toBeCloseTo(0, 5);
  expect(initialBearing({ lat: 0, lng: 106.8 }, { lat: 0, lng: 106.9 })).toBeCloseTo(90, 5);
  expect(initialBearing({ lat: -6.2, lng: 106.8 }, { lat: -6.3, lng: 106.8 })).toBeCloseTo(180, 5);
  // Relative angle lives in (-180, 180].
  expect(relativeAngle(10, 350)).toBeCloseTo(20, 9);
  expect(relativeAngle(350, 10)).toBeCloseTo(-20, 9);
  expect(normalizeAngle(-180)).toBe(180);
  expect(normalizeAngle(540)).toBe(180);
  // Circular mean of 350° and 10° is north, not south.
  expect(circularMean([350, 10])).toBeCloseTo(0, 6);
  expect(circularMean([80, 100])).toBeCloseTo(90, 6);
  expect(circularMean([0, 180])).toBeNull();
  // Phone held upright: camera heading = 360 − alpha; iOS compass wins outright.
  expect(cameraHeading(30, 90, 0)).toBeCloseTo(330, 6);
  expect(cameraHeading(30, 0, 0)).toBeCloseTo(330, 6); // flat fallback
  // Near flat the camera axis flips 180° as beta crosses zero; the top-edge
  // heading keeps ±0.5° (and anything within ~24° of flat) on one answer.
  expect(cameraHeading(30, 0.5, 0)).toBeCloseTo(330, 6);
  expect(cameraHeading(30, -0.5, 0)).toBeCloseTo(330, 6);
  expect(cameraHeading(30, 0.5, 0.3)).toBeCloseTo(cameraHeading(30, -0.5, -0.3), 6);
  expect(cameraHeading(30, 60, 0)).toBeCloseTo(330, 6); // tilted up: the camera axis
  expect(headingFromOrientation({ type: "deviceorientation", webkitCompassHeading: 45 }).heading).toBe(45);
  // iOS: accuracy −1 means an uncalibrated compass → treated as no compass.
  expect(
    headingFromOrientation({
      type: "deviceorientation",
      webkitCompassHeading: 45,
      webkitCompassAccuracy: -1,
    }),
  ).toBeNull();
  expect(
    headingFromOrientation({ type: "deviceorientation", webkitCompassHeading: 45, webkitCompassAccuracy: 10 })
      .heading,
  ).toBe(45);
  // Unwrapped rotation takes the short way across 0° and ±180°.
  expect(unwrapAngle(null, 45)).toBe(45);
  expect(unwrapAngle(350, 10)).toBeCloseTo(370, 9);
  expect(unwrapAngle(10, 350)).toBeCloseTo(-10, 9);
  expect(unwrapAngle(170, -170)).toBeCloseTo(190, 9);
  expect(unwrapAngle(-170, 170)).toBeCloseTo(-190, 9);
  expect(headingFromOrientation({ type: "deviceorientation", absolute: false, alpha: 10 })).toBeNull();
  expect(formatDistance(1234, "id")).toBe("1,2 km");
  expect(formatDistance(1234, "en")).toBe("1.2 km");
  expect(formatDistance(87.4, "en")).toBe("87 m");
  expect(ARRIVAL_RADIUS_M).toBe(35);
});

test.describe("AR navigator with camera + compass", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "geolocation"],
    geolocation: FAR,
  });

  test("arrow follows the compass, distance follows GPS, arrival capture feeds stop evidence", async ({
    page,
    context,
  }) => {
    test.setTimeout(120000);
    const principal = await apiLogin();
    const headers = { Authorization: `Bearer ${principal.token}` };
    await cancelTruckSpj(headers);
    const { spj, truck } = await createActiveSpj(headers);
    try {
      await openDriver(page, principal, truck);
      const stop0 = page.getByTestId("stop-0");
      const open = stop0.getByTestId("ar-nav-open");
      await expect(open).toBeVisible({ timeout: 20000 });
      const box = await open.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      await expect(page.getByTestId("stop-1").getByTestId("ar-nav-open")).toHaveCount(0); // locked stop
      await open.click();

      const nav = page.getByTestId("ar-navigator");
      await expect(nav).toBeVisible();
      await expect(nav).toHaveAttribute("data-view", "camera", { timeout: 15000 });
      await expect.poll(() => page.getByTestId("ar-video").evaluate((v) => v.videoWidth)).toBeGreaterThan(0);
      await expect(page.getByTestId("ar-honest")).toHaveText(
        "AR untuk petugas berjalan kaki: GPS + kompas ponsel, akurasi ±10–30 m; terkunci saat kendaraan melaju",
      );
      // The first stop has no planned leg (the route starts there): the
      // arrow is a straight bearing and says so.
      await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-reason", "first", {
        timeout: 15000,
      });
      await expect(page.getByTestId("ar-accuracy")).toHaveText("GPS ±12 m");

      const distance = page.getByTestId("ar-distance");
      await expect(distance).toBeVisible({ timeout: 15000 });
      const farMeters = haversineMeters(fixOf(FAR), STOP);
      expect(Math.abs(Number(await distance.getAttribute("data-meters")) - farMeters)).toBeLessThanOrEqual(1);
      await expect(distance).toHaveText(formatDistance(farMeters, "id"));

      // Without a live compass the camera view still shows the 2D compass
      // card, never a street-anchored-looking floor arrow.
      await expect(page.getByTestId("ar-compass")).toBeVisible();
      await expect(nav.locator(".ar-arrow-3d")).toHaveCount(0);

      // Compass: facing north (alpha 0) the arrow shows the raw bearing; facing
      // west (alpha 90 → heading 270) it swings by 90°.
      const bearing = initialBearing(fixOf(FAR), STOP);
      await orient(page, 0);
      await expect(nav).toHaveAttribute("data-heading-mode", "compass");
      await expect(nav.locator(".ar-arrow-3d")).toBeVisible();
      await expect(page.getByTestId("ar-compass")).toHaveCount(0);
      await expect.poll(() => arrowAngle(page)).toBe(Math.round(relativeAngle(bearing, 0)));
      await orient(page, 90);
      await expect.poll(() => arrowAngle(page)).toBe(Math.round(relativeAngle(bearing, 270)));
      await expect(page.getByTestId("ar-guidance")).toHaveText(
        /Belok (kanan|kiri) \d+°|Putar balik|Lurus ke depan/,
      );
      await orient(page, 360 - bearing); // face the stop
      await expect.poll(() => arrowAngle(page)).toBe(0);
      await expect(page.getByTestId("ar-guidance")).toHaveText("Lurus ke depan");

      // Crossing ±180° (target at 170° right → 170° left) turns the arrow 20°
      // the short way, not 340° back around.
      const cssAngle = () =>
        nav.locator(".ar-arrow-plane").evaluate((el) => parseFloat(el.style.getPropertyValue("--ar-angle")));
      await orient(page, 360 - (bearing - 170)); // heading = bearing − 170 → target +170°
      await expect.poll(() => arrowAngle(page)).toBe(170);
      const before = await cssAngle();
      await orient(page, 360 - (bearing + 170)); // heading = bearing + 170 → target −170°
      await expect.poll(() => arrowAngle(page)).toBe(-170);
      expect(Math.abs((await cssAngle()) - before)).toBeCloseTo(20, 0);
      await orient(page, 360 - bearing);
      await expect.poll(() => arrowAngle(page)).toBe(0);

      // GPS: walking closer changes the distance; inside 35 m the stop is reached.
      await context.setGeolocation(NEAR);
      await expect(distance).toHaveText(formatDistance(haversineMeters(fixOf(NEAR), STOP), "id"), {
        timeout: 15000,
      });
      await expect(page.getByTestId("ar-arrived")).toHaveCount(0);
      await context.setGeolocation(ARRIVED);
      await expect(page.getByTestId("ar-arrived")).toBeVisible({ timeout: 15000 });
      await expect(nav).toHaveAttribute("data-arrived", "true");

      await page.getByTestId("ar-capture").click();
      await expect(nav).toHaveCount(0);
      // Camera tracks are released when the navigator closes.
      await expect(page.locator("video")).toHaveCount(0);

      // The frame is now the stop's arrival photo inside the normal form.
      const evidence = stop0.getByTestId("arrival-ar-evidence");
      await expect(evidence).toBeVisible({ timeout: 10000 });
      await expect(evidence).toContainText("Diambil di AR · GPS ±12 m");
      await expect(stop0.getByText(/Foto terlampir: ar-stop1-.*\.jpg/)).toBeVisible();
      const img = await evidence
        .locator("img")
        .evaluate((el) => ({ src: el.src.slice(0, 23), w: el.naturalWidth }));
      expect(img.src).toBe("data:image/jpeg;base64,");
      expect(img.w).toBeGreaterThan(0);

      // Finish the stop through the existing flow; the server stores the AR fix.
      await stop0.getByTestId("weigh-input").setInputFiles(PHOTO);
      await stop0.getByLabel("Berat (kg)").fill("85");
      await stop0.getByRole("button", { name: "Tambah Timbangan" }).click();
      await stop0.getByTestId("officer-input").setInputFiles(PHOTO);
      await stop0.getByLabel("Nama Petugas").fill("Petugas AR");
      await stop0.getByRole("button", { name: "Selesaikan Titik" }).click();
      await expect(stop0.getByText("SELESAI")).toBeVisible({ timeout: 15000 });

      const detail = await (await fetch(`${API}/spj/${spj.spj_id}`)).json();
      expect(detail.stops[0].status).toBe("completed");
      const arrival = detail.stops[0].evidence.arrival;
      expect(arrival.source).toBe("ar");
      expect(arrival.photo_name).toMatch(/^ar-stop1-.*\.jpg$/);
      expect(arrival.photo_b64.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(arrival.lat).toBeCloseTo(ARRIVED.latitude, 6);
      expect(arrival.lng).toBeCloseTo(ARRIVED.longitude, 6);
      expect(arrival.accuracy_m).toBe(12);
      expect(arrival.approx).toBe(false);
      // The fix's own timestamp travels with the evidence, and it can never
      // be later than the capture.
      expect(arrival.fix_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(arrival.fix_at)).toBeLessThanOrEqual(Date.parse(arrival.at));
      expect(Date.parse(arrival.at) - Date.parse(arrival.fix_at)).toBeLessThan(15000);
    } finally {
      await cancelTruckSpj(headers);
    }
  });

  // A fix older than 15 s must not certify arrival evidence.
  test("a stale GPS fix disables capture and says the signal is lost", async ({ page, context }) => {
    test.setTimeout(120000);
    const principal = await apiLogin();
    const headers = { Authorization: `Bearer ${principal.token}` };
    await cancelTruckSpj(headers);
    const { truck } = await createActiveSpj(headers);
    try {
      // The page clock runs at real speed until fast-forwarded; the browser's
      // GPS timestamps keep real time, so jumping the clock ages the fix.
      await page.clock.install();
      await context.setGeolocation(ARRIVED);
      await openDriver(page, principal, truck, "en");
      await page.getByTestId("stop-0").getByTestId("ar-nav-open").click();
      const nav = page.getByTestId("ar-navigator");
      await expect(nav).toHaveAttribute("data-view", "camera", { timeout: 15000 });
      await expect(page.getByTestId("ar-arrived")).toBeVisible({ timeout: 15000 });
      await expect(nav).toHaveAttribute("data-gps-fresh", "true");
      const capture = page.getByTestId("ar-capture");
      await expect(capture).toBeEnabled();
      await expect(page.getByTestId("ar-gps-stale")).toHaveCount(0);

      await page.clock.fastForward(20000);
      await expect(nav).toHaveAttribute("data-gps-fresh", "false");
      await expect(capture).toBeDisabled();
      await expect(page.getByTestId("ar-gps-stale")).toHaveText(
        "GPS signal lost — waiting for a fresh fix. Capture is paused.",
      );
      // The old fix still drives the readout, but nothing claims it is current.
      await expect(page.getByTestId("ar-distance")).toBeVisible();

      // A fresh fix re-enables capture.
      await page.clock.setSystemTime(Date.now());
      await context.setGeolocation({ ...ARRIVED, accuracy: 9 });
      await expect(nav).toHaveAttribute("data-gps-fresh", "true", { timeout: 15000 });
      await expect(capture).toBeEnabled();
      await expect(page.getByTestId("ar-gps-stale")).toHaveCount(0);
    } finally {
      await cancelTruckSpj(headers);
    }
  });
});

test.describe("AR navigator fallbacks", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
    geolocation: FAR,
  });

  test("camera denied + no compass → 2D compass card with a north-up arrow", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    const principal = await apiLogin();
    const headers = { Authorization: `Bearer ${principal.token}` };
    await cancelTruckSpj(headers);
    const { truck } = await createActiveSpj(headers);
    try {
      await openDriver(page, principal, truck, "en");
      await page.getByTestId("stop-0").getByTestId("ar-nav-open").click();
      const nav = page.getByTestId("ar-navigator");
      await expect(nav).toHaveAttribute("data-view", "compass");
      await expect(page.getByTestId("ar-camera-off")).toHaveText(/Camera unavailable/);
      await expect(page.getByTestId("ar-compass")).toBeVisible();
      // No orientation events at all (desktop) → north-up after the sensor window.
      await expect(nav).toHaveAttribute("data-heading-mode", "north-up", { timeout: 8000 });
      await expect(page.getByTestId("ar-notice")).toHaveText(/north-up map/);
      const bearing = initialBearing(fixOf(FAR), STOP);
      await expect.poll(() => arrowAngle(page)).toBe(Math.round(bearing));
      await expect(page.getByTestId("ar-honest")).toHaveText(
        "AR for crews on foot: phone GPS + compass, accuracy ±10–30 m; locks while the vehicle moves",
      );

      // Focus stays inside the dialog while it is open.
      const focusInside = () =>
        page.evaluate(() =>
          document.querySelector("[data-testid=ar-navigator]").contains(document.activeElement),
        );
      await expect(page.getByTestId("ar-nav-close")).toBeFocused();
      for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        expect(await focusInside()).toBe(true);
      }

      // Close is always reachable, restores the driver screen and hands focus
      // back to the button that opened the dialog.
      await page.getByTestId("ar-nav-close").click();
      await expect(nav).toHaveCount(0);
      await expect(page.getByTestId("stop-0")).toBeVisible();
      await expect(page.getByTestId("stop-0").getByTestId("ar-nav-open")).toBeFocused();
    } finally {
      await cancelTruckSpj(headers);
    }
  });

  test("a stop without coordinates shows an honest no-coordinate state", async ({ page }) => {
    const truck = { truck_code: TEST_TRUCK, driver_name: "E2E AR" };
    const fake = {
      spj_id: "SPJ-AR-NOCOORD",
      spj_number: "DLH-DKI/SPJ/E2E-AR",
      truck_code: TEST_TRUCK,
      driver_name: "E2E AR",
      destination: "TPST Bantargebang",
      status: "aktif",
      stops: [
        {
          name: "TPS Tanpa Koordinat",
          kecamatan: "Cilandak",
          address: "Jl. Tanpa Peta",
          lat: null,
          lng: null,
          status: "pending",
        },
      ],
    };
    await page.route(/\/api\/spj\?status=aktif$/, (route) =>
      route.fulfill({ json: { spj: [fake], count: 1 } }),
    );
    await page.route(/\/api\/spj\?status=selesai$/, (route) =>
      route.fulfill({ json: { spj: [], count: 0 } }),
    );
    // The /driver sign-in gate needs a valid field session even when the data is stubbed.
    await openDriver(page, await apiLogin(), truck);
    await page.getByTestId("stop-0").getByTestId("ar-nav-open").click();
    await expect(page.getByTestId("ar-no-coordinate")).toContainText("Titik ini belum punya koordinat");
    await expect(page.getByTestId("ar-arrow")).toHaveCount(0);
    await page.getByRole("button", { name: "Pakai formulir foto" }).click();
    await expect(page.getByTestId("ar-navigator")).toHaveCount(0);
    await expect(page.getByTestId("arrival-input")).toBeVisible();
  });
});
