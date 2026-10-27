import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const PHOTO = "e2e/fixtures/test-photo.png";
const TEST_TRUCK = "T-220";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
    // gsc M1: /driver keeps its own session key.
    localStorage.setItem("pythia_field_token", token);
  }, principal);
  return { Authorization: `Bearer ${principal.token}` };
}

async function cancelLeftoverSpj(page, headers) {
  const resp = await page.request.get(`${API}/spj?status=aktif`, { headers });
  for (const s of (await resp.json()).spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await page.request.post(`${API}/spj/${s.spj_id}/cancel`, { headers });
    }
  }
}

test("driver runs full SPJ flow: pretrip, stop evidence, receipt", async ({ page, context }) => {
  const headers = await signIn(page);
  await cancelLeftoverSpj(page, headers);

  const fleet = await (await page.request.get(`${API}/fleet`)).json();
  const trucks = Array.isArray(fleet) ? fleet : fleet.trucks;
  const t220 = trucks.find((t) => t.truck_code === TEST_TRUCK);

  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: t220.driver_name,
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: true,
      priority: "normal",
      note: "e2e driver",
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();

  const stop = await page.request.post(`${API}/spj/${spj.spj_id}/stops`, {
    headers,
    data: {
      name: "TPS E2E",
      kecamatan: "Cilandak",
      address: "Jl. E2E",
      lat: -6.29,
      lng: 106.79,
    },
  });
  expect(stop.ok()).toBeTruthy();

  const activate = await page.request.post(`${API}/spj/${spj.spj_id}/activate`, { headers });
  expect(activate.ok()).toBeTruthy();

  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });

  // ── Gate: pick driver (each truck has its own simulated driver — target T-220) ──
  await page.goto("/driver");
  const pretripLoaded = page.waitForResponse((response) =>
    response.url().includes(`/pretrip/today/${TEST_TRUCK}`),
  );
  // The shared account searches its truck instead of a 59-row list.
  await page.getByTestId("driver-truck-search").fill("T-220");
  await page.locator('[data-testid="pick-T-220"]').click();
  await page.getByTestId("driver-pick-start").click();
  await pretripLoaded;

  // ── Pre-trip (on the Instructions tab; the done banner on a re-run) ──
  // The form flips to done when /pretrip/today resolves — never hold a locator across that async boundary.
  await page.getByTestId("driver-tab-instruksi").click();
  // The route map has no header; the truck chip is on the other tabs.
  await expect(page.getByTestId("driver-truck-code")).toHaveText(TEST_TRUCK);
  const doneBadge = page.getByTestId("pretrip-done");
  const startCheck = page.getByTestId("driver-start-pretrip");
  const restOk = page.getByTestId("pretrip-rest-ok");
  await expect(doneBadge.or(startCheck).or(restOk)).toBeVisible({ timeout: 15000 });
  if (await startCheck.isVisible()) await startCheck.click();
  if (await restOk.isVisible()) {
    await restOk.click();
    await page.getByTestId("pretrip-submit").click();
  }
  await expect(doneBadge).toBeVisible({ timeout: 15000 });

  // ── Stop proof: "Saya sudah tiba" opens arrival photo → weight by type
  // (one scale photo for the fractions) → officer name + photo → "Selesaikan titik" ──
  await page.getByTestId("driver-tab-rute").click();
  await page.getByRole("button", { name: "Saya sudah tiba" }).click();
  const proof = page.getByTestId("stop-proof");
  await proof.getByTestId("arrival-input").setInputFiles(PHOTO);
  await expect(proof.getByText("Selesai", { exact: true })).toBeVisible({ timeout: 10000 });

  await proof.getByTestId("weigh-input").setInputFiles(PHOTO);
  await proof.getByLabel("Residu").fill("120");

  await proof.getByTestId("officer-input").setInputFiles(PHOTO);
  await proof.getByLabel("Nama petugas").fill("Budi Petugas");
  await proof.getByRole("button", { name: "Selesaikan titik", exact: true }).click();
  // Only stop in the SPJ → the app hands over to the TPA tab, which holds the gate.
  await expect(page.getByTestId("driver-tab-tpa")).toHaveAttribute("aria-current", "page", {
    timeout: 10000,
  });
  await expect(page.locator('[data-testid="delivery-card"]')).toBeVisible({ timeout: 10000 });

  const afterStop = await (await page.request.get(`${API}/spj/${spj.spj_id}`, { headers })).json();
  expect(afterStop.stops[0].status).toBe("completed");
  expect(afterStop.stops[0].evidence.weighing).toEqual([
    expect.objectContaining({ fraction: "Residu", weight_kg: 120 }),
  ]);

  // ── Receipt: at the gate, then the weigh-ticket photo; no OCR engine in e2e, so the
  // gross weight is typed from the paper and recorded as manual ──
  await page.getByRole("button", { name: "Saya di gerbang" }).click();
  await page.locator('[data-testid="receipt-input"]').setInputFiles(PHOTO);
  const ticket = page.getByTestId("weigh-ticket");
  await ticket.getByLabel("Berat bruto (kg)").fill("12450");
  await ticket.getByRole("button", { name: "Kirim struk" }).click();
  await expect(page.getByText("Kerja bagus hari ini")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("receipt-weight-gross")).toContainText("12.450 kg");
  const receipt = (await (await page.request.get(`${API}/spj/${spj.spj_id}`, { headers })).json()).receipt;
  expect(receipt.total_weight_kg).toBe(12450);
  expect(receipt.weight_source).toBe("manual");
  expect(receipt.has_photo).toBe(true);
  expect(receipt.photo_b64).toBeUndefined();
  const photo = await page.request.get(`${API}/spj/${spj.spj_id}/receipt/photo`, { headers });
  expect(photo.ok()).toBeTruthy();
  expect((await photo.json()).photo_b64).toContain("data:image/");
});

