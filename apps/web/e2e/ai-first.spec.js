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

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
});

// Operations: the AI router's reroute is the deviation card's "Pythia suggests",
// sent with one button; there is no simulate button on the dispatcher's screen.
test("the deviation card carries the AI reroute without a simulate button", async ({ page }) => {
  const card = page.locator('[data-testid=action-row][data-kind="deviation"]').first();
  await expect(card.getByTestId("needs-suggestion")).toContainText("Saran Pythia", { timeout: 30000 });
  await expect(card.getByTestId("needs-action-send_route")).toHaveText("Kirim rute ke sopir");
  await expect(page.locator(".astar-toggle-btn")).toHaveCount(0);
});

// The gate queue figure is model output: it says so in data-provenance and a tooltip (no
// on-screen badge, founder decision 2026-10-27), and shows a dash, never a sample, when the
// model has no answer.
test("the gate queue KPI is labelled as model output", async ({ page }) => {
  const tile = page.getByTestId("kpi-gate");
  await expect(tile.locator(".ui-tag-model")).toHaveCount(0);
  await expect(tile.locator(".ui-kpi-value strong")).toHaveText(/^(\d+ mnt|—)$/, { timeout: 30000 });
  await expect(tile.locator("[data-provenance=model]")).toHaveCount(1);
});

// Fleet composition: carbon is not a dispatch task (teardown v4 F8); still true on
// The Operations screen.
test("operations carries no carbon panel", async ({ page }) => {
  await expect(page.getByTestId("metric-strip")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("carbon-panel")).toHaveCount(0);
  await expect(page.getByTestId("fleet-workspace")).not.toContainText("Jejak Karbon");
});
