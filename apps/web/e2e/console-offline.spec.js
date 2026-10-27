import { expect, test } from "@playwright/test";
import { cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// When the API drops, the TPA gate and Work orders keep the last data on screen and say
// since when ("Showing data from HH:MM") instead of blanking into an error state.
async function signIn(page, role = "dispatcher") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role: signedIn }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", signedIn);
  }, principal);
  return principal.token;
}

// Abort every API call, then nudge the screen's loader (it also reloads on the browser's online event).
async function dropApi(page) {
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

let createdIds = [];
let sessionToken = "";
test.afterEach(async () => {
  for (const id of createdIds) await cancelSpjIndependently(sessionToken, id).catch(() => {});
  createdIds = [];
  await disposeCleanupContext().catch(() => {});
});

test("the TPA gate keeps its board and says since when once the API drops", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/app/gate");
  const gate = page.getByTestId("gate-page");
  await expect(gate.locator(".ui-kpi-strip")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);

  await dropApi(page);
  await expect(page.getByTestId("offline-banner")).toContainText(/Showing data from \d{2}:\d{2}\./);
  await expect(gate.locator(".ui-kpi-strip")).toBeVisible();
  await expect(gate.locator(".ui-error")).toHaveCount(0);
});

test("Work orders keeps its list and says since when once the API drops", async ({ page }) => {
  sessionToken = await signIn(page, "administrator");
  const created = await page.request.post(`${API}/spj`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
    data: {
      driver_name: "Pengemudi Sim 41",
      truck_code: "T-257",
      destination: "TPST Bantargebang",
      priority: "normal",
      note: "e2e console offline",
    },
  });
  expect(created.status()).toBe(201);
  const spj = await created.json();
  createdIds = [spj.spj_id];

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/app/work-orders");
  await page.getByTestId("wo-tab-drafts").click();
  const row = page.getByTestId("wo-row").filter({ hasText: spj.spj_number });
  await expect(row).toBeVisible({ timeout: 30000 });

  await dropApi(page);
  await expect(page.getByTestId("offline-banner")).toContainText(/Showing data from \d{2}:\d{2}\./);
  await expect(row).toBeVisible();
  await expect(page.getByText("Work orders did not load")).toHaveCount(0);
});