test("driver is offered the newest receipt-pending SPJ, not the oldest", async ({ page }) => {
  const headers = await signIn(page);
  await cancelLeftoverSpj(page, headers);

  // Two completed SPJs for one truck: the older one already has its receipt,
  // the newer one is still pending. Position must come from server state.
  async function completedSpj(truck) {
    const created = await page.request.post(`${API}/spj`, {
      headers,
      data: {
        driver_name: "E2E Receipt",
        truck_code: truck,
        destination: "TPST Bantargebang",
        weigh_on_site: true,
        priority: "normal",
        note: "e2e receipt order",
      },
    });
    const spj = await created.json();
    await page.request.post(`${API}/spj/${spj.spj_id}/stops`, {
      headers,
      data: { name: "TPS Receipt", kecamatan: "Cilandak", address: "Jl. Receipt", lat: -6.29, lng: 106.79 },
    });
    await page.request.post(`${API}/spj/${spj.spj_id}/activate`, { headers });
    await page.request.post(`${API}/spj/${spj.spj_id}/stops/0/complete`, {
      headers,
      data: {
        evidence: {
          arrival: {
            photo_name: "a.jpg",
            photo_b64: "data:image/jpeg;base64,AAA",
            lat: -6.29,
            lng: 106.79,
            at: "2026-09-14T09:00:00",
          },
          weighing: [
            {
              fraction: "Residu",
              weight_kg: 40.0,
              photo_name: "t.jpg",
              photo_b64: "data:image/jpeg;base64,BBB",
            },
          ],
          officer: { photo_name: "p.jpg", photo_b64: "data:image/jpeg;base64,CCC", name: "Dicky" },
        },
      },
    });
    return spj;
  }

  const older = await completedSpj(TEST_TRUCK);
  await page.request.post(`${API}/spj/${older.spj_id}/receipt`, {
    headers,
    data: {
      photo_name: "struk-lama.jpg",
      photo_b64: "data:image/jpeg;base64,AA",
      total_weight_kg: 100,
      weight_source: "manual",
    },
  });
  const newer = await completedSpj(TEST_TRUCK);

  await page.goto("/driver");
  // The shared account searches its truck instead of a 59-row list.
  await page.getByTestId("driver-truck-search").fill(TEST_TRUCK);
  await page.locator(`[data-testid="pick-${TEST_TRUCK}"]`).click();
  await page.getByTestId("driver-pick-start").click();
  const card = page.getByTestId("delivery-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toHaveAttribute("data-spj-id", newer.spj_id);
  const history = await (await page.request.get(`${API}/spj?status=selesai`, { headers })).json();
  const mine = history.spj.filter((s) => s.truck_code === TEST_TRUCK);
  expect(mine[0].spj_id).toBe(newer.spj_id);
  expect(mine[0].receipt).toBeNull();
});

test("pretrip with a TIDAK item auto-creates a damage report", async ({ page, context }) => {
  const headers = await signIn(page);
  // First test already submitted pretrip for T-220 today; use another truck.
  const PRETTRIP_TRUCK = "T-221";
  const pretrip = await (
    await page.request.get(`${API}/pretrip/today/${PRETTRIP_TRUCK}`, { headers })
  ).json();
  test.skip(Boolean(pretrip.done), "pretrip already submitted today for this truck");

  await context.grantPermissions(["geolocation"]);

  await page.goto("/driver");
  await page.evaluate(() => localStorage.removeItem("pythia_driver"));
  await page.reload({ waitUntil: "domcontentloaded" });

  // The shared account searches its truck instead of a 59-row list.
  await page.getByTestId("driver-truck-search").fill(PRETTRIP_TRUCK);
  await page.locator(`[data-testid="pick-${PRETTRIP_TRUCK}"]`).click();

  await page.getByTestId("driver-pick-start").click();

  // Mark tyres NO (ban → severity berat) with its mandatory note; the rest OK.
  await page.getByTestId("driver-start-pretrip").click();
  await page.getByTestId("pretrip-rest-ok").click();
  await page.getByTestId("tidak-ban").click();
  await page.getByTestId("pretrip-note-ban").fill("Ban belakang kanan bocor e2e");
  await page.getByTestId("pretrip-submit").click();
  await expect(page.getByTestId("pretrip-done")).toBeVisible({ timeout: 10000 });

  const reports = await (await page.request.get(`${API}/damage-reports?status=baru`, { headers })).json();
  const mine = (reports.reports || []).filter(
    (r) => r.truck_code === PRETTRIP_TRUCK && r.source === "pretrip" && r.component === "ban",
  );
  expect(mine.length).toBeGreaterThan(0);
  expect(mine[0].severity).toBe("berat");
});

test("admin sees damage report and resolves it", async ({ page }) => {
  const headers = await signIn(page);
  const note = `e2e admin panel note ${Date.now()}`;
  const create = await page.request.post(`${API}/damage-reports`, {
    headers,
    data: {
      truck_code: "T-230",
      driver_name: "E2E Admin",
      component: "rem",
      severity: "berat",
      note,
    },
  });
  expect(create.status()).toBe(201);
  const rep = await create.json();

  try {
    // Damage reports live in the Fleet & drivers damage table.
    await page.goto("/app/fleet", { waitUntil: "domcontentloaded" });
    const row = page.getByTestId("damage-table").locator("tbody tr").filter({ hasText: note });
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row.getByText("Berat", { exact: true })).toBeVisible();
  } finally {
    await page.request.post(`${API}/damage-reports/${rep.report_id}/resolve`, { headers });
  }
});

