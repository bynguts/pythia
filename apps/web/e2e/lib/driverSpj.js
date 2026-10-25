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
  return trucks.find((t) => t.truck_code === truck)?.driver_name || "Pengemudi Sim";
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

// Pre-trip in two taps when today's form is shown (R4); a no-op when done.
export async function finishPretrip(page) {
  const done = page.getByTestId("pretrip-done");
  const markRest = page.getByRole("button", { name: "Tandai Sisanya Baik" });
  await expect(done.or(markRest)).toBeVisible({ timeout: 15000 });
  if (await markRest.isVisible()) {
    await markRest.click();
    await page.getByRole("button", { name: "Simpan Inspeksi" }).click();
  }
  await expect(done).toBeVisible({ timeout: 15000 });
}

// Arrival + officer evidence for the current stop (an SPJ without on-site weighing).
export async function completeCurrentStop(page, stopIndex, { officer = "Petugas Uji" } = {}) {
  const card = page.getByTestId(`stop-${stopIndex}`);
  await card.getByTestId("stop-start").click();
  await card.getByTestId("arrival-input").setInputFiles(PHOTO);
  await expect(card.getByTestId("officer-input")).toBeVisible({ timeout: 10000 });
  await card.getByTestId("officer-input").setInputFiles(PHOTO);
  await card.getByLabel("Nama Petugas").fill(officer);
  await card.getByRole("button", { name: "Selesaikan Titik" }).click();
}
