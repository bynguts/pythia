// #5 (gsc-2026 teardown): Ask Pythia inside the twin. A what-if question applies
// rain, crowd, venue and day to the twin in place (no page change), the card shows
// the tool trace with sources and provenance, the provider badge is honest, and
// the scenario rain draws an overlay labelled as an assumption. Present mode
// folds the rail away but keeps the scenario chip.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const QUESTION = "What if 120 mm of rain hits during the JIS concert tomorrow?";

async function signIn(page, lang = "en") {
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
}

async function waitForTwin(page, predicate = "true", timeout = 45000) {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout,
  });
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__pythiaTwin)));
}

const APPLIED =
  "window.__pythiaTwin.scenario.rainfall_mm === 120 && window.__pythiaTwin.scenario.event_attendance === 50000" +
  " && window.__pythiaTwin.venue === 'jis' && window.__pythiaTwin.selectedDay === 1";

test("asking a what-if applies rain, venue and day in place and shows the tool trace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  // Jakarta districts are drawn as their real kecamatan outlines, and no rain by default.
  const before = await waitForTwin(page, "window.__pythiaTwin.outlinedDistricts === 42");
  expect(before.rainDrops).toBe(0);
  await expect(page.getByTestId("twin-rain-label")).toHaveCount(0);
  await expect(page.getByTestId("twin-provenance-boundaries")).toContainText("Real data");

  // A full page load would drop this marker.
  await page.evaluate(() => {
    window.__sameDocument = true;
  });
  await page.getByTestId("twin-ask-input").fill(QUESTION);
  await page.getByTestId("twin-ask-send").click();
  await expect(page.getByTestId("twin-ask-question")).toHaveText(QUESTION);
  await expect(page.getByTestId("twin-ask-applied")).toBeVisible({ timeout: 60000 });

  // The city re-forecasts and the blocks start rising within 3 s of the answer.
  const state = await waitForTwin(page, APPLIED, 3000);
  expect(state.rainDrops).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  await expect(page).toHaveURL(/\/twin\?/);
  await expect(page.getByTestId("twin-rainfall-value")).toHaveText("120 mm");
  await expect(page.getByTestId("twin-event-50k")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-venue-jis")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-day-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-rain-label")).toHaveText("Scenario rain 120 mm · not observed weather");
  // The landfill beacon names the modelled peak hour of the selected day, never the wall clock,
  // and puts that day's average beside the peak-hour wait so the two never read as a contradiction.
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(
    /Peak hour \d{2}:00 \(modelled\): [\d,]+ trucks queued · [\d,]+ min wait/,
  );
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(/Day average [\d.,]+ min\/truck/);
  await expect(page.getByTestId("twin-landfill-tag")).toContainText("Queue data: Simulated");

  // The card: honest provider, assumed crowd, and the steps Ana ran with their provenance.
  const card = page.getByTestId("twin-ask").getByTestId("assistant-scenario-card");
  await expect(card.getByTestId("assistant-provider-badge")).toHaveText(/^(Local parser|LLM: .+)$/);
  await expect(card.getByTestId("assistant-scenario-assumed")).toContainText("assumed 50,000");
  const trace = card.getByTestId("assistant-scenario-trace");
  await expect(trace.locator("li")).toHaveCount(5);
  await expect(card.getByTestId("assistant-trace-parse_scenario")).toContainText(/LOCAL PARSER|LLM/);
  await expect(card.getByTestId("assistant-trace-run_scenario")).toContainText("120 mm · 50,000 people");
  await expect(card.getByTestId("assistant-trace-run_scenario")).toContainText("venue JIS · day +1");
  await expect(card.getByTestId("assistant-trace-forecast_model")).toContainText("MODEL OUTPUT");
  await expect(card.getByTestId("assistant-trace-forecast_model")).toContainText("Prophet + XGBoost");
  await expect(card.getByTestId("assistant-trace-resource_rule")).toContainText("PLANNING RULE");
  await expect(card.getByTestId("assistant-trace-queue_simulation")).toContainText("SIMULATED");
  // Approval stays with the operator in Planning; XR opens on the same scenario.
  await expect(card.getByTestId("assistant-review-plan")).toHaveAttribute("href", "/planning");
  await expect(card.getByTestId("assistant-open-xr")).toHaveAttribute("href", /rainfall_mm=120/);
  await expect(card.getByTestId("assistant-open-twin")).toHaveCount(0);
});

test("present mode folds the rail away and keeps the scenario chip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin?present=1");
  await waitForTwin(page);
  await expect(page.getByTestId("twin-ask")).toHaveCount(0);
  await expect(page.getByTestId("twin-scenario-chip")).toBeVisible();

  await page.getByTestId("twin-ask-toggle").click();
  await page.getByTestId("twin-ask-input").fill(QUESTION);
  await page.getByTestId("twin-ask-input").press("Enter");
  await expect(page.getByTestId("twin-ask-applied")).toBeVisible({ timeout: 60000 });
  // Footage mode also streams the online basemap; the 3 s budget is checked above.
  await waitForTwin(page, APPLIED, 15000);
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    /^Rain 120 mm · Concert 50k at JIS · Day \+1$/i,
  );
  // The HUD names the same modelled peak hour as the beacon, and the unstaggered
  // headline carries its departure-spread sensitivity band from the payload.
  const hour = page.getByTestId("twin-present-queue-hour");
  await expect(hour).toHaveText(/^Peak hour \d{2}:00 \(modelled\)$/);
  await expect(page.getByTestId("twin-landfill-tag")).toContainText((await hour.textContent()).trim());
  const metric = page.getByTestId("twin-present-queue-metric");
  await expect(metric).toHaveText(
    /^TPA queue \(scenario\): [\d.,]+ \([\d.,]+–[\d.,]+\) → [\d.,]+ min\/truck .*\(Simulated\)$/,
  );
  // The beacon's day average is the headline's own unstaggered figure (same simulated day).
  const dayAverage = (await metric.textContent()).match(/^TPA queue \(scenario\): ([\d.,]+)/)[1];
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(`Day average ${dayAverage} min/truck`);
});
