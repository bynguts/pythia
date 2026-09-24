import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const API = "http://127.0.0.1:8001/api";

// #37: Planning headings follow a contiguous outline (h1 → h2 → h3, no
// skipped levels) independent of visual styling.
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

test("planning headings follow a contiguous outline and pass axe", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Rencana", exact: true }).click();
  await expect(page.getByTestId("planning-workspace")).toBeVisible();

  const headings = await page.locator(".planning-workspace h1, .planning-workspace h2, .planning-workspace h3, .planning-workspace h4, .planning-workspace h5, .planning-workspace h6").all();
  const levels = [];
  for (const heading of headings) {
    levels.push(Number((await heading.evaluate((el) => el.tagName)).slice(1)));
  }
  expect(levels.length).toBeGreaterThan(0);

  // Contiguous outline: first is h1 and each heading steps at most +1.
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i], `heading ${i} jumps from h${levels[i - 1]} to h${levels[i]}`)
      .toBeLessThanOrEqual(levels[i - 1] + 1);
  }

  const results = await new AxeBuilder({ page })
    .include(".planning-workspace")
    .withRules(["heading-order"])
    .analyze();
  expect(results.violations).toEqual([]);
});
