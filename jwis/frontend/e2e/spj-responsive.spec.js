import { expect, test } from "@playwright/test";
import { cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = "http://127.0.0.1:8001/api";

// #78: the SPJ panel is usable on narrow viewports — the table stays inside
// a contained scroller with no page overflow, and expansion uses a named
// button with aria-expanded and keyboard support.
async function signIn(page, lang = "id", role = "dispatcher") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: role === "admin" ? "admin-demo-pass" : "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang, role });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function openFleet(page) {
  // Fleet is the default workspace; the SPJ panel lives inside the
  // "Surat Perintah Jalan" detail tab (role=tab), same as the proven
  // spj-workflow.spec.js flow.
  await page.getByRole("button", { name: "Surat Perintah Jalan" }).click();
  await expect(page.locator(".spj-panel")).toBeVisible({ timeout: 20000 });
}

let createdIds = [];
test.afterEach(async () => {
  const token = await page_token;
  for (const id of createdIds) await cancelSpjIndependently(token, id).catch(() => {});
  await disposeCleanupContext().catch(() => {});
});

// The dispatcher session token for independent cleanup.
let page_token = Promise.resolve("");

test("SPJ expansion is a named keyboard-operable button and the panel stays contained at 390px", async ({ page }) => {
  page_token = signIn(page, "id", "admin").then(() => page.evaluate(() => localStorage.getItem("jwis_token")));
  await page.setViewportSize({ width: 390, height: 844 });
  await openFleet(page);

  // Wait for the SPJ list to load at least one row (admin seeds demo SPJs).
  const row = page.locator(".spj-table tbody tr.spj-row").first();
  await expect(row).toBeVisible({ timeout: 20000 });

  // The expansion control is a named button with aria-expanded.
  const expandButton = row.locator("button[aria-expanded]").first();
  await expect(expandButton).toBeVisible();
  expect(await expandButton.getAttribute("aria-label")).toContain("Tampilkan rincian");

  // Keyboard: focus + Enter expands the detail row.
  await expandButton.focus();
  await page.keyboard.press("Enter");
  const detailId = await expandButton.getAttribute("aria-controls");
  await expect(page.locator(`#${detailId}`)).toBeVisible();
  expect(await expandButton.getAttribute("aria-expanded")).toBe("true");

  // No page-level horizontal overflow at 390px.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // Keyboard: Enter again collapses.
  await expandButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`#${detailId}`)).toHaveCount(0);
});

test("SPJ create form works at 390px without overflow", async ({ page }) => {
  await signIn(page, "id", "dispatcher");
  page_token = page.evaluate(() => localStorage.getItem("jwis_token"));
  await page.setViewportSize({ width: 390, height: 844 });
  await openFleet(page);

  // Pick the first available truck and add one stop, then save the draft.
  const truckSelect = page.locator(".spj-form select").first();
  await truckSelect.waitFor({ timeout: 20000 });
  const option = truckSelect.locator("option:not([value=''])").first();
  const optionValue = await option.getAttribute("value");
  await truckSelect.selectOption(optionValue);

  const picker = page.locator(".spj-stop-picker input");
  await picker.waitFor({ timeout: 20000 });
  const site = await page.evaluate(async () => {
    const token = localStorage.getItem("jwis_token");
    const res = await fetch("http://127.0.0.1:8001/api/geo/tps-coordinates");
    const body = await res.json();
    const f = (body.features || []).find((x) => x.properties?.name);
    return f?.properties?.name || "";
  });
  await picker.fill(site);
  await page.locator(".spj-stop-picker button").click();
  await page.getByRole("button", { name: "Simpan draf" }).click();

  // The new order appears in the list (draft state).
  await expect(page.locator(".spj-table tbody tr.spj-row").first()).toBeVisible({ timeout: 20000 });
  createdIds = await page.evaluate(async () => {
    const res = await fetch("http://127.0.0.1:8001/api/spj");
    const body = await res.json();
    return (body.spj || []).filter((s) => ["draft", "aktif"].includes(s.status)).map((s) => s.spj_id);
  });

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});
