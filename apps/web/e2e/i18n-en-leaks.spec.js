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

  // wave9 settings: Settings (each section) replaced the audit workspace.
  const paths = ["fleet", "twin", "forecast", "planning", "drivers", "settings", "settings?tab=team"];
  for (const workspace of [...paths, "settings?tab=data"]) {
    test(`/${workspace} renders English only`, async ({ page }) => {
      const separator = workspace.includes("?") ? "&" : "?";
      await page.goto(`/${workspace}${separator}lang=en`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expectNoIndonesianCopy(page, `/${workspace}`);
    });
  }

  // wave9 fleet composition: unlicensed collectors are rows in "Needs action" now, so the
  // check walks the three work-rail tabs instead of the old collector tab.
  test("fleet work rail tabs render English only", async ({ page }) => {
    await page.goto("/fleet?lang=en", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("fleet-rail-action")).toBeVisible();
    await expectNoIndonesianCopy(page, "fleet needs-action tab");
    await page.getByRole("tab", { name: "Trucks", exact: true }).click();
    await expect(page.getByTestId("truck-list")).toBeVisible();
    await expectNoIndonesianCopy(page, "fleet trucks tab");
    await page.getByRole("tab", { name: /TPA Queue/ }).click();
    await expect(page.getByTestId("fleet-queue-surface")).toBeVisible();
    await expectNoIndonesianCopy(page, "fleet TPA queue tab");
  });
});
