// gsc-2026 P0-4/P0-5: simulated and modelled figures say so in both languages and never
// claim "live". The redesign retired the fleet desk's queue, stagger and A* panels (and their old
// fixed 47→19 / 116→48 / 58.6% figures). Founder decision 2026-10-27: no on-screen
// Model / Simulated badges; provenance stays in data-provenance plus a tooltip, and
// Settings → Data and provenance is the one place that names every source.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

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

// Teardown #3, Operations: the fleet is a simulated pilot fleet and the gate
// queue is model output, so the KPI strip never claims "live" / "langsung"; with no gate slot
// for now, the gate tile falls back to the queue model and names its modelled peak hour
// (never the wall-clock hour of a modelled profile).
const OPS_COPY = {
  id: { peak: "per truk, puncak model", sep: ".", min: "mnt", simulated: "bukan GPS langsung" },
  en: { peak: "per truck, modelled peak", sep: ":", min: "min", simulated: "not live GPS" },
};

for (const lang of ["id", "en"]) {
  test(`operations KPIs say simulated and model, never live, and name the modelled peak hour (${lang})`, async ({
    page,
  }) => {
    const copy = OPS_COPY[lang];
    const status = await (await page.request.get(`${API}/tpa/queue-status`)).json();
    expect(status.classification).toBe("SIMULATED");
    expect(Number.isInteger(status.modelled_hour)).toBe(true);
    const tileHour = `${String(status.modelled_hour).padStart(2, "0")}${copy.sep}00`;
    await page.route(/\/api\/gate\/slots$/, (route) =>
      route.fulfill({ json: { slots: [], recommendations: [], reason: "no_approved_plan" } }),
    );

    await signIn(page, lang);
    await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
    const strip = page.getByTestId("metric-strip");
    const tile = page.getByTestId("kpi-gate");
    await expect(tile.locator(".ui-kpi-value strong")).toHaveText(
      `${Math.round(status.avg_wait_minutes)} ${copy.min}`,
      { timeout: 30000 },
    );
    await expect(tile.locator(".ui-kpi-sub")).toHaveText(`${copy.peak} ${tileHour}`);
    await expect(tile.locator("[data-provenance=model]")).toHaveCount(1);
    await expect(tile.locator(".ui-tag-model")).toHaveCount(0);
    await expect(page.getByTestId("kpi-trucks").locator("[data-provenance=simulated]")).toHaveAttribute(
      "title",
      new RegExp(copy.simulated),
    );
    const kpiArea = await strip.innerText();
    expect(kpiArea).not.toMatch(/\blive\b|langsung|SIMULASI|SIMULATED/i);
  });
}

// #honesty: the login story never calls the simulated fleet "live" and never reads as a
// DLH product; it names the case it was built for.
const LOGIN_COPY = {
  id: {
    proof: "Setiap angka dapat ditelusuri ke sumbernya",
    stale: /Operasi langsung|Prediksi terukur|Dinas Lingkungan Hidup Provinsi|DLH DKI/,
  },
  en: {
    proof: "Every figure traceable to its source",
    stale: /Live operations|Measured forecasts|Jakarta Environmental Agency|DLH DKI/,
  },
};

for (const lang of ["id", "en"]) {
  // The product login names no client; the "prototype for the DLH case"
  // footer is gone, and the story still never presents itself as a DLH product.
  test(`login proof strings are sourced and present no client's product (${lang})`, async ({ page }) => {
    const copy = LOGIN_COPY[lang];
    await page.addInitScript((value) => localStorage.setItem("pythia_lang", value), lang);
    await page.goto("/app");
    const proof = page.getByTestId("login-proof-list");
    await expect(proof).toContainText(copy.proof);
    const story = await page.locator(".si-art").innerText();
    expect(story).not.toMatch(copy.stale);
    expect(story).not.toMatch(/\blive\b/i);
  });
}

// #honesty, Tomorrow: the forecast keeps data-provenance="model" (no Model badge since
// 2026-10-27), the simulated pilot fleet says so in data-provenance and a tooltip (no badge,
// never "live"), and the page reads as a decision brief, not a DLH document.
for (const [lang, fleetTitle] of [
  ["id", "Armada pilot simulasi"],
  ["en", "Simulated pilot fleet"],
]) {
  test(`tomorrow labels model and simulated figures thinly (${lang})`, async ({ page }) => {
    await signIn(page, lang);
    await page.goto("/app/tomorrow");
    const forecast = page.getByTestId("tmr-forecast");
    await expect(forecast).toHaveAttribute("data-provenance", "model", { timeout: 60000 });
    await expect(forecast.locator(".ui-tag-model")).toHaveCount(0);
    const tmr = page.locator(".tmr");
    await expect(page.getByTestId("tmr-alloc-loading")).toHaveCount(0, { timeout: 30000 });
    if (await page.getByTestId("tmr-kpis").count()) {
      const trucks = page.getByTestId("tmr-kpi-trucks").locator("..");
      await expect(trucks).toHaveAttribute("data-provenance", "simulated");
      await expect(trucks).toHaveAttribute("title", fleetTitle);
    }
    await expect(tmr).not.toContainText(/SIMULASI|SIMULATED/);
    expect(await tmr.innerText()).not.toMatch(/DLH|Dinas Lingkungan Hidup|\blive\b|langsung/i);
  });
}

// #N1 (teardown v3): an unreachable forecast never falls back to a canned sample.
// The card says the forecast couldn't load, prints no tonnage, and the plan can't be built.
for (const [lang, error] of [
  ["id", "Prakiraan besok gagal dimuat."],
  ["en", "Tomorrow's forecast couldn't load."],
]) {
  test(`an unreachable forecast shows an error, never a sample (${lang})`, async ({ page }) => {
    await page.route("**/api/forecast/tomorrow?*", (route) => route.abort());
    await signIn(page, lang);
    await page.goto("/app/tomorrow");
    const forecast = page.getByTestId("tmr-forecast");
    await expect(forecast).toContainText(error, { timeout: 30000 });
    await expect(forecast.getByTestId("plan-total")).toHaveCount(0);
    await expect(forecast).not.toContainText(/\d t\b/);
    const build = page.getByTestId("tmr-build");
    if (await build.count()) await expect(build).toBeDisabled();
  });
}

// Founder decision 2026-10-27: with the badges gone from the screens, Settings → Data and
// provenance is where the simulated pilot fleet and the modelled gate queue are named.
for (const [lang, copy] of [
  ["id", { fleet: "Armada pilot", gate: "Antrean gerbang Bantargebang", sim: "Simulasi" }],
  ["en", { fleet: "Pilot fleet", gate: "Bantargebang gate queue", sim: "Simulated" }],
]) {
  test(`settings names the simulated fleet and the modelled gate queue (${lang})`, async ({ page }) => {
    await signIn(page, lang);
    await page.goto("/app/settings?tab=data");
    const table = page.getByTestId("settings-provenance").getByRole("table");
    await expect(table).toBeVisible({ timeout: 30000 });
    await expect(table.getByRole("row").filter({ hasText: copy.fleet })).toContainText(copy.sim);
    await expect(table.getByRole("row").filter({ hasText: copy.gate })).toContainText("Model");
    expect(await table.innerText()).not.toMatch(/live GPS|GPS langsung/i);
  });
}
