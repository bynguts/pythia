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

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
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
  const res = await fetch(`${API}/spj?status=aktif`, { headers });
  const resp = await res.json();
  for (const s of resp.spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await fetch(`${API}/spj/${s.spj_id}/cancel`, { method: "POST", headers });
    }
  }
}

test("offline stop submission queues durably, survives reload, and syncs on reconnect", async ({
  page,
  context,
}) => {
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
      note: "e2e driver outbox #45",
    }),
  });
  expect(create.status).toBe(201);
  const spj = await create.json();
  try {
    const stops = await fetch(`${API}/spj/${spj.spj_id}/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        name: "TPS Offline E2E",
        kecamatan: "Cilandak",
        address: "Jl. E2E",
        lat: -6.29,
        lng: 106.79,
      }),
    });
    expect(stops.status).toBe(200);
    const activate = await fetch(`${API}/spj/${spj.spj_id}/activate`, { method: "POST", headers });
    expect(activate.status).toBe(200);

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
    await page.goto("/");
    await page.evaluate((token) => {
      localStorage.setItem("pythia_lang", "en");
      localStorage.setItem("pythia_field_token", token);
      localStorage.removeItem("pythia_driver");
    }, principal.token);
    await page.goto("/driver");
    // The shared account searches its truck instead of a 59-row list.
    await page.getByTestId("driver-truck-search").fill(TEST_TRUCK);
    await page.locator(`[data-testid="pick-${TEST_TRUCK}"]`).click();
    await page.getByTestId("driver-pick-start").click();

    // Pretrip online first (it gates the stop form) — only when today's
    // inspection has not been recorded yet (server-side daily gate).
    // The check lives on the Instructions tab.
    await page.getByTestId("driver-tab-instruksi").click();
    const done = page.getByTestId("pretrip-done");
    const startCheck = page.getByTestId("driver-start-pretrip");
    const restOk = page.getByTestId("pretrip-rest-ok");
    await expect(done.or(startCheck).or(restOk)).toBeVisible({ timeout: 15000 });
    if (await startCheck.isVisible()) await startCheck.click();
    if (await restOk.isVisible()) {
      await restOk.click();
      await page.getByTestId("pretrip-submit").click();
    }
    await expect(done).toBeVisible({ timeout: 15000 });
    await page.getByTestId("driver-tab-rute").click();
    await expect(page.getByRole("heading", { name: /Stop 1: TPS Offline E2E/ })).toBeVisible({
      timeout: 20000,
    });

    // "I've arrived" on the route sheet opens the stop proof screen.
    await page.getByTestId("stop-start").click();
    await expect(page.getByTestId("stop-proof")).toBeVisible();

    // Kill the network while the page stays loaded.
    await context.setOffline(true);

    // Step-gated proof: arrival photo → scale photo + weight per fraction → officer.
    await page.locator('[data-testid="arrival-input"]').setInputFiles({
      name: "arrival.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-jpg-data"),
    });
    await expect(page.locator('[data-testid="weigh-input"]')).toBeVisible();
    await page.locator('[data-testid="weigh-input"]').setInputFiles({
      name: "weighing.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-weighing"),
    });
    await page.getByTestId("weigh-kg-Residu").fill("1250");
    await expect(page.locator('[data-testid="officer-input"]')).toBeVisible();
    await page.locator('[data-testid="officer-input"]').setInputFiles({
      name: "officer.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-officer"),
    });
    await page.getByTestId("officer-name").fill("Budi");
    await page.getByTestId("stop-finish").click();

    // Durable queue indicator — not a dead error toast alone. The route
    // map has no top bar; its trip card shows the offline chip with the count.
    await expect(page.getByTestId("driver-trip-card").getByTestId("drt-sync")).toHaveAttribute(
      "data-sync",
      "offline",
      { timeout: 10000 },
    );

    // The queued record survives a full reload.
    await context.setOffline(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    const entries = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("pythia_driver_outbox") || "[]"),
    );
    // The stop completion must be among the durable records.
    expect(entries.some((e) => e.path.endsWith("/stops/0/complete"))).toBe(true);

    // Reconnect: the queue flushes and the server records the stop.
    await expect(async () => {
      const detail = await (await fetch(`${API}/spj/${spj.spj_id}`, { headers })).json();
      const stop = detail.stops?.[0];
      expect(stop?.status).toMatch(/completed|selesai/i);
    }).toPass({ timeout: 30000 });

    // Queue drained.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem("pythia_driver_outbox");
            return raw ? JSON.parse(raw).length : 1;
          }),
        { timeout: 20000 },
      )
      .toBe(0);
  } finally {
    await fetch(`${API}/spj/${spj.spj_id}/cancel`, { method: "POST", headers }).catch(() => {});
  }
});
