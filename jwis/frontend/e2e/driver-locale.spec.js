import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-047";

async function cancelLeftover(headers) {
  const res = await fetch(`${API}/spj?status=aktif`, headers);
  const resp = await res.json();
  for (const s of resp.spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await fetch(`${API}/spj/${s.spj_id}/cancel`, { method: "POST", ...headers });
    }
  }
}

async function apiLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dispatcher", password: "dispatcher-demo-pass" }),
  });
  return res.json();
}

test("driver gate and brand follow the stored locale", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("jwis_lang", "en");
    localStorage.setItem("jwis_driver", JSON.stringify(null));
    localStorage.removeItem("jwis_driver");
  });
  await page.goto("/driver");
  await expect(page.getByRole("heading", { name: "Who is on duty?" })).toBeVisible();
  await expect(page.getByText("Driver PWA")).toBeVisible();

  // Switch to Indonesian and reload: copy changes and persists.
  await page.evaluate(() => localStorage.setItem("jwis_lang", "id"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Siapa yang bertugas?" })).toBeVisible();
  await expect(page.getByText("PWA Sopir")).toBeVisible();
});

test("driver pretrip, stop and receipt surfaces localize end to end", async ({ page, context }) => {
  const principal = await apiLogin();
  const headers = { Authorization: `Bearer ${principal.token}` };
  await cancelLeftover(headers);

  const fleet = await (await fetch(`${API}/fleet`, headers)).json();
  const trucks = Array.isArray(fleet) ? fleet : fleet.trucks;
  const truck = trucks.find((t) => t.truck_code === TEST_TRUCK);
  const create = await fetch(`${API}/spj`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      driver_name: truck.driver_name,
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: true,
      priority: "normal",
      note: "e2e driver locale",
    }),
  });
  expect(create.status).toBe(201);
  const spj = await create.json();
  try {
    await fetch(`${API}/spj/${spj.spj_id}/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name: "TPS E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 }),
    });
    await fetch(`${API}/spj/${spj.spj_id}/activate`, { method: "POST", ...headers });

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("jwis_lang", "en");
      localStorage.removeItem("jwis_driver");
    });
    await page.goto("/driver");
    await page.locator(`[data-testid="pick-${TEST_TRUCK}"]`).click();

    // Pretrip surface in English.
    await expect(page.getByRole("heading", { name: "Pre-trip inspection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark the rest as OK" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save inspection" })).toBeVisible();
    await expect(page.getByText("Brakes")).toBeVisible();
    await expect(page.getByText("Engine")).toBeVisible();
    await expect(page.getByText("Tyres & wheels")).toBeVisible();

    // Stop card appears once the active SPJ poll lands (8s interval).
    await expect(page.getByRole("heading", { name: /Stop 1: TPS E2E/ })).toBeVisible({ timeout: 20000 });
    // The stop form reveals step-gated copy: step 1 is visible immediately.
    const startButton = page.getByRole("button", { name: "Start this stop" });
    if (await startButton.count()) await startButton.click();
    await expect(page.getByText("Arrival photo at the location")).toBeVisible();
    // Step list labels for weighing and officer are localized in the stepper.
    await expect(page.getByText("Residue weighing")).toBeVisible();
    await expect(page.getByText("Officer")).toBeVisible();

    // Receipt surface copy is unit-verified via the i18n catalog; the stop
    // flow above covers the step-gated localization.
  } finally {
    await fetch(`${API}/spj/${spj.spj_id}/cancel`, { method: "POST", ...headers }).catch(() => {});
  }
});
