// gsc-2026 P0-4/P0-5: the stagger panel never shows the old fixed 47→19 / 116→48 / 58.6% figures, and the TPA, stagger, carbon and A* panels carry a SIMULATED label in both languages.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

const COPY = {
  id: { sim: "SIMULASI", queueTab: /Antrean TPA/, carbonLink: "Jejak Karbon" },
  en: { sim: "SIMULATED", queueTab: /TPA Queue/, carbonLink: "Carbon Footprint" },
};

async function signIn(page, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
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
  await page.reload({ waitUntil: "domcontentloaded" });
}

test("stagger panel shows a loading state, not the old fixed figures, before the simulation answers", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hold = async (route) => {
    await gate;
    await route.continue();
  };
  await page.route("**/api/tpa/queue-metric", hold);
  await page.route("**/api/simulator/stagger", hold);

  await signIn(page, "en");
  await page.getByRole("tab", { name: COPY.en.queueTab }).click();
  const panel = page.getByTestId("stagger-panel");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("stagger-queue-metric-status")).toBeVisible();
  const before = await panel.innerText();
  expect(before).not.toMatch(/58[.,]6|\b116\b|\b47\b|\b19\b/);

  release();
  const metric = page.getByTestId("stagger-queue-metric");
  await expect(metric).toBeVisible({ timeout: 30000 });
  await expect(metric).toContainText("seed");
  await expect(page.getByTestId("stagger-panel")).not.toContainText("58.6%");
});

for (const lang of ["id", "en"]) {
  test(`queue, stagger, carbon and A* panels are labelled simulated (${lang})`, async ({ page }) => {
    const copy = COPY[lang];
    await signIn(page, lang);

    await page.getByRole("tab", { name: copy.queueTab }).click();
    await expect(page.getByTestId("tpa-sim-badge")).toHaveText(copy.sim, { timeout: 15000 });
    await expect(page.getByTestId("stagger-sim-badge")).toHaveText(copy.sim);
    await expect(page.getByTestId("tpa-queue-panel")).not.toContainText(/real-time|live clock|waktu nyata/i);
    await expect(page.getByTestId("tpa-queue-metric-sim-badge")).toHaveText(copy.sim, { timeout: 30000 });

    await page.locator(".records-doc-link", { hasText: copy.carbonLink }).click();
    await expect(page.getByTestId("carbon-sim-badge")).toHaveText(copy.sim, { timeout: 15000 });
    await expect(page.getByTestId("carbon-panel")).not.toContainText(/route telemetry|telemetri rute/i);

    await page.getByTestId("deck-tools-toggle").click();
    await expect(page.getByTestId("astar-sim-badge")).toHaveText(copy.sim, { timeout: 15000 });
    await expect(page.getByTestId("astar-panel")).not.toContainText(/real-time/i);
  });
}

test("TPA arrival rate unit follows the language", async ({ page }) => {
  await page.route("**/api/ai/tpa-queue-live", (route) =>
    route.fulfill({
      json: {
        trucks_in_queue: 3,
        arriving_soon: 2,
        arrival_rate_per_h: 12,
        predicted_wait_min: 4,
        wait_ci95: [3, 5],
        trend: "stable",
        congestion_level: "low",
      },
    }),
  );
  await signIn(page, "en");
  await page.getByRole("tab", { name: COPY.en.queueTab }).click();
  await expect(page.getByTestId("tpa-arrival-rate")).toHaveText("12/h", { timeout: 15000 });
});
