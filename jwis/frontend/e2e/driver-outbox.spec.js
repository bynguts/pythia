import { expect, test } from "@playwright/test";

/**
 * #45: durable offline submission for the Driver workflow.
 *
 * Scenario: the driver completes a stop while the network is down. The
 * submission must be queued durably (survives a full reload), the driver
 * sees a queued indicator, and reconnecting flushes the queue to the
 * server — the stop then reads as completed server-side. Replay stays
 * idempotent (the stop endpoint returns early on a completed stop).
 */

const API = "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-088";

async function apiLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dispatcher", password: "dispatcher-demo-pass" }),
  });
  return res.json();
}

async function cancelLeftover(headers) {
  const res = await fetch(`${API}/spj?status=aktif`, headers);
  const resp = await res.json();
  for (const s of resp.spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await fetch(`${API}/spj/${s.spj_id}/cancel`, { method: "POST", headers });
    }
  }
}

test("offline stop submission queues durably, survives reload, and syncs on reconnect", async ({ page, context }) => {
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
      note: "e2e driver outbox #45",
    }),
  });
  expect(create.status).toBe(201);
  const spj = await create.json();
  try {
    const stops = await fetch(`${API}/spj/${spj.spj_id}/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name: "TPS Offline E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 }),
    });
    expect(stops.status).toBe(200);
    const activate = await fetch(`${API}/spj/${spj.spj_id}/activate`, { method: "POST", headers });
    expect(activate.status).toBe(200);

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
    await page.goto("/");
    await page.evaluate((token) => {
      localStorage.setItem("jwis_lang", "en");
      localStorage.setItem("jwis_token", token);
      localStorage.removeItem("jwis_driver");
    }, principal.token);
    await page.goto("/driver");
    await page.locator(`[data-testid="pick-${TEST_TRUCK}"]`).click();

    // Pretrip online first (it gates the stop form) — only when today's
    // inspection has not been recorded yet (server-side daily gate).
    const markRest = page.getByRole("button", { name: "Mark the rest as OK" });
    if (await markRest.count()) {
      await expect(markRest).toBeEnabled();
      await markRest.click();
      const save = page.getByRole("button", { name: "Save inspection" });
      await expect(save).toBeEnabled();
      await save.click();
    }
    await expect(page.getByRole("heading", { name: /Stop 1: TPS Offline E2E/ })).toBeVisible({ timeout: 20000 });

    const startButton = page.getByRole("button", { name: "Start this stop" });
    if (await startButton.count()) await startButton.click();
    await expect(page.getByText("Arrival photo at the location")).toBeVisible();

    // Kill the network while the page stays loaded.
    await context.setOffline(true);

    // Step-gated form: arrival photo → weighing photo + weight → officer.
    await page.locator('[data-testid="arrival-input"]').setInputFiles({
      name: "arrival.jpg", mimeType: "image/jpeg",
      buffer: Buffer.from("fake-jpg-data"),
    });
    await expect(page.locator('[data-testid="weigh-input"]')).toBeVisible();
    await page.locator('[data-testid="weigh-input"]').setInputFiles({
      name: "weighing.jpg", mimeType: "image/jpeg",
      buffer: Buffer.from("fake-weighing"),
    });
    await page.locator('input[id^="weight-"]').fill("1250");
    await page.getByRole("button", { name: /add weighing|tambah timbangan/i }).click();
    await expect(page.locator('[data-testid="officer-input"]')).toBeVisible();
    await page.locator('[data-testid="officer-input"]').setInputFiles({
      name: "officer.jpg", mimeType: "image/jpeg",
      buffer: Buffer.from("fake-officer"),
    });
    await page.locator('input[id^="officer-name-"]').fill("Budi");
    await page.getByRole("button", { name: /complete stop|selesaikan/i }).click();

    // Durable queue indicator — not a dead error toast alone.
    await expect(page.getByTestId("driver-queued-count")).toBeVisible({ timeout: 10000 });

    // The queued record survives a full reload.
    await context.setOffline(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    const entries = await page.evaluate(() => JSON.parse(localStorage.getItem("jwis_driver_outbox") || "[]"));
    // The stop completion must be among the durable records.
    expect(entries.some((e) => e.path.endsWith("/stops/0/complete"))).toBe(true);

    // Reconnect: the queue flushes and the server records the stop.
    await expect(async () => {
      const detail = await (await fetch(`${API}/spj/${spj.spj_id}`, { headers })).json();
      const stop = detail.stops?.[0];
      expect(stop?.status).toMatch(/completed|selesai/i);
    }).toPass({ timeout: 30000 });

    // Queue drained.
    await expect.poll(async () => page.evaluate(() => {
      const raw = localStorage.getItem("jwis_driver_outbox");
      return raw ? JSON.parse(raw).length : 1;
    }), { timeout: 20000 }).toBe(0);
  } finally {
    await fetch(`${API}/spj/${spj.spj_id}/cancel`, { method: "POST", headers }).catch(() => {});
  }
});
