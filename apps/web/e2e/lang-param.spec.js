// gsc-2026 P0-7: ?lang=en|id on any route sets the UI language before first render and persists it.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// Stored language is Indonesian (the default), so English can only come from ?lang=en.
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

function nav(page, name) {
  return page.getByTestId("workspace-navigation").getByRole("button", { name, exact: true });
}

// wave9 fleet composition: the twin's nav label is "3D City" / "Kota 3D".
for (const path of ["/fleet", "/twin"]) {
  test(`${path}?lang=en renders English navigation and ?lang=id switches back`, async ({ page }) => {
    await signIn(page);

    await page.goto(`${path}?lang=en`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(nav(page, "3D City")).toBeVisible();
    await expect(nav(page, "Fleet")).toBeVisible();
    await expect(nav(page, "Forecast")).toBeVisible();
    await expect(nav(page, "Kota 3D")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("en");

    // The choice persists without the parameter.
    await page.goto(path);
    await expect(nav(page, "3D City")).toBeVisible();

    await page.goto(`${path}?lang=id`);
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await expect(nav(page, "Kota 3D")).toBeVisible();
    await expect(nav(page, "Armada")).toBeVisible();
    await expect(nav(page, "Prediksi")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("id");
  });
}

test("an unknown ?lang value keeps the stored language", async ({ page }) => {
  await signIn(page);
  await page.goto("/fleet?lang=fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(nav(page, "Armada")).toBeVisible();
});

test("?lang=en also applies on the signed-out login page", async ({ page }) => {
  await page.goto("/fleet?lang=en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Sign in to command center" })).toBeVisible();
});
