// wave13 Operations (docs/design/export-handoff/U0H9au.png): a flat strip of four KPIs over
// a full-width map; the "Needs you" panel floats on the map's left and the Bantargebang gate
// card sits in its bottom-right corner. Each open item offers one action, and every action
// writes the existing API (follow-up log, gate holds, stop skip, plan reassign).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

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
  }, principal);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
}

// One open item of every kind the panel acts on. The deviation's truck has no computed
// reroute in the live snapshot, so its card must say so and keep "send" disabled.
const FEED = {
  date: "2026-01-01",
  counts: { all: 6, urgent: 2, trucks: 4, gate: 1, tps: 1 },
  items: [
    {
      id: "driver-exception:E2E-ACC",
      kind: "accident",
      category: "trucks",
      severity: "urgent",
      truck_code: "T-E2A",
      created_at: new Date(Date.now() - 5 * 60000).toISOString(),
      facts: { note: "Tabrakan ringan di simpang." },
      actions: ["escalate", "mark_handled"],
      classification: "FIELD",
    },
    {
      id: "damage:E2E-DMG",
      kind: "truck_breakdown",
      category: "trucks",
      severity: "urgent",
      truck_code: "T-E2B",
      created_at: null,
      facts: { plan_id: "PLAN-E2E" },
      suggestion: { kind: "reassign", plan_id: "PLAN-E2E", from_truck: "T-E2B", to_truck: "T-E2C" },
      actions: ["reassign", "mark_handled"],
      classification: "FIELD",
    },
    {
      id: "ALT-T-E2D",
      kind: "deviation",
      category: "trucks",
      severity: "normal",
      truck_code: "T-E2D",
      spj_id: "SPJ-E2E-D",
      created_at: null,
      facts: { distance_meters: 1434 },
      actions: ["send_route", "mark_handled"],
      classification: "SIMULATED",
    },
    {
      id: "gate-peak:2026-01-01:10:00",
      kind: "gate_peak",
      category: "gate",
      severity: "normal",
      truck_code: null,
      created_at: null,
      facts: {
        slot: "10:00",
        holds: [
          { rec_id: "rec-a", truck_code: "T-E2E", hold_minutes: 15 },
          { rec_id: "rec-b", truck_code: "T-E2F", hold_minutes: 15 },
        ],
      },
      actions: ["accept"],
      classification: "MODEL",
    },
    {
      id: "tps-empty:SPJ-E2E-G:1",
      kind: "tps_empty",
      category: "tps",
      severity: "normal",
      truck_code: "T-E2G",
      spj_id: "SPJ-E2E-G",
      created_at: null,
      facts: { reports: 3, stop_name: "TPS Uji 1", stop_index: 1 },
      actions: ["skip_stop", "mark_handled"],
      classification: "FIELD",
    },
    {
      id: "duty:T-E2H",
      kind: "duty_warn",
      category: "trucks",
      severity: "normal",
      truck_code: "T-E2H",
      created_at: null,
      facts: { duty_minutes: 605, block_at_minutes: 720 },
      actions: ["plan_relief", "mark_handled"],
      classification: "FIELD",
    },
  ],
};

// Every write the panel makes is captured and answered here, so nothing reaches the store.
async function captureWrites(page) {
  const writes = [];
  const record = (name) => async (route) => {
    writes.push({ name, url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true } });
  };
  await page.route(/\/api\/alert\/follow-up$/, record("follow-up"));
  await page.route(/\/api\/whatsapp\/alert$/, record("whatsapp"));
  await page.route(/\/api\/gate\/slots\/recommendations\/[^/]+\/accept$/, record("accept"));
  await page.route(/\/api\/spj\/[^/]+\/stops\/\d+\/skip$/, record("skip"));
  await page.route(/\/api\/operations\/[^/]+\/reassign$/, record("reassign"));
  return writes;
}

const row = (page, kind) => page.locator(`[data-testid=action-row][data-kind="${kind}"]`);

