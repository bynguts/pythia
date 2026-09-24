import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #82: every Driver Analytics string — metrics, table headers, statuses,
// attention rail, and state copy — must follow the selected locale.
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

async function openDrivers(page) {
  await page.locator(".command-nav").getByRole("button", { name: "Drivers", exact: true }).click();
  await expect(page.locator(".driver-workspace")).toBeVisible();
}

test("driver analytics follows the locale in both modes", async ({ page }) => {
  await signIn(page, "en");
  await openDrivers(page);

  await expect(page.locator(".driver-workspace h1")).toContainText("Driver and fleet status");

  // Metrics strip + table headers localized.
  await expect(page.locator(".driver-metric-strip")).toContainText("Assigned units");
  await expect(page.locator(".driver-metric-strip")).toContainText("Named drivers");
  await expect(page.locator(".driver-metric-strip")).toContainText("Current deviations");
  await expect(page.locator(".driver-metric-strip")).toContainText("Damaged units");
  await expect(page.locator(".driver-table thead")).toContainText("Driver");
  await expect(page.locator(".driver-table thead")).toContainText("Current route deviation");
  await expect(page.locator(".driver-attention-rail h2")).toContainText("Operational priority");

  // No stale Indonesian-only strings leak into EN mode.
  for (const stale of ["Skor rata-rata", "Pengemudi aktif", "Perlu pembinaan", "Skor kepatuhan"]) {
    await expect(page.locator(".driver-workspace")).not.toContainText(stale);
  }

  await page.getByTestId("lang-switch-id").click();
  await expect(page.locator(".driver-workspace h1")).toContainText("Kondisi pengemudi dan armada");
  await expect(page.locator(".driver-metric-strip")).toContainText("Unit tercatat");
  await expect(page.locator(".driver-metric-strip")).toContainText("Nama pengemudi");
  await expect(page.locator(".driver-metric-strip")).toContainText("Deviasi saat ini");
  await expect(page.locator(".driver-metric-strip")).toContainText("Unit bermasalah");
  await expect(page.locator(".driver-table thead")).toContainText("Deviasi rute saat ini");
  await expect(page.locator(".driver-attention-rail h2")).toContainText("Prioritas operasional");
});
