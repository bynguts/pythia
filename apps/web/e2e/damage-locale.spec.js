import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #83 (w13 S2): the Fleet & drivers damage table follows ID/EN for headings, columns,
// severity/status presentation and actions.
// Raw API enums stay untouched; only presentation translates.
async function signIn(page, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function loginToken() {
  return fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dispatcher", password: "dispatcher-demo-pass" }),
  }).then((r) => r.json());
}

async function seedReport() {
  const login = await loginToken();
  const headers = { Authorization: `Bearer ${login.token}` };
  const created = await fetch(`${API}/damage-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      truck_code: "T-210",
      driver_name: "Uji E2E",
      component: "Ban",
      severity: "berat",
      note: "laporan uji e2e #83",
      source: "driver_pwa",
    }),
  });
  if (!created.ok) throw new Error(`seed failed: ${created.status}`);
  const all = await fetch(`${API}/damage-reports`, { headers }).then((r) => r.json());
  return all.reports.find((r) => r.note === "laporan uji e2e #83");
}

async function cleanupReport(reportId) {
  if (!reportId) return;
  const login = await loginToken();
  await fetch(`${API}/damage-reports/${reportId}/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.token}` },
  }).catch(() => {});
}

test("the Fleet damage table follows the locale in both modes", async ({ page }) => {
  const seeded = await seedReport();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await signIn(page, "en");
    await page.goto("/app/fleet");
    const table = page.getByTestId("damage-table");
    await expect(table).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("heading", { name: "Damage and workshop" })).toBeVisible();
    await expect(table.locator("thead")).toContainText("Issue");
    await expect(table.locator("thead")).toContainText("Severity");
    await expect(table.locator("thead")).toContainText("Status");
    // The enums stay on the wire (berat, baru); only the presentation translates.
    const row = table.locator("tbody tr").filter({ hasText: "laporan uji e2e #83" });
    await expect(row.getByText("Major", { exact: true })).toBeVisible();
    await expect(row.getByText("Open", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Mark fixed" })).toBeVisible();
    await expect(page.getByTestId("damage-tab-open")).toContainText("Open");

    await page.evaluate(() => localStorage.setItem("pythia_lang", "id"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Kerusakan dan bengkel" })).toBeVisible({
      timeout: 20000,
    });
    const rowId = page
      .getByTestId("damage-table")
      .locator("tbody tr")
      .filter({ hasText: "laporan uji e2e #83" });
    await expect(rowId.getByText("Berat", { exact: true })).toBeVisible();
    await expect(rowId.getByText("Terbuka", { exact: true })).toBeVisible();
    await expect(rowId.getByRole("button", { name: "Tandai selesai" })).toBeVisible();
  } finally {
    await cleanupReport(seeded?.report_id);
  }
});
