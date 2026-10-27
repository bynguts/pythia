// Wave 6 driver specs: shared setup. Each spec uses its own truck so runs do
// not collide; every SPJ a test creates is cancelled in `finally`.
import { expect } from "@playwright/test";

export const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
export const PHOTO = "e2e/fixtures/test-photo.png";

export async function apiLogin(request, role = "dispatcher") {
  const res = await request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

export async function cancelActiveFor(request, token, truck) {
  const res = await request.get(`${API}/spj?status=aktif`, { headers: authHeaders(token) });
  for (const s of (await res.json()).spj || []) {
    if (s.truck_code === truck) {
      await request.post(`${API}/spj/${s.spj_id}/cancel`, { headers: authHeaders(token) });
    }
  }
}

export async function driverNameFor(request, truck) {
  const fleet = await (await request.get(`${API}/fleet`)).json();
  const trucks = Array.isArray(fleet) ? fleet : fleet.trucks;
  return trucks.find((t) => t.truck_code === truck)?.driver_name || "Pengemudi Sim 42";
}

// Create, fill and activate an SPJ. `stops` are {name, kecamatan, address, lat, lng}.
export async function createActiveSpj(request, token, truck, stops, { weighOnSite = false } = {}) {
  await cancelActiveFor(request, token, truck);
  const headers = authHeaders(token);
  const create = await request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: await driverNameFor(request, truck),
      truck_code: truck,
      destination: "TPST Bantargebang",
      weigh_on_site: weighOnSite,
      priority: "normal",
      note: "e2e wave 6 driver",
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();
  for (const stop of stops) {
    const added = await request.post(`${API}/spj/${spj.spj_id}/stops`, { headers, data: stop });
    expect(added.ok()).toBeTruthy();
  }
  const activate = await request.post(`${API}/spj/${spj.spj_id}/activate`, { headers });
  expect(activate.ok()).toBeTruthy();
  return activate.json();
}

export async function cancelSpj(request, token, spjId) {
  await request.post(`${API}/spj/${spjId}/cancel`, { headers: authHeaders(token) }).catch(() => {});
}

// Open /driver signed in for `truck`, with no leftover local driver state.
export async function openDriver(page, request, { token, truck, lang = "id" }) {
  const driverName = await driverNameFor(request, truck);
  await page.goto("/");
  await page.evaluate(
    ({ token, truck, driverName, lang }) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
      }
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: driverName, truck_code: truck }));
    },
    { token, truck, driverName, lang },
  );
  await page.goto("/driver");
  await expect(page.getByTestId("driver-app")).toBeVisible();
}

// Pre-trip in two taps on the Instructions tab (R4); a no-op when done. The app
// returns to the tab it was on, so a stop flow carries on where it was.
export async function finishPretrip(page) {
  const back = await page.locator('.driver-tab[aria-current="page"]').getAttribute("data-testid");
  await page.getByTestId("driver-tab-instruksi").click();
  const done = page.getByTestId("pretrip-done");
  const start = page.getByTestId("driver-start-pretrip");
  const restOk = page.getByTestId("pretrip-rest-ok");
  await expect(done.or(start).or(restOk)).toBeVisible({ timeout: 15000 });
  if (await start.isVisible()) await start.click();
  if (await restOk.isVisible()) {
    await restOk.click();
    await page.getByTestId("pretrip-submit").click();
  }
  await expect(done).toBeVisible({ timeout: 15000 });
  if (back && back !== "driver-tab-instruksi") await page.getByTestId(back).click();
}

// Arrival + officer evidence for the current stop (an SPJ without on-site weighing).
// Wave 13: "I've arrived" on the route sheet opens the stop proof screen.
export async function completeCurrentStop(page, stopIndex, { officer = "Petugas Uji" } = {}) {
  const tab = page.getByTestId("driver-tab-rute");
  if ((await tab.count()) && (await tab.getAttribute("aria-current")) !== "page") await tab.click();
  const card = page.getByTestId(`stop-${stopIndex}`);
  await card.getByTestId("stop-start").click();
  const proof = card.getByTestId("stop-proof");
  await proof.getByTestId("arrival-input").setInputFiles(PHOTO);
  await expect(proof.getByTestId("arrival-geotag")).toBeVisible({ timeout: 10000 });
  await proof.getByTestId("officer-input").setInputFiles(PHOTO);
  await proof.getByTestId("officer-name").fill(officer);
  await proof.getByTestId("stop-finish").click();
}

// The TPA tab's weigh ticket: "I'm at the gate" (when not yet reported), the ticket
// photo, then the typed weights (no OCR engine in e2e) and "Send ticket".
export async function sendReceipt(page, { gross = "", tare = "" } = {}) {
  const tab = page.getByTestId("driver-tab-tpa");
  if ((await tab.count()) && (await tab.getAttribute("aria-current")) !== "page") await tab.click();
  const delivery = page.getByTestId("delivery-card");
  await expect(delivery).toBeVisible({ timeout: 15000 });
  const gate = delivery.getByTestId("gate-arrival");
  if (await gate.isVisible()) await gate.click();
  await delivery.getByTestId("receipt-input").setInputFiles(PHOTO);
  const ticket = page.getByTestId("weigh-ticket");
  await expect(ticket.getByTestId("receipt-send").or(ticket.getByTestId("weigh-fix"))).toBeVisible({
    timeout: 20000,
  });
  if (await ticket.getByTestId("weigh-fix").isVisible()) await ticket.getByTestId("weigh-fix").click();
  await ticket.getByTestId("receipt-gross").fill(gross);
  await ticket.getByTestId("receipt-tare").fill(tare);
  await ticket.getByTestId("receipt-send").click();
}
