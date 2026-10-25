import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #21: the planning review (stage 03 executive summary) must derive from the
// ACTIVE outlook — changing the what-if inputs must change the review's numbers.
// Teardown v4 R2: Rencana opens on today's baseline (/api/baseline/scenario without
// rain or crowd, kind "baseline"); a manual what-if is opt-in and labelled "Skenario".
// NOTE: ExecutiveSummary picks its headline kecamatan by the LARGEST ABSOLUTE ton
// increase over its normal day among those at risk (high/critical) — mirror that here.
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
  // handler would serve stale caches to this suite. Unregister every worker and
  // clear caches so this page talks to the live backend only.
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

const AT_RISK = ["high", "critical"]; // engine.spike_risk, AT_RISK_LEVELS

function peakKecamatan(outlook) {
  const atRisk = (outlook.kecamatan || []).filter((k) => AT_RISK.includes(k.risk_level));
  return atRisk.reduce(
    (best, k) =>
      !best || k.predicted_tons - k.normal_tons > best.predicted_tons - best.normal_tons ? k : best,
    null,
  );
}

const outlookResponse = (attendance) => (res) =>
  res.url().includes("/baseline/scenario") &&
  res.url().includes(`event_attendance=${attendance}&`) &&
  res.status() === 200;

test("planning review derives from the active outlook", async ({ page }) => {
  await signIn(page);
  // Attach the listener BEFORE opening the workspace: the outlook loads on mount.
  const baselinePromise = page.waitForResponse(outlookResponse(0), { timeout: 30000 });
  await page.locator(".command-nav").getByRole("button", { name: "Rencana", exact: true }).click();
  await expect(page.getByTestId("planning-workspace")).toBeVisible();
  const baseline = await (await baselinePromise).json();
  expect(baseline.kind).toBe("baseline");
  await expect(page.getByTestId("plan-outlook")).toHaveAttribute("data-kind", "baseline");

  const headline = page.getByTestId("exec-headline");
  const baselinePeak = peakKecamatan(baseline);
  if (baselinePeak) {
    await expect(headline).toContainText(baselinePeak.kecamatan, { timeout: 15000 });
  } else {
    await expect(headline).toHaveText(/Tidak ada wilayah/, { timeout: 15000 });
  }

  // Open the opt-in what-if and set a large crowd → the outlook reruns as a scenario
  // and the review must re-derive from the NEW response.
  const scenarioPromise = page.waitForResponse(outlookResponse(200000), { timeout: 30000 });
  await page.getByTestId("manual-whatif").locator("summary").click();
  await page.getByTestId("scenario-attendance").evaluate((el) => {
    // Programmatic value change fires React's onChange via the native setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "200000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const scenario = await (await scenarioPromise).json();
  expect(scenario.kind).toBe("scenario");
  const scenarioPeak = peakKecamatan(scenario);
  expect(scenarioPeak).toBeTruthy();

  await expect(page.getByTestId("plan-scenario-badge")).toBeVisible();
  await expect(headline).toContainText(scenarioPeak.kecamatan, { timeout: 15000 });
  await expect(page.locator(".planning-summary .exec-scenario-note")).toContainText("Skenario");
});
