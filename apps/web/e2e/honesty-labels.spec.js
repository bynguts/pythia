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

// gsc teardown #3: the fleet is a simulated pilot fleet, so the fleet KPI area never claims
// "live" / "langsung", and the landfill KPI names the modelled peak hour the API serves
// (never the wall-clock hour of a modelled profile).
const FLEET_COPY = {
  id: { simulated: "armada pilot simulasi", peak: "jam puncak model" },
  en: { simulated: "simulated pilot fleet", peak: "modelled peak hour" },
};

for (const lang of ["id", "en"]) {
  test(`fleet KPI area says simulated, never live, and names the modelled peak hour (${lang})`, async ({
    page,
  }) => {
    const copy = FLEET_COPY[lang];
    const status = await (await page.request.get(`${API}/tpa/queue-status`)).json();
    expect(status.classification).toBe("SIMULATED");
    expect(Number.isInteger(status.modelled_hour)).toBe(true);
    const hour = `${String(status.modelled_hour).padStart(2, "0")}:00`;

    await signIn(page, lang);
    const strip = page.getByTestId("metric-strip");
    await expect(strip).toContainText(copy.simulated, { timeout: 15000 });
    await expect(strip).toContainText(`${copy.peak} ${hour}`, { timeout: 30000 });
    await expect(strip).toContainText(`${Math.trunc(status.avg_wait_minutes)}m`);

    const kpiArea = [
      await strip.innerText(),
      await page.locator(".workspace-heading").first().innerText(),
      await page.getByTestId("problem-chip-queue").innerText(),
    ].join("\n");
    expect(kpiArea).not.toMatch(/\blive\b|langsung/i);
    expect(kpiArea).toContain(hour);

    // The what-if beacon and the headline band come from the same model.
    await page.getByRole("tab", { name: COPY[lang].queueTab }).click();
    await page
      .getByTestId("tpa-queue-panel")
      .getByRole("button", { name: lang === "id" ? "Skenario" : "What-if" })
      .click();
    await expect(page.getByTestId("tpa-modelled-hour")).toHaveText(`${copy.peak} ${hour}`, {
      timeout: 15000,
    });
    await expect(page.getByTestId("tpa-queue-metric-band")).toContainText("SD", { timeout: 30000 });

    // The weighbridge log is the seeded peak hour's own arrivals, each labelled simulated.
    expect(status.scale_logs.length).toBeGreaterThan(0);
    expect(status.scale_logs.every((log) => log.source === "SIMULATED")).toBe(true);
    const logs = page.getByTestId("tpa-scale-logs");
    await expect(logs.locator("li")).toHaveCount(status.scale_logs.length);
    await expect(logs.getByTestId("tpa-scale-log-source")).toHaveText(
      status.scale_logs.map(() => COPY[lang].sim),
    );
    await expect(logs).toContainText(status.scale_logs[0].truck);
    await expect(logs).toContainText(status.scale_logs[0].arrived);
    expect(status.scale_logs[0].arrived.startsWith(hour.slice(0, 3))).toBe(true);
    await expect(logs).not.toContainText(/T-0\d\d|\btons?\b/);
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
