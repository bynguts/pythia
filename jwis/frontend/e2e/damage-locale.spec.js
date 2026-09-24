import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #83: the damage-report operator panel follows ID/EN for headings, counts,
// columns, severity/status presentation, actions, and empty states.
// Raw API enums stay untouched; only presentation translates.
async function signIn(page, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang });
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
  const created = await fetch(`${API}/damage-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
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
  const all = await fetch(`${API}/damage-reports`).then((r) => r.json());
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

test("damage report panel follows the locale in both modes", async ({ page }) => {
  const seeded = await seedReport();
  try {
    await signIn(page, "en");
    await page.locator(".records-doc-link", { hasText: "Damage reports" }).click();
    await expect(page.locator(".damage-panel .panel-head h3")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".damage-panel .panel-head h3")).toHaveText("Damage Reports");
    await expect(page.locator(".damage-panel .panel-head .pill").first()).toContainText("report");
    await expect(page.locator(".damage-panel thead")).toContainText("Time");
    await expect(page.locator(".damage-panel thead")).toContainText("Component");
    await expect(page.locator(".damage-panel thead")).toContainText("Severity");
    await expect(page.locator(".damage-panel thead")).toContainText("Status");
    await expect(page.locator(".damage-panel thead")).toContainText("Action");
    // Enum translated at presentation: berat → Severe, unresolved severe shows NON-OPERATIONAL.
    await expect(page.locator(".damage-panel").getByText("Severe", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel").getByText("NON-OPERATIONAL").first()).toBeVisible();
    await expect(page.locator(".damage-panel").getByText("New", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel").getByRole("button", { name: "Resolve", exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel .table-wrap")).toHaveAccessibleName("Damage report list");

    await page.getByTestId("lang-switch-id").click();
    await expect(page.locator(".records-doc-link", { hasText: "Laporan Kerusakan" })).toBeVisible();
    await expect(page.locator(".damage-panel .panel-head h3")).toHaveText("Laporan Kerusakan");
    await expect(page.locator(".damage-panel .panel-head .pill").first()).toContainText("laporan");
    await expect(page.locator(".damage-panel thead")).toContainText("Waktu");
    await expect(page.locator(".damage-panel thead")).toContainText("Komponen");
    await expect(page.locator(".damage-panel").getByText("Berat", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel").getByText("Baru", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel").getByRole("button", { name: "Selesaikan", exact: true }).first()).toBeVisible();
    await expect(page.locator(".damage-panel .table-wrap")).toHaveAccessibleName("Daftar laporan kerusakan");
  } finally {
    await cleanupReport(seeded?.report_id);
  }
});
