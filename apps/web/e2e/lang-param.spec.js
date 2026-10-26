// gsc-2026 P0-7: ?lang=en|id on any route sets the UI language before first render and persists it.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// Wave 13: English is the default, so the stored language here is Indonesian and
// English can only come from ?lang=en.
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
}

function nav(page, id) {
  return page.getByTestId("workspace-navigation").getByTestId(`nav-${id}`);
}

for (const path of ["/app/operations", "/app/tomorrow"]) {
  test(`${path}?lang=en renders English navigation and ?lang=id switches back`, async ({ page }) => {
    await signIn(page);

    await page.goto(`${path}?lang=en`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(nav(page, "tomorrow")).toHaveText("Tomorrow");
    await expect(nav(page, "fleet")).toHaveText("Fleet & drivers");
    expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("en");

    // The choice persists without the parameter.
    await page.goto(path);
    await expect(nav(page, "tomorrow")).toHaveText("Tomorrow");

    await page.goto(`${path}?lang=id`);
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await expect(nav(page, "tomorrow")).toHaveText("Besok");
    await expect(nav(page, "fleet")).toHaveText("Armada & sopir");
    expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("id");
  });
}

test("an unknown ?lang value keeps the stored language", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tomorrow?lang=fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(nav(page, "tomorrow")).toHaveText("Besok");
});

test("with no stored language the console opens in English", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => localStorage.removeItem("pythia_lang"));
  await page.goto("/app/tomorrow");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(nav(page, "tomorrow")).toHaveText("Tomorrow");
});

test("?lang=id also applies on the signed-out login gate", async ({ page }) => {
  await page.goto("/app/tomorrow?lang=id");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(page.locator('input[type="password"]')).toBeVisible();
});
