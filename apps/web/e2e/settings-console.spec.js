// wave13 Settings (T6NMuR): sections, honest integration statuses, the provenance table, the
// audit log and the language switch.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function open(page, path, lang = "en", role = "dispatcher") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
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
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test("Integrations show statuses read from the API and two Coming soon rows", async ({ page }) => {
  await page.route("**/api/whatsapp/status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        connected: true,
        link_state: "connected",
        alert_group: { jid: "x@g.us", source: "contacts_file" },
      },
    }),
  );
  await page.route("**/api/forecast/tomorrow", (route) =>
    route.fulfill({ json: { drivers: [{ kind: "weather", source: "unavailable" }] } }),
  );
  await open(page, "/app/settings");
  const whatsapp = page.getByTestId("integration-whatsapp");
  await expect(whatsapp).toContainText("Connected · alert group set");
  // Weather that could not be read is never shown as connected.
  const weather = page.getByTestId("integration-weather");
  await expect(weather).toContainText("Unavailable, using a labelled fallback");
  await expect(weather).not.toContainText("Connected");
  for (const id of ["gps", "weighbridge"]) {
    await expect(page.getByTestId(`integration-${id}`)).toContainText("Coming soon");
    await expect(page.getByTestId(`integration-${id}`).getByRole("button")).toHaveCount(0);
  }
});

test("Data and provenance labels every source and exports the audit log", async ({ page }) => {
  await open(page, "/app/settings?tab=data");
  const table = page.getByTestId("settings-provenance").getByRole("table");
  await expect(table).toBeVisible({ timeout: 30000 });
  await expect(table.getByRole("row").filter({ hasText: "Prophet + XGBoost" })).toContainText("Model");
  await expect(table.getByRole("row").filter({ hasText: "Driver app" })).toContainText("Field");
  await expect(table.getByRole("row").filter({ hasText: "Bantargebang weighing records" })).toContainText(
    "Real data",
  );
  const download = page.waitForEvent("download");
  await page.getByTestId("export-audit-log").click();
  expect((await download).suggestedFilename()).toMatch(/^pythia-audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("the audit log lists recorded events newest first", async ({ page }) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({
      json: [
        {
          created_at: "2026-10-26T08:00:00+00:00",
          event_type: "alert_followup",
          payload: { alert_id: "a1", status: "RESOLVED" },
        },
        {
          created_at: "2026-10-26T07:00:00+00:00",
          event_type: "whatsapp_test",
          payload: { recipient: "Group: 6281****7890", sent: true },
        },
      ],
    }),
  );
  await open(page, "/app/settings?tab=audit");
  const rows = page.getByTestId("settings-audit").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("alert followup");
  await expect(rows.first()).toContainText("status: RESOLVED");
});

test("the audit log says when the role cannot read it", async ({ page }) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await open(page, "/app/settings?tab=audit");
  await expect(page.getByTestId("settings-audit")).toContainText("Your role cannot read the audit log");
});

test("the language switch changes the console language and keeps the section", async ({ page }) => {
  await open(page, "/app/settings?tab=language");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.getByTestId("lang-switch-id").click();
  await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
  await expect(page.getByTestId("lang-switch-id")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/tab=language/);
  expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("id");
});

test("old WhatsApp links open Integrations with WhatsApp expanded", async ({ page }) => {
  await open(page, "/settings?tab=whatsapp");
  await expect(page.getByTestId("settings-tab-integrations")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-whatsapp")).toBeVisible({ timeout: 30000 });
});
