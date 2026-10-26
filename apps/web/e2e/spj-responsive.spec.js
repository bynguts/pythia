import { expect, test } from "@playwright/test";
import { cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #78: Work orders is usable on narrow viewports. The page never scrolls sideways, a work order
// opens from a named, keyboard-operable row, and the create form works inside its drawer.
async function signIn(page, role = "dispatcher") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  // SPJ lists need a token: a failed login must fail here, not as an empty list.
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role: signedIn }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", signedIn);
  }, principal);
  return principal.token;
}

async function openWorkOrders(page) {
  await page.goto("/app/work-orders", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("work-orders-page")).toBeVisible({ timeout: 20000 });
}

const noSidewaysScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

let createdIds = [];
let sessionToken = "";
test.afterEach(async () => {
  for (const id of createdIds) await cancelSpjIndependently(sessionToken, id).catch(() => {});
  createdIds = [];
  await disposeCleanupContext().catch(() => {});
});

test("a work order opens from a keyboard-operable row and the page stays contained at 390px", async ({
  page,
}) => {
  sessionToken = await signIn(page, "administrator");
  // Seed one draft so the list is never empty, whatever ran before.
  const created = await page.request.post(`${API}/spj`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
    data: {
      driver_name: "Pengemudi Sim",
      truck_code: "T-255",
      destination: "TPST Bantargebang",
      priority: "normal",
      note: "e2e spj responsive",
    },
  });
  expect(created.status()).toBe(201);
  const spj = await created.json();
  createdIds = [spj.spj_id];
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkOrders(page);

  await page.getByTestId("wo-tab-drafts").click();
  await page.getByTestId("wo-search").fill(spj.spj_number);
  const row = page.getByTestId("wo-row").filter({ hasText: spj.spj_number });
  await expect(row).toBeVisible({ timeout: 20000 });
  const box = await row.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);

  // Keyboard: focus + Enter selects the row and its detail shows.
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("wo-detail")).toContainText(spj.spj_number);
  expect(await noSidewaysScroll(page)).toBeTruthy();
});

test("the create form works at 390px without overflow", async ({ page }) => {
  sessionToken = await signIn(page, "dispatcher");
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkOrders(page);
  await page.getByTestId("wo-new").click();

  // Pick the first available truck and add one stop, then save the draft.
  const form = page.locator(".spj-form");
  const truckSelect = form.locator("select").first();
  await truckSelect.waitFor({ timeout: 20000 });
  const optionValue = await truckSelect.locator("option:not([value=''])").first().getAttribute("value");
  await truckSelect.selectOption(optionValue);

  const picker = form.locator(".spj-stop-picker input");
  await picker.waitFor({ timeout: 20000 });
  const site = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/geo/tps-coordinates`);
    const body = await res.json();
    const f = (body.features || []).find((x) => x.properties?.name);
    return f?.properties?.name || "";
  }, API);
  await picker.fill(site);
  await form.locator(".spj-stop-picker button").click();
  expect(await noSidewaysScroll(page)).toBeTruthy();
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/spj") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Simpan draf" }).click();
  const saved = await (await responsePromise).json();
  createdIds = [saved.spj_id];

  // The new order appears in Drafts and the drawer is gone.
  await page.getByTestId("wo-tab-drafts").click();
  await expect(page.getByTestId("wo-row").filter({ hasText: saved.spj_number })).toBeVisible({
    timeout: 20000,
  });
  expect(await noSidewaysScroll(page)).toBeTruthy();
});
