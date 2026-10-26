// Work orders (/app/work-orders): the SPJ list, its lifecycle actions and their authorization.
import { expect, test } from "@playwright/test";
import {
  assertNoLeftoverActiveSpj,
  cancelSpjIndependently,
  disposeCleanupContext,
} from "./lib/spjCleanup.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-210";

test.afterAll(async () => {
  await disposeCleanupContext();
});

async function signIn(page, role = "dispatcher", lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role: signedIn, lang: language }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", language);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", signedIn);
    },
    { ...principal, lang },
  );
  await page.goto("/app/work-orders", { waitUntil: "domcontentloaded" });
  return { Authorization: `Bearer ${principal.token}` };
}

async function clearTruck(page, headers, truck) {
  const existing = await page.request.get(`${API}/spj`, { headers });
  for (const spj of (await existing.json()).spj || []) {
    if (spj.truck_code === truck && ["draft", "aktif"].includes(spj.status)) {
      await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers });
    }
  }
}

const rowOf = (page, number) => page.getByTestId("wo-row").filter({ hasText: number });

async function find(page, tab, number) {
  await page.getByTestId(`wo-tab-${tab}`).click();
  await page.getByTestId("wo-search").fill(number);
  await expect(rowOf(page, number)).toBeVisible({ timeout: 15000 });
  await rowOf(page, number).click();
  await expect(page.getByTestId("wo-detail")).toContainText(number);
}

test("a dispatcher finds a draft work order and activates it", async ({ page }) => {
  const headers = await signIn(page);
  await clearTruck(page, headers, TEST_TRUCK);
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await find(page, "drafts", spj.spj_number);
    await page.getByTestId("wo-activate").click();
    await expect(page.getByTestId("wo-activate")).toHaveCount(0, { timeout: 10000 });
    await find(page, "active", spj.spj_number);
    await expect(rowOf(page, spj.spj_number)).toContainText("Diaktifkan");
  } finally {
    // #89: independent bounded context, not page.request.
    const token = headers.Authorization.slice(7);
    const outcome = await cancelSpjIndependently(token, spj.spj_id);
    console.log(`[cleanup] ${spj.spj_number}: ${outcome}`);
    await assertNoLeftoverActiveSpj(token);
  }
});

// #w14-walk: tomorrow's plan draft cannot be worked today; Activate says which day it opens.
test("a draft for tomorrow cannot be activated today and says when it can", async ({ page }) => {
  const headers = await signIn(page, "dispatcher", "en");
  const supervisor = await page.request.post(`${API}/auth/login`, {
    data: { username: "supervisor", password: "supervisor-demo-pass" },
  });
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  const created = await page.request.post(`${API}/operations/plan?top_n=1&plan_date=${tomorrow}`, {
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const plan = await created.json();
  const approved = await page.request.post(`${API}/operations/${plan.plan_id}/approve`, {
    headers: { Authorization: `Bearer ${(await supervisor.json()).token}` },
  });
  expect(approved.ok()).toBeTruthy();
  const draft = (await approved.json()).spj_drafts.find((d) => d.spj_number);

  await page.reload({ waitUntil: "domcontentloaded" });
  await find(page, "drafts", draft.spj_number);
  await expect(page.getByTestId("wo-activate")).toBeDisabled();
  await expect(page.getByTestId("wo-activate-later")).toHaveText(/^Activates on .+, its day\.$/);
});

test("a work order is created, closed by a supervisor override and cancelled, each by its permission", async ({
  page,
}) => {
  test.setTimeout(150000);
  const headers = await signIn(page);
  const dispatcherToken = headers.Authorization.slice(7);
  const driverLogin = await page.request.post(`${API}/auth/login`, {
    data: { username: "driver", password: "driver-demo-pass" },
  });
  expect(driverLogin.ok()).toBeTruthy();
  const { token: driverToken } = await driverLogin.json();
  const supervisorLogin = await page.request.post(`${API}/auth/login`, {
    data: { username: "supervisor", password: "supervisor-demo-pass" },
  });
  expect(supervisorLogin.ok()).toBeTruthy();
  const { token: supervisorToken } = await supervisorLogin.json();
  const sites = await page.request.get(`${API}/geo/tps-coordinates`);
  expect(sites.ok()).toBeTruthy();
  const site = (await sites.json()).features[0].properties.name;
  const created = [];
  await clearTruck(page, headers, "T-209");

  async function createOrder() {
    await page.getByTestId("wo-new").click();
    const form = page.locator(".spj-form");
    await form.locator("select").first().selectOption("T-209");
    for (let i = 0; i < 2; i += 1) {
      await form.locator("input[list='spj-sites']").fill(site);
      await form.getByRole("button", { name: "Tambah titik" }).click();
    }
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/spj") && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "Simpan draf" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const spj = await response.json();
    created.push(spj.spj_id);
    return spj;
  }

  try {
    const first = await createOrder();
    await find(page, "drafts", first.spj_number);
    await page.getByTestId("wo-activate").click();
    await find(page, "active", first.spj_number);

    // A dispatcher cannot close a stop-less-evidence order: the server names the missing proof,
    // and only a supervisor is offered the override.
    await page.getByTestId("wo-close").click();
    await expect(page.getByTestId("wo-message")).toBeVisible();
    await expect(page.getByTestId("wo-override-form")).toHaveCount(0);

    await page.evaluate(
      ({ token }) => {
        localStorage.setItem("pythia_token", token);
        localStorage.setItem("pythia_role", "supervisor");
      },
      { token: supervisorToken },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await find(page, "active", first.spj_number);
    await page.getByTestId("wo-close").click();
    const form = page.getByTestId("wo-override-form");
    await expect(form).toBeVisible();
    await page.getByTestId("wo-override-reason").fill("pendek");
    await page.getByTestId("wo-override-submit").click();
    await expect(form.getByRole("alert")).toBeVisible();
    await page.getByTestId("wo-override-reason").fill("Bukti lapangan tidak tersedia");
    await page.getByTestId("wo-override-submit").click();
    await expect(page.getByTestId("wo-override-form")).toHaveCount(0, { timeout: 10000 });
    await find(page, "closed", first.spj_number);

    // Cancelling: no session, then a role without the permission, then the dispatcher.
    await page.evaluate(
      ({ token }) => {
        localStorage.setItem("pythia_token", token);
        localStorage.setItem("pythia_role", "dispatcher");
      },
      { token: dispatcherToken },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const second = await createOrder();
    await find(page, "drafts", second.spj_number);
    await page.evaluate(() => localStorage.removeItem("pythia_token"));
    await page.getByTestId("wo-cancel").click();
    await expect(page.getByTestId("wo-message")).toContainText("Sesi berakhir");
    await page.evaluate((token) => localStorage.setItem("pythia_token", token), driverToken);
    await page.getByTestId("wo-cancel").click();
    await expect(page.getByTestId("wo-message")).toContainText("tidak memiliki izin");
    await page.evaluate((token) => localStorage.setItem("pythia_token", token), dispatcherToken);
    await page.getByTestId("wo-cancel").click();
    await expect(rowOf(page, second.spj_number)).toHaveCount(0, { timeout: 10000 });
  } finally {
    // #89: independent bounded context, not page.request.
    for (const id of created) {
      const outcome = await cancelSpjIndependently(dispatcherToken, id);
      console.log(`[cleanup] ${id}: ${outcome}`);
    }
  }
});
