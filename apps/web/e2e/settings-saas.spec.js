// Settings reads as a SaaS settings page (a section list, setting groups of
// hairline rows, roles as a table, data sources as a calm registry) and Sopir as a metric strip,
// a table and a flat attention rail. Every number keeps its provenance label.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, role, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
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
}

async function noOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const CONNECTED = {
  configured: true,
  connected: true,
  link_state: "connected",
  linked_account: "62812****7890@s.whatsapp.net",
  alert_group: { jid: "12036****0042@g.us", source: "contacts_file" },
  provider: "baileys",
  state: "open",
  provenance: { classification: "UNOFFICIAL_CLIENT", label: "Baileys" },
};

test.beforeEach(async ({ page }) => {
  for (const path of ["**/whatsapp/logout", "**/whatsapp/test", "**/whatsapp/alert-group"]) {
    await page.route(path, (route) => route.abort());
  }
});

test("WhatsApp is grouped: connection, delivery, linked device, with no eyebrow", async ({ page }) => {
  await signIn(page, "administrator");
  await page.route("**/whatsapp/status", (route) => route.fulfill({ json: CONNECTED }));
  await page.route("**/whatsapp/groups", (route) =>
    route.fulfill({
      json: { groups: [{ jid: "120363000000000042@g.us", subject: "Pythia Ops", selected: true }] },
    }),
  );
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  const panel = page.getByTestId("settings-whatsapp");
  await expect(page.getByTestId("settings-wa-status")).toHaveText("Terhubung");
  for (const name of ["Koneksi", "Pengiriman peringatan", "Perangkat tertaut"]) {
    await expect(panel.getByRole("heading", { level: 3, name })).toBeVisible();
  }
  // The unofficial transport is disclosed once, in the footnote, not as a chip beside the state.
  await expect(panel.locator(".prov")).toHaveCount(0);
  await expect(panel).toContainText("tidak resmi");
  await expect(page.getByTestId("settings-wa-account")).toHaveText("+62812****7890");
  // Craft floor: no kicker above a heading anywhere on the page.
  await expect(page.locator(".workspace-kicker, .surface-kicker")).toHaveCount(0);
  // The section list marks the current section and sits beside the content on desktop.
  const nav = await page.getByTestId("settings-nav").boundingBox();
  const content = await panel.boundingBox();
  expect(nav.x + nav.width).toBeLessThanOrEqual(content.x);
});

test("pairing lists the three steps in order next to the QR", async ({ page }) => {
  await signIn(page, "administrator");
  await page.route("**/whatsapp/status", (route) =>
    route.fulfill({ json: { ...CONNECTED, connected: false, link_state: "pairing", linked_account: null } }),
  );
  await page.route("**/whatsapp/qr", (route) =>
    route.fulfill({
      json: {
        qr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      },
    }),
  );
  await page.goto("/settings?tab=whatsapp&lang=en", { waitUntil: "domcontentloaded" });
  const pairing = page.getByTestId("settings-wa-pairing");
  await expect(pairing.getByTestId("settings-wa-qr")).toBeVisible();
  await expect(pairing.locator("ol > li")).toHaveText([
    "Open WhatsApp on the operations phone.",
    "Go to Linked devices, then Link a device.",
    "Point the camera at this code.",
  ]);
});

test("team access is one table with a row per role", async ({ page }) => {
  await signIn(page, "supervisor", "en");
  await page.goto("/settings?tab=team", { waitUntil: "domcontentloaded" });
  const table = page.getByTestId("settings-team").getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Role", "Can do", "Permissions"]);
  await expect(table.getByRole("row")).toHaveCount(7);
  const mine = page.getByTestId("settings-role-supervisor");
  await expect(mine).toContainText("Your role");
  await expect(mine.getByRole("cell").last()).toHaveText("6");
});

test("data sources: a strip with provenance per number, registry chips in the one chip style", async ({
  page,
}) => {
  await signIn(page, "dispatcher", "en");
  await page.goto("/settings?tab=data", { waitUntil: "domcontentloaded" });
  const workspace = page.getByTestId("audit-workspace");
  const cells = workspace.getByTestId("metric-cell");
  await expect(cells).toHaveCount(4, { timeout: 15000 });
  for (const cell of await cells.all()) {
    await expect(cell.getByTestId("prov")).toBeVisible();
  }
  await page.getByTestId("source-registry-disclosure").locator("summary").click();
  const rows = page.locator(".audit-table tbody tr");
  await expect(rows.first()).toBeVisible();
  // Every dataset row carries its classification as a provenance label.
  const count = await rows.count();
  await expect(page.locator(".audit-table tbody tr .prov")).toHaveCount(count);
  await expect(page.locator(".audit-table .prov-real").first()).toHaveText(/real/i);
  // The evidence sits under the table in plain columns, not in boxed cards.
  const evidence = page.getByTestId("scentinel-evidence-panel");
  const border = await evidence.evaluate((node) => getComputedStyle(node).borderTopWidth);
  expect(border).toBe("0px");
});

for (const width of [390, 320]) {
  test(`Settings fits a ${width} px phone with 44 px targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page, "administrator");
    await page.route("**/whatsapp/status", (route) => route.fulfill({ json: CONNECTED }));
    await page.route("**/whatsapp/groups", (route) => route.fulfill({ json: { groups: [] } }));
    for (const tab of ["integrations", "team", "data", "audit", "language"]) {
      await page.goto(`/settings?tab=${tab}`, { waitUntil: "domcontentloaded" });
      const button = page.getByTestId(`settings-tab-${tab}`);
      await expect(button).toHaveAttribute("aria-current", "page");
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      if (tab === "data") {
        await page.getByTestId("source-registry-disclosure").locator("summary").click();
        await expect(page.locator(".audit-table tbody tr").first()).toBeVisible({ timeout: 15000 });
      }
      await noOverflow(page);
    }
  });
}