test("the strip has four KPIs and the panels float on the map: needs-you left, gate card bottom-right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strip = page.getByTestId("metric-strip");
  for (const id of ["kpi-trucks", "kpi-trips", "kpi-tonnes", "kpi-gate"])
    await expect(strip.getByTestId(id)).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("metric-strip")).toHaveCount(1);
  await expect(page.getByTestId("kpi-trucks")).toContainText("Truk di jalan");
  await expect(page.getByTestId("kpi-gate")).toContainText("Antrean gerbang kini");

  await expect(page.getByTestId("map-gps-soon")).toContainText("Segera hadir");
  await expect(page.getByTestId("map-gps-soon")).toContainText("Pelacakan GPS langsung");

  const box = async (selector) => (await page.locator(selector).first().boundingBox()) || null;
  await expect(page.getByTestId("gate-card")).toBeVisible({ timeout: 30000 });
  const [stage, needs, corner] = await Promise.all([
    box("[data-testid=fleet-map-stage]"),
    box("[data-testid=needs-you]"),
    box(".ops-corner"),
  ]);
  // The map runs the content width; the needs panel floats inside it at the left edge.
  expect(needs.x).toBeGreaterThanOrEqual(stage.x);
  expect(needs.x - stage.x).toBeLessThanOrEqual(24);
  expect(needs.y).toBeGreaterThanOrEqual(stage.y);
  expect(needs.x + needs.width).toBeLessThan(stage.x + stage.width / 2);
  // The gate card hugs the bottom-right corner.
  expect(stage.x + stage.width - (corner.x + corner.width)).toBeLessThanOrEqual(24);
  expect(stage.y + stage.height - (corner.y + corner.height)).toBeLessThanOrEqual(24);
  expect(corner.x).toBeGreaterThan(stage.x + stage.width / 2);
});

test("the needs-you panel and the gate card fold to their headers to clear the map", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/ops\/needs-you$/, (route) => route.fulfill({ json: FEED }));
  await signIn(page);
  const needs = page.getByTestId("needs-you");
  await expect(needs.getByTestId("action-queue")).toBeVisible({ timeout: 30000 });
  const tall = (await needs.boundingBox()).height;

  const toggle = page.getByTestId("needs-you-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(needs.getByTestId("action-queue")).toBeHidden();
  await expect(needs.getByTestId("needs-filter-all")).toBeHidden();
  expect((await needs.boundingBox()).height).toBeLessThan(tall / 2);
  await toggle.click();
  await expect(needs.getByTestId("action-queue")).toBeVisible();

  const gate = page.getByTestId("gate-card");
  const gateToggle = page.getByTestId("gate-card-toggle");
  await expect(gate.locator(".ops-gate-note")).toBeVisible({ timeout: 30000 });
  await gateToggle.click();
  await expect(gateToggle).toHaveAttribute("aria-expanded", "false");
  await expect(gate.locator(".ops-gate-note, .ops-gate-bars")).toHaveCount(0);
  await gateToggle.click();
  await expect(gate.locator(".ops-gate-note")).toBeVisible();
});

test("the bell counts open items and its popover lists them and opens Operations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/ops\/needs-you$/, (route) => route.fulfill({ json: FEED }));
  await signIn(page);
  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("bell-count")).toHaveText("6", { timeout: 30000 });
  await page.getByTestId("bell").click();
  const popover = page.getByTestId("bell-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("bell-item")).toHaveCount(6);
  await expect(popover).toContainText("T-E2A");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await page.getByTestId("bell").click();
  await popover.getByTestId("bell-item").first().click();
  await expect(page).toHaveURL(/\/app\/operations/);
  await expect(page.getByTestId("bell-popover")).toBeHidden();
});

test("every open item shows its one action; the chips count and filter the list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/ops\/needs-you$/, (route) => route.fulfill({ json: FEED }));
  await signIn(page);
  const panel = page.getByTestId("needs-you");
  await expect(panel.getByTestId("action-row")).toHaveCount(6, { timeout: 30000 });
  await expect(panel.getByTestId("needs-you-count")).toHaveText("6");
  await expect(panel.getByTestId("needs-you-urgent")).toHaveText("2 mendesak");

  await expect(row(page, "accident")).toContainText("Kecelakaan · T-E2A");
  await expect(row(page, "accident").getByTestId("needs-action-escalate")).toHaveText("Eskalasi");
  await expect(row(page, "truck_breakdown")).toContainText("T-E2C bisa mengambil sisa titiknya.");
  await expect(row(page, "truck_breakdown").getByTestId("needs-action-reassign")).toHaveText("Alihkan");
  await expect(row(page, "gate_peak")).toContainText("Puncak gerbang 10:00–10:15");
  await expect(row(page, "gate_peak").locator(".ui-tag-model")).toHaveText("Model");
  await expect(row(page, "gate_peak").getByTestId("needs-action-accept")).toHaveText("Terima");
  await expect(row(page, "tps_empty")).toContainText("TPS Uji 1 kosong");
  await expect(row(page, "tps_empty").getByTestId("needs-action-skip_stop")).toHaveText("Lewati titik");
  await expect(row(page, "duty_warn").getByTestId("needs-action-plan_relief")).toHaveText("Atur pengganti");

  // The first deviation opens with Pythia's suggestion; with no computed reroute it says so
  // and the send button stays disabled rather than sending nothing.
  const deviation = row(page, "deviation");
  await expect(deviation).toHaveAttribute("data-provenance", "simulated");
  await expect(deviation.getByTestId("needs-suggestion")).toContainText(
    "Belum ada rute pengalihan untuk truk ini.",
  );
  await expect(deviation.getByTestId("needs-action-send_route")).toBeDisabled();

  await expect(page.getByTestId("needs-filter-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("needs-filter-trucks")).toHaveText("Truk 4");
  await page.getByTestId("needs-filter-gate").click();
  await expect(page.getByTestId("needs-filter-gate")).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("action-row")).toHaveCount(1);
  await expect(panel.getByTestId("action-row")).toHaveAttribute("data-kind", "gate_peak");
  await page.getByTestId("needs-filter-tps").click();
  await expect(panel.getByTestId("action-row")).toHaveAttribute("data-kind", "tps_empty");
});

