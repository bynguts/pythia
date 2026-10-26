import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-047";

async function cancelLeftover(headers) {
  const res = await fetch(`${API}/spj?status=aktif`, { headers });
  const resp = await res.json();
  for (const s of resp.spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await fetch(`${API}/spj/${s.spj_id}/cancel`, { method: "POST", headers });
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
  // gsc-2026 P0-2: /driver asks for a sign-in first; this test is about the
  // truck picker, so it starts with a valid token.
  const principal = await apiLogin();
  await page.goto("/");
  await page.evaluate((token) => {
    localStorage.setItem("pythia_field_token", token);
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_driver", JSON.stringify(null));
    localStorage.removeItem("pythia_driver");
  }, principal.token);
  await page.goto("/driver");
  await expect(page.getByRole("heading", { name: "Choose your truck" })).toBeVisible();
  await expect(page.getByTestId("driver-pick-start")).toHaveText("Pick a truck");

  // Switch to Indonesian and reload: copy changes and persists.
  await page.evaluate(() => localStorage.setItem("pythia_lang", "id"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pilih truk Anda" })).toBeVisible();
  await expect(page.getByTestId("driver-pick-start")).toHaveText("Pilih truk");
});

test("driver pretrip, stop and receipt surfaces localize end to end", async ({ page, context }) => {
  const principal = await apiLogin();
  const headers = { Authorization: `Bearer ${principal.token}` };
  await cancelLeftover(headers);

  const fleet = await (await fetch(`${API}/fleet`, { headers })).json();
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
      body: JSON.stringify({
        name: "TPS E2E",
        kecamatan: "Cilandak",
        address: "Jl. E2E",
        lat: -6.29,
        lng: 106.79,
      }),
    });
    await fetch(`${API}/spj/${spj.spj_id}/activate`, { method: "POST", headers });

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
    await page.goto("/");
    await page.evaluate((token) => {
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_lang", "en");
      localStorage.removeItem("pythia_driver");
    }, principal.token);
    await page.goto("/driver");
    // wave10 driver-field-app: the shared account searches its truck instead of a 59-row list.
    await page.getByTestId("driver-truck-search").fill(TEST_TRUCK);
    await page.locator(`[data-testid="pick-${TEST_TRUCK}"] button`).click();
    await page.getByTestId("driver-pick-start").click();

    // Pretrip surface in English (Instructions tab).
    await page.getByTestId("driver-tab-instruksi").click();
    await page.getByTestId("driver-start-pretrip").click();
    await expect(page.getByRole("heading", { name: "Pre-trip check" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rest are OK" })).toBeVisible();
    // Regression (#77 refactor follow-up): mark-rest-OK must answer ALL items
    // (a tuple-destructuring leftover left 5/7 answered with 0 active buttons).
    await page.getByRole("button", { name: "Rest are OK" }).click();
    await expect(page.locator(".drv-seg-btn.ok.active")).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
    await expect(page.getByText("Brakes")).toBeVisible();
    await expect(page.getByText("Engine")).toBeVisible();
    await expect(page.getByText("Tyres")).toBeVisible();
    await page.getByTestId("driver-tab-rute").click();

    // The route sheet appears once the active SPJ poll lands (8s interval).
    await expect(page.getByRole("heading", { name: /Stop 1: TPS E2E/ })).toBeVisible({ timeout: 20000 });
    // Wave 13: "I've arrived" opens the stop proof; its three steps read in English.
    await page.getByRole("button", { name: "I've arrived" }).click();
    const proof = page.getByTestId("stop-proof");
    await expect(proof.getByText("Arrival photo", { exact: true })).toBeVisible();
    await expect(proof.getByText("Weight by type")).toBeVisible();
    await expect(proof.getByText("TPS officer")).toBeVisible();
    await expect(proof.getByTestId("stop-finish")).toHaveText(/^Finish stop/);

    // Receipt surface copy is unit-verified via the i18n catalog; the stop
    // flow above covers the step-gated localization.
  } finally {
    await fetch(`${API}/spj/${spj.spj_id}/cancel`, { method: "POST", headers }).catch(() => {});
  }
});
