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

// Behaviour: with `?lang=en` every console page renders English chrome only.
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

  // Wave 13: every console page, its Settings sections and the twin briefing room.
  const paths = [
    "app/operations",
    "app/readiness",
    "app/gate",
    "app/work-orders",
    "app/tomorrow",
    "app/fleet",
    "app/reports",
    "app/settings",
    "app/settings?tab=team",
    "app/settings?tab=data",
    "twin",
  ];
  for (const workspace of paths) {
    test(`/${workspace} renders English only`, async ({ page }) => {
      const separator = workspace.includes("?") ? "&" : "?";
      await page.goto(`/${workspace}${separator}lang=en`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main h1").first()).toBeVisible({ timeout: 20000 });
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expectNoIndonesianCopy(page, `/${workspace}`);
    });
  }

  // wave 13: the Ask Ana drawer is portalled outside <main>; it follows the locale too.
  test("the Ask Ana drawer renders English only", async ({ page }) => {
    await page.goto("/app/operations?ana=1&lang=en", { waitUntil: "domcontentloaded" });
    const drawer = page.getByTestId("ana-drawer");
    await expect(drawer).toBeVisible({ timeout: 20000 });
    const text = await drawer.innerText();
    for (const marker of INDONESIAN_MARKERS) {
      expect(text, `Ask Ana shows Indonesian "${marker}" in English mode`).not.toContain(marker);
    }
  });
});
