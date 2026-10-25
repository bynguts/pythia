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
  await page.reload({ waitUntil: "domcontentloaded" });
}

test.beforeEach(async ({ page }) => signIn(page));

// wave9 fleet composition: the decision overlay, problem strip, "Status Armada" table and
// document links were replaced by one metric strip, a three-tab work rail beside the map
// and one "Dokumen armada" tablist (teardown v4 F1-F5).
test("fleet opens as a map-led deck with the work rail beside the map", async ({ page }) => {
  const map = page.getByTestId("fleet-map-stage");
  const rail = page.getByTestId("fleet-rail");
  await expect(map).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("tab", { name: /Perlu tindakan/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fleet-rail-action")).toBeVisible();

  // The map keeps the larger share; the rail sits beside it, never over it.
  // wave11 fleet: the approved design (docs/design/export/app-fleet.png) puts the rail
  // on the left and lets the map run to the right edge.
  const [mapBox, railBox] = await Promise.all([map.boundingBox(), rail.boundingBox()]);
  expect(mapBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 2);
  expect(mapBox.width).toBeGreaterThan(railBox.width);
});

test("metric strip opens the deviation queue and the TPA queue", async ({ page }) => {
  await expect(page.getByTestId("metric-strip")).toBeVisible({ timeout: 15000 });
  const deviation = page.locator("[data-metric=deviation]");
  await deviation.click();
  await expect(page.getByRole("tab", { name: /Perlu tindakan/ })).toHaveAttribute("aria-selected", "true");

  const queue = page.locator("[data-metric=queue]");
  if (await queue.count()) {
    await queue.click();
    await expect(page.getByTestId("fleet-queue-surface")).toBeVisible();
  }
});

test("fleet document tabs reveal one surface and support keyboard selection", async ({ page }) => {
  const tablist = page.getByRole("tablist", { name: "Dokumen armada" });
  const spj = tablist.getByRole("tab", { name: "Surat jalan (SPJ)" });
  const damage = tablist.getByRole("tab", { name: "Laporan Kerusakan" });
  await expect(spj).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fleet-spj-surface")).toBeVisible();
  await damage.click();
  await expect(damage).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fleet-damage-surface")).toBeVisible();
  await expect(page.getByTestId("fleet-spj-surface")).toBeHidden();

  await damage.focus();
  await page.keyboard.press("Home");
  await expect(spj).toBeFocused();
  await expect(spj).toHaveAttribute("aria-selected", "true");
});

test("mobile fleet stacks the work rail under the map without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const map = page.getByTestId("fleet-map-stage");
  const rail = page.getByTestId("fleet-rail");
  await expect(rail).toBeVisible();
  const [mapBox, railBox] = await Promise.all([map.boundingBox(), rail.boundingBox()]);
  expect(railBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height - 2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("fleet-rail-action")).toBeVisible();
});

// #6 (gsc-2026 teardown): at 390 px the landfill tag ran off the canvas and the
// controls dock covered the timeline.
test("mobile twin keeps the landfill tag inside the canvas and the controls off the timeline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/twin");
  await page.waitForFunction(() => window.__pythiaTwin?.ready, null, { timeout: 45000 });
  const tag = page.getByTestId("twin-landfill-tag");
  await expect(tag).toBeVisible();
  const [mapBox, tagBox] = await Promise.all([page.getByTestId("twin-map").boundingBox(), tag.boundingBox()]);
  expect(tagBox.x).toBeGreaterThanOrEqual(mapBox.x);
  expect(tagBox.y).toBeGreaterThanOrEqual(mapBox.y);
  expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
  expect(tagBox.y + tagBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);

  // Scrolled to the timeline, nothing floats over its day buttons.
  const timeline = page.getByTestId("twin-timeline");
  await timeline.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const covered = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-testid=twin-timeline] button")].filter((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit && !button.contains(hit);
      }).length,
  );
  expect(covered).toBe(0);
  const [toggleBox, timelineBox] = await Promise.all([
    page.getByTestId("twin-sheet-toggle").boundingBox(),
    timeline.boundingBox(),
  ]);
  expect(toggleBox.y).toBeGreaterThanOrEqual(timelineBox.y + timelineBox.height);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("map layers panel opens inside the deck and lists controls", async ({ page }) => {
  await page.getByTestId("deck-tools-toggle").click();
  const panel = page.getByTestId("deck-tools-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Lapisan referensi", { exact: true })).toBeVisible();
  await expect(panel.locator(".map-controls-grid label").first()).toBeVisible();
});

test("forecast keeps district demand primary and horizon controls functional", async ({ page }) => {
  await page.getByRole("button", { name: "Prediksi" }).click();
  const primary = page.getByTestId("forecast-primary-analysis");
  const context = page.locator(".forecast-context-rail");
  await expect(primary).toBeVisible();
  await expect(context).toBeVisible();
  await expect(page.locator(".kec-list .kec-row").first()).toBeVisible({ timeout: 15000 });
  expect(await page.locator(".kec-list .kec-row").count()).toBeLessThanOrEqual(8);

  const selected = page.getByRole("button", { name: "7 hari" });
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const next = page.getByRole("button", { name: "14 hari" });
  await next.click();
  await expect(next).toHaveAttribute("aria-pressed", "true");

  const [primaryBox, contextBox] = await Promise.all([primary.boundingBox(), context.boundingBox()]);
  expect(primaryBox.width).toBeGreaterThan(contextBox.width);
});

test("planning presents scenario, allocation, and approval as one flow", async ({ page }) => {
  await page.route("**/api/operations/plan?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        plan_id: "PLAN-E2E",
        status: "proposed",
        assignments: [
          {
            truck_code: "T-001",
            area: "tebet",
            assigned_tons: 24,
            evidence: { capacity_tons: 24, permit_compliant: true },
          },
        ],
        unmet_reasons: [],
        total_demand_tons: 24,
        total_assigned_tons: 24,
        scenario: { rainfall_mm: 42, event_attendance: 85000, is_weekend: true },
      }),
    });
  });

  await page.getByRole("button", { name: "Rencana" }).click();
  await expect(page.locator(".planning-progress li")).toHaveCount(3);
  // Teardown v4 R2: stage 1 starts from today's forecast; a scenario is opt-in.
  for (const heading of ["Mulai dari prakiraan", "Susun alokasi", "Tinjau & setujui"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();
  await expect(page.getByText("ID rencana: PLAN-E2E")).toBeVisible();
  await expect(page.getByText("Izin sesuai")).toBeVisible();
});

// wave9 settings: the audit content moved to Settings → Sumber data & model, collapsed.
test("data sources section exposes provenance and model suitability evidence", async ({ page }) => {
  await page.getByTestId("workspace-navigation").getByRole("button", { name: "Pengaturan" }).click();
  await page.getByTestId("settings-tab-data").click();
  await expect(page.getByRole("heading", { name: "Sumber data & model" })).toBeVisible();
  await page.getByTestId("source-registry-disclosure").locator("summary").click();
  await expect(page.locator(".audit-table tbody tr").first()).toBeVisible({ timeout: 15000 });
  expect(await page.locator(".audit-table tbody tr").count()).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Resolusi yang didukung" })).toBeVisible();
});
