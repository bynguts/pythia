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

// The redesign retired the fleet deck (work rail, metric-strip queue links, "Dokumen armada" tabs,
// deck layer panel) and the forecast/planning workspaces; Operations, Work orders and Tomorrow
// replace them and carry their own specs; this file keeps their page-level layout checks.
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

// Tomorrow replaces the forecast and planning workspaces with one four-step flow.
test("tomorrow presents forecast, facts, allocation and approval as one flow", async ({ page }) => {
  await page.goto("/app/tomorrow", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("tomorrow-page")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("tmr-title")).toBeVisible();
  const steps = page.locator(".planning-progress");
  await expect(steps).toHaveAttribute("aria-label", /.+/);
  await expect(steps.locator("li")).toHaveCount(4);
});

test("data sources section exposes provenance and model suitability evidence", async ({ page }) => {
  await page.goto("/app/settings?tab=data");
  await expect(page.getByRole("heading", { name: "Sumber data & model" })).toBeVisible();
  await page.getByTestId("source-registry-disclosure").locator("summary").click();
  await expect(page.locator(".audit-table tbody tr").first()).toBeVisible({ timeout: 15000 });
  expect(await page.locator(".audit-table tbody tr").count()).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Resolusi yang didukung" })).toBeVisible();
});

// Operations is map-first. The KPI strip sits above the map, and the
// "Needs you" queue sits on the map's left edge instead of in a rail beside it.
test("operations opens map-first with the KPI strip and the needs-you queue", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  const map = page.getByTestId("fleet-map-stage");
  const queue = page.getByTestId("needs-you");
  const kpis = page.getByTestId("metric-strip");
  await expect(map).toBeVisible({ timeout: 20000 });
  await expect(queue).toBeVisible();
  await expect(kpis).toBeVisible();

  // The map keeps the larger share and the KPI strip stays above it.
  const [mapBox, queueBox, kpiBox] = await Promise.all([
    map.boundingBox(),
    queue.boundingBox(),
    kpis.boundingBox(),
  ]);
  expect(mapBox.width).toBeGreaterThan(queueBox.width);
  expect(kpiBox.y + kpiBox.height).toBeLessThanOrEqual(mapBox.y + 2);
});

test("mobile operations keeps the map and the needs-you queue without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("fleet-map-stage")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("needs-you")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
