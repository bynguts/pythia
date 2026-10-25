// gsc-2026 P0-2/P0-3/M1/n17: phone path — public surfaces sign in in place; the dispatcher can add a DEMO stop at its own position.
import { expect, test } from "@playwright/test";
import { cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const DEMO_TRUCK = "T-210";
// A phone fix outside Jakarta: the DEMO stop must work wherever the demo runs.
const PHONE_FIX = { latitude: 37.5045, longitude: 126.9571 };

test.afterAll(async () => {
  await disposeCleanupContext();
});

async function freshPhone(page, lang = "en") {
  await page.goto("/");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", value);
  }, lang);
}

test("a fresh phone on /driver signs in as the driver in place and keeps the deep link", async ({ page }) => {
  await freshPhone(page);
  await page.goto("/driver");

  await expect(page.getByTestId("login-notice")).toHaveText(
    "Sign in as the driver to complete stops and sync queued work.",
  );
  await expect(page.getByTestId("driver-app")).toHaveCount(0);
  const username = page.locator('input[autocomplete="username"]');
  await expect(username).toHaveValue("driver");
  await page.locator('input[autocomplete="current-password"]').fill("driver-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByTestId("driver-app")).toBeVisible();
  await expect(page).toHaveURL(/\/driver$/);
  expect(await page.evaluate(() => localStorage.getItem("pythia_field_role"))).toBe("driver");
  expect(await page.evaluate(() => Boolean(localStorage.getItem("pythia_field_token")))).toBe(true);
  // gsc M1: the field gate never signs the command center in.
  expect(await page.evaluate(() => localStorage.getItem("pythia_auth"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("pythia_token"))).toBeNull();
});

// wave10 driver-field-app: /field now redirects to the driver app's Instruksi tab, behind the same gate.
test("a token the backend no longer knows brings the sign-in back on /field", async ({ page }) => {
  await freshPhone(page, "id");
  await page.evaluate(() => localStorage.setItem("pythia_field_token", "token-from-before-a-restart"));
  await page.goto("/field");
  await expect(page).toHaveURL(/\/driver\?tab=instruksi$/);

  await expect(page.getByTestId("login-notice")).toBeVisible();
  await expect(page.locator('input[autocomplete="username"]')).toHaveValue("driver");
  expect(await page.evaluate(() => localStorage.getItem("pythia_field_token"))).toBeNull();
});

test("/xr stays public: no sign-in on a fresh phone", async ({ page }) => {
  await freshPhone(page);
  await page.goto("/xr");
  await expect(page.getByTestId("xr-canvas")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("login-notice")).toHaveCount(0);
});

test("dispatcher adds a DEMO stop at the device position and it is stored DEMO-labelled", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(PHONE_FIX);
  await page.goto("/");
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(login.ok()).toBeTruthy();
  const principal = await login.json();
  const headers = { Authorization: `Bearer ${principal.token}` };
  for (const spj of (await (await page.request.get(`${API}/spj`, { headers })).json()).spj || []) {
    if (spj.truck_code === DEMO_TRUCK && ["draft", "aktif"].includes(spj.status)) {
      await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers });
    }
  }
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.reload({ waitUntil: "domcontentloaded" });

  await page.getByRole("tab", { name: "Surat jalan (SPJ)" }).click(); // wave9 fleet composition: records tab
  const demo = page.getByTestId("spj-demo-stop");
  await expect(demo).toHaveText(/DEMO/);
  await expect(page.getByText(/Hanya DEMO: .*35 m/)).toBeVisible();
  // #spj-demo-leg: a DEMO stop needs a real TPS stop before it, so it is stop 2 and
  // the leg into it starts on the road network (the AR street path follows it).
  await demo.click();
  await expect(page.getByText(/Tambah titik TPS dulu/)).toBeVisible();
  await expect(page.getByTestId("spj-demo-badge")).toHaveCount(0);
  const site = await page.locator("#spj-sites option").first().getAttribute("value", { timeout: 15000 });
  await page.getByRole("combobox", { name: "Cari lokasi TPS…" }).fill(site);
  await page.getByRole("button", { name: "Tambah titik", exact: true }).click();
  await demo.click();
  await expect(page.getByTestId("spj-demo-badge")).toHaveText("DEMO");
  await expect(page.locator(".spj-stop-list")).toContainText("DEMO · Lokasi operator");
  // gsc-2026 n17: a second DEMO stop gets a distinct name, so saving does not hit the duplicate-stop 409.
  await demo.click();
  await expect(page.getByTestId("spj-demo-badge")).toHaveCount(2);
  await expect(page.locator(".spj-stop-list")).toContainText("DEMO · Lokasi operator 2");

  await page.getByRole("combobox", { name: "Kendaraan" }).selectOption(DEMO_TRUCK);
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page.locator(".spj-stop-list")).toHaveCount(0, { timeout: 10000 });

  const drafts = (
    (await (await page.request.get(`${API}/spj?status=draft`, { headers })).json()).spj || []
  ).filter((spj) => spj.truck_code === DEMO_TRUCK);
  const created = drafts.at(-1);
  try {
    expect(created.note).toContain("DEMO");
    expect(created.stops).toHaveLength(3);
    expect(created.stops[0].name).toBe(site);
    expect(created.stops[0].location_type).not.toBe("DEMO");
    expect(created.stops[1].name).toBe("DEMO · Lokasi operator");
    expect(created.stops[2].name).toBe("DEMO · Lokasi operator 2");
    expect(created.stops[1].location_type).toBe("DEMO");
    expect(created.stops[1].lat).toBeCloseTo(PHONE_FIX.latitude, 4);
    expect(created.stops[1].lng).toBeCloseTo(PHONE_FIX.longitude, 4);
  } finally {
    for (const spj of drafts) await cancelSpjIndependently(principal.token, spj.spj_id);
  }
});
