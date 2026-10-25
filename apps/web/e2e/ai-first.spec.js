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

// wave9 fleet composition: reroute approvals left "Lapisan & kontrol" for the default
// "Perlu tindakan" rail tab (teardown v4 F6).
test("operations context exposes the AI traffic monitor without a simulate button", async ({ page }) => {
  const panel = page.getByTestId("fleet-rail-action").getByTestId("astar-panel");
  await expect(panel).toContainText("Pengalihan rute otomatis", { timeout: 15000 });
  await expect(page.locator(".astar-toggle-btn")).toHaveCount(0);
});

test("TPA queue shows its forecast gauge or honest empty state", async ({ page }) => {
  await page.getByRole("tab", { name: "Antrean TPA" }).click();
  await expect(page.getByText(/Prediksi Antrean TPA|Prediksi Antrian TPA/)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tpa-live-gauge, .ai-feed-empty").first()).toBeVisible();
});

test("planning flow exposes the seven-day outlook", async ({ page }) => {
  await page.getByRole("button", { name: "Rencana" }).click();
  await expect(page.getByText("Prediksi AI 7 hari")).toBeVisible({ timeout: 15000 });
});

// wave9 fleet composition: carbon is not a dispatch task, so it left /fleet (teardown v4 F8).
test("fleet no longer carries the carbon panel", async ({ page }) => {
  await expect(page.getByTestId("metric-strip")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("carbon-panel")).toHaveCount(0);
  await expect(page.getByTestId("fleet-workspace")).not.toContainText("Jejak Karbon");
});

// wave9 fleet composition: unlicensed collectors are an alert type in "Perlu tindakan",
// polled while that tab is open, instead of a separate "Kolektor Liar" document link.
test("unlicensed collector surface reads the AI flags endpoint", async ({ page }) => {
  const responsePromise = page.waitForResponse((res) => res.url().includes("/api/ai/unlicensed-flags"), {
    timeout: 20000,
  });
  await expect(page.getByTestId("fleet-rail-action")).toBeVisible();
  expect((await responsePromise).ok()).toBeTruthy();
});
