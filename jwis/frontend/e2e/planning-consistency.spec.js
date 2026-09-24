import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #21: the planning review (stage 03 executive summary) must derive from the
// ACTIVE scenario response — changing simulator inputs must change the
// review's numbers. The preloaded snapshot is only a fallback before any
// scenario data exists.
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

function topDistrictFromScenario(scenario) {
  const districts = scenario.kecamatan || [];
  return districts.reduce((best, k) => {
    const spike = k.baseline_tons_per_day > 0
      ? (k.predicted_tons - k.baseline_tons_per_day) / k.baseline_tons_per_day
      : 0;
    const bestSpike = best && best.baseline_tons_per_day > 0
      ? (best.predicted_tons - best.baseline_tons_per_day) / best.baseline_tons_per_day
      : -1;
    return spike > bestSpike ? k : best;
  }, null);
}

test("planning review derives from the active scenario inputs", async ({ page }) => {
  await signIn(page);
  // Attach the listener BEFORE opening the workspace: the scenario auto-runs
  // on mount (useEffect on attendance/rainfall).
  // Only PlanningDecisionFlow's own request counts — KecamatanMapPanel fetches
  // the same endpoint with different params (0/0 defaults) in parallel workers.
  const isDecisionFlowResponse = (res) =>
    res.url().includes("/predictions/kecamatan") &&
    res.url().includes("event_attendance=85000") &&
    res.url().includes("rainfall_mm=42") &&
    res.status() === 200;
  const baselinePromise = page.waitForResponse(isDecisionFlowResponse, { timeout: 30000 });
  await page.locator(".command-nav").getByRole("button", { name: "Rencana", exact: true }).click();
  await expect(page.getByTestId("planning-workspace")).toBeVisible();
  const baselineResponse = await baselinePromise;
  const baseline = await baselineResponse.json();
  const baselinePeak = topDistrictFromScenario(baseline);
  expect(baselinePeak).toBeTruthy();

  // The review headline must name the ACTIVE scenario's peak district, not
  // the preloaded snapshot (whose fixed fallback peak is CENGKARENG).
  const summary = page.locator(".planning-review-grid .planning-summary");
  await expect(summary).toContainText(baselinePeak.kecamatan, { timeout: 15000 });

  // Change the simulator inputs drastically → scenario auto-reruns → the
  // review must re-derive from the NEW response.
  const scenarioPromise = page.waitForResponse(
    (res) => res.url().includes("/predictions/kecamatan") &&
      res.url().includes("event_attendance=200000") && res.status() === 200,
    { timeout: 30000 },
  );
  await page.locator('input[type="range"]').first().evaluate((el) => {
    // Programmatic value change fires React's onChange via the native setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "200000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const scenarioResponse = await scenarioPromise;
  const scenario = await scenarioResponse.json();
  const scenarioPeak = topDistrictFromScenario(scenario);
  expect(scenarioPeak).toBeTruthy();

  await expect(summary).toContainText(scenarioPeak.kecamatan, { timeout: 15000 });
});
