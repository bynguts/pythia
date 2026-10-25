import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #21: the planning review (stage 03 executive summary) must derive from the
// ACTIVE scenario response — changing simulator inputs must change the
// review's numbers. The preloaded snapshot is only a fallback before any
// scenario data exists.
// NOTE: ExecutiveSummary picks its headline district by the LARGEST ABSOLUTE
// ton delta (predicted − baseline), not by spike percent — mirror that here.
// #N2 (teardown v3): it picks among the districts at risk (>= 10% above their
// normal day: the same request without rain or event) when there are any.
async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
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
  // Parallel suites register the PWA service worker on this origin; its fetch
  // handler would serve stale /api/predictions caches to this suite. Unregister
  // every worker and clear caches so this page talks to the live backend only.
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

const RISK_HIGH_RATIO = 1.1; // engine.RISK_HIGH_RATIO

function topDistrictFromScenario(scenario, normal) {
  const normalTons = Object.fromEntries((normal.kecamatan || []).map((k) => [k.kecamatan, k.predicted_tons]));
  const all = scenario.kecamatan || [];
  const atRisk = all.filter(
    (k) => normalTons[k.kecamatan] > 0 && k.predicted_tons / normalTons[k.kecamatan] >= RISK_HIGH_RATIO,
  );
  const districts = atRisk.length ? atRisk : all;
  // Same criterion as ExecutiveSummary: largest absolute predicted − baseline
  // ton delta, so the spec's expectation always matches the review headline.
  return districts.reduce((best, k) => {
    const delta = k.predicted_tons - k.baseline_tons_per_day;
    const bestDelta = best ? best.predicted_tons - best.baseline_tons_per_day : -Infinity;
    return delta > bestDelta ? k : best;
  }, null);
}

test("planning review derives from the active scenario inputs", async ({ page }) => {
  await signIn(page);
  // R7 planning: the plan date defaults to the browser's local day and the
  // weekday or weekend follows from it (never a fixed is_weekend=true).
  const { planDate, weekend } = await page.evaluate(() => {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return { planDate: iso, weekend: now.getDay() === 0 || now.getDay() === 6 };
  });
  const normalResponse = await page.request.get(
    `${API}/predictions/kecamatan?rainfall_mm=0&event_attendance=0&is_weekend=${weekend}&target_date=${planDate}`,
  );
  const normal = await normalResponse.json();
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
  const baselinePeak = topDistrictFromScenario(baseline, normal);
  expect(baselinePeak).toBeTruthy();

  // The review headline must name the ACTIVE scenario's peak district, not
  // the preloaded snapshot (whose fixed fallback peak is CENGKARENG).
  const summary = page.locator(".planning-review-grid .planning-summary");
  await expect(summary).toContainText(baselinePeak.kecamatan, { timeout: 15000 });

  // Change the simulator inputs drastically → scenario auto-reruns → the
  // review must re-derive from the NEW response.
  const scenarioPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/predictions/kecamatan") &&
      res.url().includes("event_attendance=200000") &&
      res.status() === 200,
    { timeout: 30000 },
  );
  await page
    .locator('input[type="range"]')
    .first()
    .evaluate((el) => {
      // Programmatic value change fires React's onChange via the native setter.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "200000");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const scenarioResponse = await scenarioPromise;
  const scenario = await scenarioResponse.json();
  const scenarioPeak = topDistrictFromScenario(scenario, normal);
  expect(scenarioPeak).toBeTruthy();

  await expect(summary).toContainText(scenarioPeak.kecamatan, { timeout: 15000 });
});