test("each action writes the existing API with the item's own ids", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/ops\/needs-you$/, (route) => route.fulfill({ json: FEED }));
  const writes = await captureWrites(page);
  await signIn(page);
  await expect(page.getByTestId("action-row")).toHaveCount(6, { timeout: 30000 });
  const latest = (name) => writes.filter((write) => write.name === name).at(-1);

  // Deviation: Mark handled closes it in the follow-up log.
  await row(page, "deviation").getByTestId("needs-action-mark_handled").click();
  await expect
    .poll(() => latest("follow-up")?.body)
    .toMatchObject({
      alert_id: "ALT-T-E2D",
      status: "RESOLVED",
    });

  // Accident: Escalate records DISPATCHED (and a best-effort WhatsApp alert).
  await row(page, "accident").getByTestId("needs-action-escalate").click();
  await expect
    .poll(() => latest("follow-up")?.body)
    .toMatchObject({
      alert_id: "driver-exception:E2E-ACC",
      status: "DISPATCHED",
    });
  await expect.poll(() => latest("whatsapp")?.body?.truck_code).toBe("T-E2A");

  // Gate peak: Accept takes every recommended hold.
  await row(page, "gate_peak").getByTestId("needs-action-accept").click();
  await expect
    .poll(() => writes.filter((write) => write.name === "accept").map((write) => write.url.split("/").at(-2)))
    .toEqual(["rec-a", "rec-b"]);

  // Empty TPS: Skip stop skips that stop of that work order, with the drivers' reason.
  await row(page, "tps_empty").getByTestId("needs-action-skip_stop").click();
  await expect.poll(() => latest("skip")?.url).toMatch(/\/spj\/SPJ-E2E-G\/stops\/1\/skip$/);
  expect(latest("skip").body).toEqual({ reason: "Dilaporkan kosong oleh 3 sopir" });

  // Breakdown: Reassign asks first, then moves the plan share and closes the item.
  const breakdown = row(page, "truck_breakdown");
  await breakdown.getByTestId("needs-action-reassign").click();
  await expect(breakdown.locator(".ops-confirm")).toContainText(
    "Pindahkan bagian T-E2B dari rencana hari ini ke T-E2C?",
  );
  expect(latest("reassign")).toBeUndefined();
  await breakdown.getByTestId("needs-reassign-confirm").click();
  await expect.poll(() => latest("reassign")?.url).toMatch(/\/operations\/PLAN-E2E\/reassign$/);
  expect(latest("reassign").body).toMatchObject({ from_truck: "T-E2B", to_truck: "T-E2C" });
  await expect
    .poll(() => latest("follow-up")?.body)
    .toMatchObject({
      alert_id: "damage:E2E-DMG",
      status: "RESOLVED",
    });

  // Duty: no relief roster exists, so Plan relief opens the Fleet & drivers duty view.
  await row(page, "duty_warn").getByTestId("needs-action-plan_relief").click();
  await expect(page).toHaveURL(/\/app\/fleet/);
});

test("with nothing open the panel says so in the design's words", async ({ page }) => {
  await page.route(/\/api\/ops\/needs-you$/, (route) =>
    route.fulfill({
      json: { ...FEED, counts: { all: 0, urgent: 0, trucks: 0, gate: 0, tps: 0 }, items: [] },
    }),
  );
  await signIn(page);
  const empty = page.getByTestId("needs-you-empty");
  await expect(empty).toContainText("Tidak ada yang perlu Anda tangani", { timeout: 30000 });
  await expect(page.getByTestId("needs-you-count")).toHaveText("0");
  await expect(page.getByTestId("needs-you-urgent")).toHaveCount(0);
  await expect(page.locator("[data-testid^=needs-filter-]")).toHaveCount(0);
});
