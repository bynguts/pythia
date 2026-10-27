// #R7-R8, Tomorrow: the day plan treats kecamatan rit quotas, gate caps and dated
// facility rules as hard limits, and the page states what the plan leaves short instead of
// hiding it; the plan day (not a fixed flag) sets weekday or weekend; the driver app shows
// an approved plan's dispatch from the Indonesian template; the profile carries the role.
import { expect, test } from "@playwright/test";
import { freeDay, planDay, signIn as signInTomorrow } from "./lib/tomorrow.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function login(page, username) {
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username, password: `${username}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function signIn(page, lang = "id", username = "dispatcher") {
  await page.goto("/");
  const principal = await login(page, username);
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

const STUB_PLAN = {
  plan_id: "PLAN-QUOTA",
  status: "proposed",
  kind: "day_plan",
  plan_date: "2026-10-26",
  is_weekend: false,
  scope: { kind: "day_plan", plan_date: "2026-10-26", districts: 2, district_total: 42 },
  assignments: [
    {
      truck_code: "T-001",
      area: "cakung",
      assigned_tons: 18,
      shift: "pagi",
      facility: "TPST Bantargebang",
      trip_index: 1,
      evidence: { capacity_tons: 18, permit_compliant: true },
    },
  ],
  dispatches: [],
  unmet_reasons: ["kecamatan_quota:cakung"],
  total_demand_tons: 430,
  total_assigned_tons: 282,
  unassigned_tons: 148,
  feasible: false,
  shortfall_label: "infeasible: 148 t unassigned",
  quota_usage: [
    {
      area: "cakung",
      label: "Cakung",
      demand_tons: 400,
      assigned_tons: 252,
      unassigned_tons: 148,
      rit_used: 14,
      rit_needed: 23,
      quota_rit_per_day: 14,
      quota_source: { classification: "assumption", source_url: "https://www.metrotvnews.com/" },
      binding_limit: "kecamatan_quota",
    },
    {
      area: "tebet",
      label: "Tebet",
      demand_tons: 30,
      assigned_tons: 30,
      unassigned_tons: 0,
      rit_used: 2,
      rit_needed: 2,
      quota_rit_per_day: 14,
      quota_source: { classification: "assumption" },
      binding_limit: null,
    },
  ],
  facility_usage: [],
  rules: {
    plan_date: "2026-10-26",
    facilities: [
      {
        name: "TPST Bantargebang",
        display_name: "TPST Bantargebang",
        daily_rit_cap: 675,
        shift_rit_cap: 400,
        daily_tons_cap: null,
        compactor_only: false,
        rules: [
          {
            rule: "residue_share",
            value: 0.25,
            effective_from: "2026-08-01",
            classification: "reported",
            planner_effect_classification: "assumption",
            source_url: "https://www.beritajakarta.id/en/read/154173/",
          },
        ],
      },
    ],
  },
  scenario: {},
};

test("the plan day sets weekday or weekend for the forecast and the plan", async ({ page }) => {
  // The first Saturday or Sunday of the forecast week the page can open (tomorrow + 0..5).
  const offset = [0, 1, 2, 3, 4, 5].find((k) =>
    [0, 6].includes(new Date(`${planDay(k)}T12:00:00Z`).getUTCDay()),
  );
  const weekend = planDay(offset);
  const weekday = planDay(
    [0, 1, 2, 3, 4, 5].find((k) => ![0, 6].includes(new Date(`${planDay(k)}T12:00:00Z`).getUTCDay())),
  );

  await signInTomorrow(page, { lang: "id", path: `/app/tomorrow?date=${weekend}` });
  await expect(page.getByTestId("tmr-forecast")).toHaveAttribute("data-date", weekend, { timeout: 60000 });
  await expect(page.locator("[data-testid=plan-driver][data-kind=weekday]")).toContainText("Akhir pekan");

  await page.goto(`/app/tomorrow?date=${weekday}`);
  await expect(page.getByTestId("tmr-forecast")).toHaveAttribute("data-date", weekday, { timeout: 60000 });
  await expect(page.locator("[data-testid=plan-driver][data-kind=weekday]")).toContainText(
    "Hari kerja biasa",
  );
  await expect(
    page.locator(".tmr input[type=range], .tmr input[type=number], .tmr input[type=date]"),
  ).toHaveCount(0);
});

test("districts the plan leaves short are stated before submit, not hidden", async ({ page }) => {
  const day = await freeDay(page.request, [5]);
  await page.route("**/api/operations/plan?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...STUB_PLAN,
        status: "draft",
        plan_date: day,
        created_at: new Date().toISOString(),
        solve_seconds: 1.4,
      }),
    }),
  );
  await signInTomorrow(page, { lang: "id", path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
  await page.getByTestId("tmr-build").click();

  const flags = page.getByTestId("tmr-flag");
  await expect(flags.filter({ hasText: "Cakung kurang 9 rit" })).toHaveCount(1);
  await expect(flags.filter({ hasText: "Tebet" })).toHaveCount(0);
  await expect(page.getByTestId("tmr-kpi-trips")).toHaveText("1");
  await expect(page.getByTestId("tmr-kpis")).toContainText("282 t direncanakan");
  await expect(page.locator(".planning-progress li").nth(2)).toContainText("CP-SAT · 1,4 dtk");
  // A shortfall does not block the trips that fit: the draft can still be submitted.
  await expect(page.getByTestId("tmr-submit")).toBeVisible();
});

test("a real day plan never uses more rit than a district quota", async ({ page }) => {
  test.setTimeout(120000);
  const day = await freeDay(page.request, [4, 5]);
  await signInTomorrow(page, { lang: "id", path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
  const planResponse = page.waitForResponse((res) => res.url().includes("/operations/plan?"), {
    timeout: 60000,
  });
  await page.getByTestId("tmr-build").click();
  const response = await planResponse;
  const url = response.request().url();
  expect(url).toContain(`plan_date=${day}`);
  expect(url).toContain("auto_inputs=true");
  for (const slider of ["is_weekend", "rainfall_mm", "event_attendance"]) expect(url).not.toContain(slider);
  const plan = await response.json();
  await expect(page.getByTestId("tmr-truck-table")).toBeVisible();
  for (const row of plan.quota_usage) {
    if (row.quota_rit_per_day != null) expect(row.rit_used).toBeLessThanOrEqual(row.quota_rit_per_day);
  }
  const short = plan.quota_usage.filter((row) => row.unassigned_tons > 0);
  if (short.length) {
    await expect(page.locator("[data-testid=tmr-flag][data-kind=short]")).toHaveCount(1);
    if (short.length > 1) {
      await expect(page.locator("[data-testid=tmr-flag][data-kind=short_more]")).toContainText(
        `${short.length - 1} kecamatan lain kurang`,
      );
    }
  }
});

// /field merged into /driver; the plan instruction shows in its Instruksi tab.
// The card renders the plan's structured trips (fields), not the Indonesian template text.
test("the driver app finds a simulated truck and shows its approved plan as trips in Indonesian", async ({
  page,
}) => {
  await page.goto("/");
  const dispatcher = await login(page, "dispatcher");
  const supervisor = await login(page, "supervisor");
  const driver = await login(page, "driver");
  const created = await page.request.post(`${API}/operations/plan?top_n=2`, {
    headers: { Authorization: `Bearer ${dispatcher.token}` },
  });
  expect(created.ok()).toBeTruthy();
  const plan = await created.json();
  const approved = await page.request.post(`${API}/operations/${plan.plan_id}/approve`, {
    headers: { Authorization: `Bearer ${supervisor.token}` },
  });
  expect(approved.ok()).toBeTruthy();
  const first = plan.dispatches[0];

  await page.evaluate((token) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
    }
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_field_token", token);
  }, driver.token);
  await page.goto("/field");

  await expect(page.getByTestId("driver-roster-sim")).toContainText("simulasi");
  await page.getByTestId("driver-truck-search").fill(first.truck_code);
  await page.getByTestId(`pick-${first.truck_code}`).click();
  await page.getByTestId("driver-pick-start").click();
  await expect(page.getByTestId("driver-tab-instruksi")).toHaveAttribute("aria-current", "page");
  const card = page.getByTestId("driver-instructions");
  await expect(card).toContainText("Instruksi hari ini", { timeout: 15000 });
  await expect(card).toContainText(/Rencana ritase · \d+ ritase/);
  await expect(card).toContainText(`Kec. ${first.fields.stops[0].kecamatan}`);
  await expect(card).toContainText("Prakiraan untuk");

  const structured = await page.request.get(`${API}/operations/instructions/${first.truck_code}`, {
    headers: { Authorization: `Bearer ${driver.token}` },
  });
  const items = (await structured.json()).filter((i) => i.plan_id === plan.plan_id);
  expect(items[0].fields.slot.shift).toBe("pagi");
  expect(items[0].fields.stops.length).toBeGreaterThan(0);
});

test("profile shows the signed-in role", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tomorrow");
  await expect(page.getByTestId("profile-role")).toHaveText("Pengatur armada");
  await expect(page.getByTestId("profile-account")).toHaveAttribute("title", "Masuk sebagai dispatcher");
});
