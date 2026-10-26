// wave13 Reports (y3BicK): the close of the day reads the API, labels what is modelled, and
// never invents a number. The API is stubbed so every figure is known.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
const at = (h, m) =>
  new Date(`${today()}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+07:00`).toISOString();

function recap(date, isToday) {
  return {
    date,
    forecast: { planned_tons: isToday ? 8557 : 7000, planned_trips: isToday ? 156 : null },
    actual: { receipt_tons: isToday ? 8466 : null, ritasi: isToday ? 152 : 0, receipts: 1 },
    delta: { tons: -91, pct: -1.1, delta_basis: null },
    gate_wait: { observed_n: 40, median_min: 14, mean_min: 16, max_min: 47 },
    incidents: { exceptions: {}, damage_reports: 0 },
    evidence: { stops_missing_evidence: 1, overrides: 0, receipts_pending_review: 0 },
    summary: { en: "x", id: "x" },
    summary_lines: {
      en: ["152 of 156 trips done.", "Average gate wait 16 min."],
      id: ["152 dari 156 ritase."],
    },
  };
}

async function open(page, path, lang = "en") {
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
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test("Reports shows the closed day with its provenance and honest limits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => window.__opened.push(String(url));
  });
  await page.route(/\/api\/recap\/daily/, (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    return route.fulfill({ json: recap(date, date === today()) });
  });
  await page.route(/\/api\/driver\/exceptions/, (route) =>
    route.fulfill({
      json: {
        count: 2,
        exceptions: [
          {
            exception_id: "e1",
            kind: "truck_breakdown",
            truck_code: "T-019",
            reported_at: at(5, 6),
            created_at: at(5, 6),
            damage_report_id: "d1",
          },
          {
            exception_id: "e2",
            kind: "accident",
            truck_code: "T-088",
            reported_at: at(9, 14),
            created_at: at(9, 14),
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/damage-reports/, (route) =>
    route.fulfill({
      json: {
        count: 1,
        reports: [
          {
            report_id: "d1",
            truck_code: "T-019",
            component: "Brakes",
            severity: "berat",
            status: "baru",
            created_at: at(5, 6),
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/alert\/follow-ups/, (route) =>
    route.fulfill({
      json: [
        {
          event_type: "alert_followup",
          created_at: at(9, 30),
          payload: { alert_id: "driver-exception:e1", status: "RESOLVED", note: "Swapped to backup T-140" },
        },
      ],
    }),
  );
  await page.route(/\/api\/ml\/suitability/, (route) =>
    route.fulfill({
      json: { monthly_backtest: { landfill_month: { mape_model_pct: 4.3, period: "2022-12..2026-04" } } },
    }),
  );
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  await page.route(/\/api\/operations\/plans/, (route) =>
    route.fulfill({
      json: [
        {
          plan_id: "p",
          plan_date: tomorrow,
          total_demand_tons: 8501,
          approved_at: at(16, 20),
          status: "approved",
        },
      ],
    }),
  );

  // No alert group chosen: the gateway refuses and WhatsApp opens with the text instead.
  await page.route(/\/api\/whatsapp\/summary/, (route) =>
    route.fulfill({ status: 409, json: { detail: "Choose an alert group first." } }),
  );
  await open(page, "/app/reports");
  await expect(page.getByTestId("reports-page")).toHaveAttribute("data-date", today(), { timeout: 30000 });
  await expect(page.getByTestId("recap-trips")).toContainText("152 of 156");
  await expect(page.getByTestId("recap-trips")).toContainText("97% of plan");
  await expect(page.getByTestId("recap-actual")).toContainText("8,466 t");
  await expect(page.getByTestId("recap-actual")).toContainText("vs 8,557 t planned");
  await expect(page.getByTestId("recap-gate-wait")).toContainText("16 min");
  await expect(page.getByTestId("recap-gate-wait")).toContainText("longest 47 min");
  // The forecast error is the monthly backtest, tagged Model, never "this week".
  await expect(page.getByTestId("recap-error")).toContainText("4.3%");
  await expect(page.getByTestId("recap-error")).toContainText("Model");
  await expect(page.getByTestId("recap-error")).toContainText("Monthly intake backtest");

  // The chart is the pilot fleet, not the city.
  await expect(page.getByTestId("reports-chart")).toContainText("Pilot fleet: planned vs weighed");
  await expect(page.getByTestId("reports-chart")).toContainText("not the whole city intake");

  // The breakdown and its damage report are one row; the open accident says it is open.
  const exceptions = page.getByTestId("reports-exceptions");
  await expect(exceptions).toContainText("1 handled · 1 open");
  await expect(exceptions.locator("tbody tr")).toHaveCount(2);
  await expect(exceptions).toContainText("Swapped to backup T-140");

  const carried = page.getByTestId("reports-carried");
  await expect(carried).toContainText("T-019 to the workshop");
  await expect(carried).toContainText("1 stop without proof");
  await expect(carried).toContainText("approved");

  // With no alert group the send falls back to WhatsApp with the text ready.
  await page.getByTestId("reports-send").click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain("152 of 156 trips done.");
});

test("Reports reads — for a day with no records, never 0", async ({ page }) => {
  await page.route(/\/api\/recap\/daily/, (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    return route.fulfill({
      json: {
        date,
        forecast: { planned_tons: null, planned_trips: null },
        actual: { receipt_tons: null, ritasi: 0, receipts: 0 },
        delta: { tons: null, pct: null, delta_basis: null },
        gate_wait: { observed_n: 0, median_min: null, mean_min: null, max_min: null },
        incidents: { exceptions: {}, damage_reports: 0 },
        evidence: { stops_missing_evidence: 0, overrides: 0, receipts_pending_review: 0 },
        summary: { en: "x", id: "x" },
        summary_lines: { en: ["No plan or recorded activity for this day yet."], id: [] },
      },
    });
  });
  // An empty day has no driver exceptions or damage reports either, whatever earlier specs wrote.
  await page.route(/\/api\/driver\/exceptions/, (route) => route.fulfill({ json: { exceptions: [] } }));
  await page.route(/\/api\/damage-reports$/, (route) => route.fulfill({ json: { reports: [] } }));
  await open(page, "/app/reports");
  await expect(page.getByTestId("recap-actual").locator(".rp-stat-v")).toHaveText("—", { timeout: 30000 });
  await expect(page.getByTestId("recap-trips").locator(".rp-stat-v")).toHaveText("—");
  await expect(page.getByTestId("recap-gate-wait").locator(".rp-stat-v")).toHaveText("—");
  await expect(page.getByTestId("reports-exceptions")).toContainText("No exceptions reported today.");
});

test("Reports fits a 390 px phone without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/app/reports");
  await expect(page.getByTestId("reports-page")).toBeVisible({ timeout: 30000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Send summary posts to the alert group and says so", async ({ page }) => {
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => window.__opened.push(String(url));
  });
  let body = null;
  await page.route(/\/api\/whatsapp\/summary/, (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { sent: true, recipient: "Group: 6281****@g.us", chars: 10 } });
  });
  await open(page, "/app/reports");
  await expect(page.getByTestId("reports-page")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("reports-send").click();
  await expect(page.getByTestId("reports-sent")).toBeVisible();
  expect(body.text).toContain("Pythia");
  expect(await page.evaluate(() => window.__opened)).toHaveLength(0);
});
