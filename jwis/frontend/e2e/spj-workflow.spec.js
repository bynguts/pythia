import { expect, test } from "@playwright/test";
import { assertNoLeftoverActiveSpj, cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-210";

test.afterAll(async () => {
  await disposeCleanupContext();
});

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", "id");
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, principal);
  await page.reload({ waitUntil: "domcontentloaded" });
  return { Authorization: `Bearer ${principal.token}` };
}

test("admin sees SPJ in panel, expands it, and activates it", async ({ page }) => {
  const headers = await signIn(page);
  const existing = await page.request.get(`${API}/spj`);
  for (const spj of (await existing.json()).spj || []) {
    if (spj.truck_code === TEST_TRUCK && ["draft", "aktif"].includes(spj.status)) {
      await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers });
    }
  }

  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: "E2E Driver",
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: false,
      priority: "normal",
      note: "e2e",
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();

  const stop = await page.request.post(`${API}/spj/${spj.spj_id}/stops`, {
    headers,
    data: { name: "TPS E2E", kecamatan: "Cilandak", address: "Jl. E2E 1", lat: -6.29, lng: 106.79 },
  });
  expect(stop.ok()).toBeTruthy();

  try {
    await page.getByRole("button", { name: "Surat Perintah Jalan" }).click();
    await expect(page.getByText(spj.spj_number).first()).toBeVisible({ timeout: 15000 });
    await page.getByText(spj.spj_number).first().click();
    await page.getByRole("button", { name: "Ubah ke aktif" }).click();
    await expect(page.getByText("Aktif", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  } finally {
    // #89: independent bounded context, not page.request.
    const token = headers.Authorization.slice(7);
    const outcome = await cancelSpjIndependently(token, spj.spj_id);
    console.log(`[cleanup] ${spj.spj_number}: ${outcome}`);
    await assertNoLeftoverActiveSpj(token);
  }
});

test("Fleet SPJ mutations and lifecycle labels follow authorization and ID/EN", async ({ page }) => {
  // The scenario now also exercises the permission-gated supervisor override,
  // which adds a second sign-in round trip to the flow.
  test.setTimeout(150000);
  const headers = await signIn(page);
  const dispatcherToken = headers.Authorization.slice(7);
  const driverLogin = await page.request.post(`${API}/auth/login`, {
    data: { username: "driver", password: "driver-demo-pass" },
  });
  expect(driverLogin.ok()).toBeTruthy();
  const { token: driverToken } = await driverLogin.json();
  const sites = await page.request.get(`${API}/geo/tps-coordinates`);
  expect(sites.ok()).toBeTruthy();
  const site = (await sites.json()).features[0].properties.name;
  const created = [];
  const panel = page.locator(".spj-panel");
  const row = (number) => panel.locator(".spj-row").filter({ hasText: number });
  const status = (number) => row(number).locator("td").last();
  // The scenario drives T-209, and a truck holds at most one active SPJ, so a
  // leftover from an earlier run must be cleared or activation is refused.
  const existing = await page.request.get(`${API}/spj`);
  for (const spj of (await existing.json()).spj || []) {
    if (spj.truck_code === "T-209" && ["draft", "aktif"].includes(spj.status)) {
      await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers });
    }
  }
  async function addStop() {
    await panel.locator(".spj-form input[list='spj-sites']").fill(site);
    await panel.getByRole("button", { name: "Tambah titik" }).click();
  }
  async function createOrder() {
    await panel.locator(".spj-form select").first().selectOption("T-209");
    await addStop();
    await addStop();
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/spj") && response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Simpan draf" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const spj = await response.json();
    created.push(spj.spj_id);
    await expect(row(spj.spj_number)).toBeVisible();
    return spj;
  }

  try {
    await page.getByRole("button", { name: "Surat Perintah Jalan" }).click();
    await expect(panel.getByRole("combobox", { name: "Kendaraan" })).toBeVisible();
    const first = await createOrder();
    await expect(status(first.spj_number)).toHaveText("Draf");
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(status(first.spj_number)).toHaveText("Draft");
    await page.getByRole("button", { name: "ID", exact: true }).click();
    await row(first.spj_number).getByRole("button").click();
    await panel.getByRole("button", { name: "Ubah ke aktif" }).click();
    await expect(status(first.spj_number)).toHaveText("Aktif");
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(status(first.spj_number)).toHaveText("Active");
    // The operator panel cannot close a stop without evidence: the old
    // "Mark stop complete" button is gone and the panel says why.
    await expect(panel.getByRole("button", { name: "Mark stop complete" })).toHaveCount(0);
    await expect(panel.getByText(/Stops close only with field evidence/)).toBeVisible();
    // The exceptional path is a reasoned, permission-gated supervisor override:
    // a dispatcher is refused, a supervisor may close the order with a reason.
    await panel.getByRole("button", { name: "Closed by supervisor override" }).click();
    await panel.getByRole("textbox", { name: /Supervisor reason/ }).fill("Bukti lapangan tidak tersedia");
    await panel.getByRole("button", { name: "Complete with reason" }).click();
    await expect(panel.getByRole("alert")).toContainText("cannot perform that dispatch action");
    await expect(status(first.spj_number)).toHaveText("Active");
    const supervisorLogin = await page.request.post(`${API}/auth/login`, {
      data: { username: "supervisor", password: "supervisor-demo-pass" },
    });
    expect(supervisorLogin.ok()).toBeTruthy();
    const { token: supervisorToken } = await supervisorLogin.json();
    await page.evaluate((token) => localStorage.setItem("jwis_token", token), supervisorToken);
    await panel.getByRole("button", { name: "Complete with reason" }).click();
    await expect(status(first.spj_number)).toHaveText("Completed");
    // Both stops of the order carry the same recorded override reason.
    await expect(panel.getByText(/Bukti lapangan tidak tersedia/).first()).toBeVisible();
    await page.evaluate((token) => localStorage.setItem("jwis_token", token), dispatcherToken);
    await page.getByRole("button", { name: "ID", exact: true }).click();
    await expect(status(first.spj_number)).toHaveText("Selesai");

    const second = await createOrder();
    await row(second.spj_number).getByRole("button").click();
    await page.evaluate(() => localStorage.removeItem("jwis_token"));
    await panel.getByRole("button", { name: "Batalkan SPJ" }).click();
    await expect(panel.getByRole("alert")).toContainText("Sesi berakhir");
    await expect(status(second.spj_number)).toHaveText("Draf");
    await page.evaluate((token) => localStorage.setItem("jwis_token", token), driverToken);
    await panel.getByRole("button", { name: "Batalkan SPJ" }).click();
    await expect(panel.getByRole("alert")).toContainText("tidak memiliki izin");
    await expect(status(second.spj_number)).toHaveText("Draf");
    await page.evaluate((token) => localStorage.setItem("jwis_token", token), dispatcherToken);
    await panel.getByRole("button", { name: "Batalkan SPJ" }).click();
    await expect(status(second.spj_number)).toHaveText("Dibatalkan");
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(status(second.spj_number)).toHaveText("Canceled");
    await expect(panel.getByRole("heading", { name: "Dispatch orders" })).toBeVisible();
  } finally {
    // #89: independent bounded context, not page.request.
    for (const id of created) {
      const outcome = await cancelSpjIndependently(dispatcherToken, id);
      console.log(`[cleanup] ${id}: ${outcome}`);
    }
  }
});
