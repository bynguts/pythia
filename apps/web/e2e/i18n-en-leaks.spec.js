import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// Indonesian interface copy that must never render when the UI language is English.
const INDONESIAN_MARKERS = [
  "Kendali langsung",
  "Diperbarui",
  "dtk",
  "Bukti operasional",
  "Detail armada",
  "Tidak ada flag",
  "Memuat",
  "Belum ada",
];

// Behaviour: with `?lang=en` every command-center workspace renders English chrome only.
async function signInEnglish(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
}

async function expectNoIndonesianCopy(page, scope) {
  const text = await page.locator("main").innerText();
  for (const marker of INDONESIAN_MARKERS) {
    expect(text, `${scope} shows Indonesian "${marker}" in English mode`).not.toContain(marker);
  }
}

test.describe("English mode has no Indonesian interface copy", () => {
  test.beforeEach(async ({ page }) => {
    await signInEnglish(page);
  });

  for (const workspace of ["fleet", "twin", "forecast", "planning", "drivers", "audit"]) {
    test(`/${workspace} renders English only`, async ({ page }) => {
      await page.goto(`/${workspace}?lang=en`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expectNoIndonesianCopy(page, `/${workspace}`);
    });
  }

  test("fleet unlicensed-collector tab renders English only", async ({ page }) => {
    await page.goto("/fleet?lang=en", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Unlicensed Collectors" }).click();
    await expect(page.getByTestId("fleet-unlicensed-surface")).toBeVisible();
    await expectNoIndonesianCopy(page, "fleet unlicensed tab");
  });
});
