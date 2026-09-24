import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const API = "http://127.0.0.1:8001/api";

// #42: forecast bars must not carry aria-label on plain divs; adjacent text
// already exposes district/amount/unit, and the bar row region keeps one
// programmatic label per row.
async function signIn(page, lang = "id") {
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

test("forecast bars expose data accessibly and pass axe", async ({ page }) => {
  await signIn(page);
  await page.locator(".command-nav").getByRole("button", { name: "Prediksi", exact: true }).click();
  await expect(page.getByTestId("forecast-workspace")).toBeVisible();
  await expect(page.locator(".kec-row").first()).toBeVisible({ timeout: 20000 });

  // No aria-label on plain div bars (aria-prohibited-attr).
  const barsWithAriaLabel = await page.locator(".kec-row .bar[aria-label]").count();
  expect(barsWithAriaLabel).toBe(0);

  // Each row article exposes district + amount + unit exactly once as text.
  const firstRow = page.locator(".kec-row").first();
  const rowText = (await firstRow.textContent()).replace(/\s+/g, " ").trim();
  expect(rowText).toMatch(/\d+ t/);
  expect((rowText.match(/ t /g) || []).length).toBeLessThanOrEqual(4); // tons appear once per metric family, not duplicated per bar

  // Axe: no prohibited ARIA attributes and no contrast failures in the forecast.
  const results = await new AxeBuilder({ page })
    .include(".forecast-workspace")
    .withRules(["aria-prohibited-attr", "color-contrast"])
    .analyze();
  const violations = results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
  expect(violations).toEqual([]);
});
