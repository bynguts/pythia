// #5 (gsc-2026 teardown): Ask Pythia inside the twin. A what-if question applies
// rain, crowd, venue and day to the twin in place (no page change), the card shows
// the tool trace with sources and provenance, the provider badge is honest, and
// the scenario rain draws an overlay labelled as an assumption. Present mode
// folds the rail away but keeps the scenario chip.
// #8 (gsc-2026 teardown): no dead ends. Rain words run at a stated BMKG category
// value, any other question shows Ana's text answer with an honest provider badge,
// and the rail scrolls its answer instead of clipping it, input still in view.
import AxeBuilder from "@axe-core/playwright";
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
  // #twin-weather: before a what-if the label names the base week's rain source
  // (Open-Meteo forecast, or assumed dry when it is unreachable), never a scenario.
  await expect(page.getByTestId("twin-rain-label")).toHaveAttribute("data-input", /^(forecast|assumed_dry)$/);
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
  // 120 mm is beyond the rain model's training range: the label says the effect is held there.
  await expect(page.getByTestId("twin-rain-label")).toHaveText(
    /^Scenario rain 120 mm · not observed weather · Effect held at [\d.]+ mm \(training range\)\.$/,
  );
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
  // The chip stays one short line: the held rain effect is marked "(held)" and spelled
  // out in its title, its screen-reader text and, visibly, on the map's rain label.
  const chipText = page.getByTestId("twin-scenario-text");
  await expect(chipText).toHaveText(/^Rain 120 mm \(held\) · Concert 50k at JIS · Day \+1$/i);
  const held = /^Effect held at [\d.]+ mm \(training range\)\.$/;
  await expect(chipText).toHaveAttribute("title", held);
  await expect(page.getByTestId("twin-scenario-held")).toHaveText(held);
  await expect(page.getByTestId("twin-rain-label")).toBeVisible();
  await expect(page.getByTestId("twin-rain-label")).toContainText(
    /Effect held at [\d.]+ mm \(training range\)/,
  );
  // The HUD names the same modelled peak hour as the beacon, and the unstaggered
  // headline carries its departure-spread sensitivity band from the payload.
  const hour = page.getByTestId("twin-present-queue-hour");
  await expect(hour).toHaveText(/^Peak hour \d{2}:00 \(modelled\)$/);
  await expect(page.getByTestId("twin-landfill-tag")).toContainText((await hour.textContent()).trim());
  const metric = page.getByTestId("twin-present-queue-metric");
  await expect(metric).toHaveText(
    /^TPA queue \(scenario\): [\d.,]+ min\/truck without stagger \(range [\d.,]+–[\d.,]+ if departure spread is \d+–\d+ min, assumed\) → [\d.,]+ with Pythia stagger .*\(Simulated\)$/,
  );
  // The beacon's day average is the headline's own unstaggered figure (same simulated day).
  const dayAverage = (await metric.textContent()).match(/^TPA queue \(scenario\): ([\d.,]+)/)[1];
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(`Day average ${dayAverage} min/truck`);
});

