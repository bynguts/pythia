// #R7-R8: the day plan treats kecamatan rit quotas, gate caps and dated facility
// rules as hard limits, shows quota use per district and states an infeasible
// remainder; the plan date (not a fixed flag) sets weekday or weekend; /field
// lists the fleet and shows plan dispatches from the Indonesian template; the
// trip history and profile carry honest labels (H2, H5, H12).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function login(page, username) {
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username, password: `${username}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function signIn(page, lang = "id") {
  await page.goto("/");
  const principal = await login(page, "dispatcher");
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

test("plan date sets weekday or weekend for the forecast and the plan", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Rencana", exact: true }).click();
  const dateInput = page.getByTestId("plan-date");
  await expect(dateInput).toBeVisible();

  // Teardown v4 R2: the outlook is /api/baseline/scenario for the chosen day (the backend
  // derives weekday or weekend from the date); the next Saturday and Monday stay inside
  // its 30-day horizon whatever day the suite runs.
  const { saturday: sat, monday: mon } = await page.evaluate(() => {
    const iso = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const next = (weekday) => {
      const d = new Date();
      d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
      return iso(d);
    };
    return { saturday: next(6), monday: next(1) };
  });
  const saturday = page.waitForRequest(
    (req) => req.url().includes("/baseline/scenario") && req.url().includes(`date=${sat}`),
  );
  await dateInput.fill(sat);
  await saturday;
  await expect(page.getByTestId("plan-day-kind")).toHaveText("Akhir pekan");
  await expect(page.getByTestId("plan-outlook")).toContainText(sat);

  const monday = page.waitForRequest(
    (req) => req.url().includes("/baseline/scenario") && req.url().includes(`date=${mon}`),
  );
  await dateInput.fill(mon);
  await monday;
  await expect(page.getByTestId("plan-day-kind")).toHaveText("Hari kerja");
  await expect(page.getByTestId("plan-outlook")).toContainText(mon);

  const planRequest = page.waitForRequest((req) => req.url().includes("/operations/plan?"));
  await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();
  const url = (await planRequest).url();
  expect(url).toContain(`plan_date=${mon}`);
  expect(url).not.toContain("is_weekend");
});

test("quota use per district and an infeasible remainder are shown, not hidden", async ({ page }) => {
  await page.route("**/api/operations/plan?**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(STUB_PLAN) }),
  );
  await signIn(page);
  await page.getByRole("button", { name: "Rencana", exact: true }).click();
  await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();

  await expect(page.getByTestId("plan-scope")).toContainText("Rencana harian 2026-10-26");
  await expect(page.getByTestId("plan-shortfall")).toContainText("Tidak layak: 148 t tidak teralokasi.");
  const cakung = page.getByTestId("quota-row-cakung");
  await expect(cakung).toContainText("14 / 14");
  await expect(cakung).toContainText("Kuota kecamatan habis");
  await expect(cakung).toContainText("Asumsi");
  await expect(page.getByTestId("quota-row-tebet")).toContainText("2 / 14");
  await expect(page.getByText("Kuota kecamatan habis: cakung")).toBeVisible();

  const rules = page.getByTestId("plan-rules");
  await rules.locator("summary").click();
  await expect(rules).toContainText("Porsi residu olahan 25%");
  await expect(rules).toContainText("Dilaporkan");
  await expect(rules.getByRole("link", { name: /Sumber: beritajakarta\.id/ })).toBeVisible();

  // A quota shortfall does not block the feasible trips; it is stated instead.
  await expect(page.getByTestId("approval-shortfall-note")).toContainText("148 t tetap tidak teralokasi");
  await expect(page.getByRole("button", { name: "Setujui & kirim rencana" })).toBeVisible();
});

test("a real day plan never uses more rit than a district quota", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Rencana", exact: true }).click();
  const planResponse = page.waitForResponse((res) => res.url().includes("/operations/plan?"), {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();
  const plan = await (await planResponse).json();

  await expect(page.getByTestId("quota-usage")).toBeVisible();
  for (const row of plan.quota_usage) {
    if (row.quota_rit_per_day != null) expect(row.rit_used).toBeLessThanOrEqual(row.quota_rit_per_day);
    await expect(page.getByTestId(`quota-row-${row.area}`)).toBeVisible();
  }
  if (!plan.feasible) await expect(page.getByTestId("plan-shortfall")).toBeVisible();
});

// wave10 driver-field-app: /field merged into /driver; the plan instruction shows in its Instruksi tab.
test("the driver app finds a simulated truck and shows its approved plan dispatch in Indonesian", async ({
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

  await expect(page.getByTestId("driver-roster-sim")).toHaveText("SIMULASI");
  await page.getByTestId("driver-truck-search").fill(first.truck_code);
  await page.getByTestId(`pick-${first.truck_code}`).click();
  await expect(page.getByTestId("driver-tab-instruksi")).toHaveAttribute("aria-current", "page");
  const card = page.getByTestId("driver-instructions");
  await expect(card).toContainText(`Rencana ${plan.plan_id}`, { timeout: 15000 });
  await expect(card).toContainText("Shift pagi");
  await expect(card).toContainText("Alasan: prakiraan timbulan");

  const structured = await page.request.get(`${API}/operations/instructions/${first.truck_code}`, {
    headers: { Authorization: `Bearer ${driver.token}` },
  });
  const items = (await structured.json()).filter((i) => i.plan_id === plan.plan_id);
  expect(items[0].fields.slot.shift).toBe("pagi");
  expect(items[0].fields.stops.length).toBeGreaterThan(0);
});

// wave9 fleet composition: trip history moved from a fleet tab into the truck drawer
// (Truk → row → Riwayat), per truck instead of a fleet-wide list.
test("trip history says it is a model reconstruction, in both languages", async ({ page }) => {
  for (const [lang, tab, badge, note] of [
    ["id", "Truk", "REKONSTRUKSI MODEL", "bukan arsip telemetri AVL"],
    ["en", "Trucks", "MODEL RECONSTRUCTION", "not archived AVL telemetry"],
  ]) {
    await signIn(page, lang);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByTestId("truck-row").first().click();
    await page.getByTestId("truck-drawer-history").click();
    const surface = page.getByTestId("fleet-history-surface");
    await expect(surface.getByTestId("history-record-note")).toContainText(badge);
    await expect(surface.getByTestId("history-record-note")).toContainText(note);
  }
});

test("profile shows the signed-in role and the shared demo account", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("profile-role")).toHaveText("Pengatur armada");
  await expect(page.getByTestId("profile-account")).toHaveText("Akun demo bersama: dispatcher");
});