test("admin sees spj evidence summary after driver flow", async ({ page }) => {
  const headers = await signIn(page);
  // A previous failed run can leave T-231 active, which blocks activation.
  const existing = await page.request.get(`${API}/spj?status=aktif`, { headers });
  for (const stale of (await existing.json()).spj || []) {
    if (stale.truck_code === "T-231") {
      await page.request.post(`${API}/spj/${stale.spj_id}/cancel`, { headers });
    }
  }
  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: "E2E Evidence",
      truck_code: "T-231",
      destination: "TPST Bantargebang",
      weigh_on_site: true,
      priority: "normal",
      note: "e2e evidence",
    },
  });
  const spj = await create.json();
  await page.request.post(`${API}/spj/${spj.spj_id}/stops`, {
    headers,
    data: { name: "TPS Evidence", kecamatan: "Cilandak", address: "Jl. Bukti", lat: -6.29, lng: 106.79 },
  });
  await page.request.post(`${API}/spj/${spj.spj_id}/activate`, { headers });
  await page.request.post(`${API}/spj/${spj.spj_id}/stops/0/complete`, {
    headers,
    data: {
      evidence: {
        arrival: {
          photo_name: "a.jpg",
          photo_b64: "data:image/jpeg;base64,AAA",
          lat: -6.29,
          lng: 106.79,
          at: "2026-09-14T09:00:00",
        },
        weighing: [
          {
            fraction: "Residu",
            weight_kg: 400.0,
            photo_name: "t.jpg",
            photo_b64: "data:image/jpeg;base64,BBB",
          },
        ],
        officer: { photo_name: "p.jpg", photo_b64: "data:image/jpeg;base64,CCC", name: "Dicky" },
      },
    },
  });

  // The evidence summary is the Work orders detail pane.
  await page.goto("/app/work-orders", { waitUntil: "domcontentloaded" });
  await page.getByTestId("wo-search").fill(spj.spj_number);
  const row = page.getByTestId("wo-row").filter({ hasText: spj.spj_number });
  for (const tab of ["active", "proof", "closed"]) {
    await page.getByTestId(`wo-tab-${tab}`).click();
    if (await row.count()) break;
  }
  await row.click();
  const detail = page.getByTestId("wo-detail");
  await expect(detail).toContainText("Petugas tercatat + foto", { timeout: 15000 });
  await expect(detail.locator(".wo-weight").filter({ hasText: "Residu" })).toContainText("0,4 t");
});