// A long answer for the layout checks: far taller than the rail.
const LONG_ANSWER = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}: Ana explains how the forecast, queue and fleet views fit together.`,
)
  .concat("LAST LINE OF THE ANSWER")
  .join("\n\n");

async function stubAnswer(page, body) {
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function ask(page, question) {
  await page.getByTestId("twin-ask-input").fill(question);
  await page.getByTestId("twin-ask-send").click();
}

test("a rain word runs at its BMKG category value and the card says it was assumed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await ask(page, "What if it rains heavily tomorrow?");
  await expect(page.getByTestId("twin-ask-applied")).toBeVisible({ timeout: 60000 });
  await waitForTwin(
    page,
    "window.__pythiaTwin.scenario.rainfall_mm === 75 && window.__pythiaTwin.selectedDay === 1",
    15000,
  );
  await expect(page.getByTestId("twin-rainfall-value")).toHaveText("75 mm");
  const card = page.getByTestId("twin-ask").getByTestId("assistant-scenario-card");
  await expect(card.getByTestId("assistant-scenario-rain-category")).toHaveText(
    `"rains heavily" → 75 mm (BMKG 'lebat' 50–100 mm/day): assumed from the BMKG category, not measured.`,
  );
});

test("a non-scenario question shows Ana's text answer, labelled local without a key", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await ask(page, "Who won the football match last night?");
  const answer = page.getByTestId("twin-ask-answer");
  await expect(answer).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("twin-ask-applied")).toHaveCount(0);
  const badge = (await page.getByTestId("twin-ask-provider").textContent()).trim();
  expect(badge).toMatch(/^(Local parser|Local parser · LLM failed \(.+\)|LLM: .+)$/);
  if (badge === "Local parser") {
    // No key on the backend: the answer itself says it is local, and what local mode can do.
    await expect(answer).toContainText("Local mode (no LLM assistant configured).");
    await expect(answer).toContainText("what-if scenarios");
  }
});

test("the provider badge names the served LLM, or the fallback after an LLM error", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await stubAnswer(page, {
    provider: "openai",
    provider_name: "llm.example.test",
    model: "served-model-x",
    mode: "llm",
    answer: "The **forecast** uses Prophet with an XGBoost residual.",
    tools_used: [],
  });
  await ask(page, "How does the forecast work?");
  await expect(page.getByTestId("twin-ask-provider")).toHaveText("LLM: llm.example.test · served-model-x");
  await expect(page.getByTestId("twin-ask-answer").locator("strong")).toHaveText("forecast");

  await page.unroute("**/api/assistant/query");
  await stubAnswer(page, {
    provider: "local",
    mode: "fallback",
    fallback_reason: "HTTP 401",
    llm_model: "configured-model",
    answer: "The LLM provider failed (HTTP 401); this answer comes from the local parser, not the LLM.",
    tools_used: [],
  });
  await ask(page, "How does the forecast work?");
  await expect(page.getByTestId("twin-ask-provider")).toHaveText("Local parser · LLM failed (HTTP 401)");
  await expect(page.getByTestId("twin-ask-answer")).toContainText("not the LLM");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a long answer scrolls inside the rail with the input in view at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    await stubAnswer(page, { provider: "local", mode: "local", answer: LONG_ANSWER, tools_used: [] });
    await ask(page, "Explain the whole workflow");
    const result = page.getByTestId("twin-ask-result");
    await expect(page.getByTestId("twin-ask-answer")).toContainText("LAST LINE OF THE ANSWER");

    // The result region scrolls (not overflow: hidden) and is shorter than its content.
    const box = await result.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(box.overflowY).toBe("auto");
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(box.clientHeight).toBeLessThanOrEqual(viewport.height * 0.6 + 1);

    // The question box stays fully on screen above the answer, not clipped by the rail.
    await page.getByTestId("twin-ask").evaluate((el) => el.scrollIntoView({ block: "center" }));
    const input = await page.getByTestId("twin-ask-input").boundingBox();
    const region = await result.boundingBox();
    expect(input.y).toBeGreaterThanOrEqual(0);
    expect(input.y + input.height).toBeLessThanOrEqual(region.y);
    expect(region.y + region.height).toBeLessThanOrEqual(viewport.height + 1);

    // Scrolling the region reaches the last line: nothing is cut off.
    await result.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const last = page.getByText("LAST LINE OF THE ANSWER");
    await expect(last).toBeInViewport();
    const lastBox = await last.boundingBox();
    const regionAfter = await result.boundingBox();
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(regionAfter.y + regionAfter.height + 1);

    // The scrolling region is keyboard reachable, nothing overflows sideways, and contrast holds.
    await expect(result).toHaveAttribute("tabindex", "0");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    const axe = await new AxeBuilder({ page })
      .include("[data-testid=twin-ask]")
      .withRules(["color-contrast", "scrollable-region-focusable"])
      .analyze();
    expect(axe.violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)])).toEqual([]);
  });
}
