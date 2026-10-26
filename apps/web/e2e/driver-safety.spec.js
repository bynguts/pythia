// #safety (w13 S2): the Fleet & drivers "Duty hours today" card and its alert tile read the duty hours
// against the 10 h / 12 h marks from /safety/overview and keep the simulated provenance. The reasoned
// override that needs spj:override now lives on Morning readiness (readiness-board.spec.js).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

function truck(code, duty, gate, override = null) {
  const dutyState = duty >= 720 ? "blocked" : duty >= 600 ? "warn" : "ok";
  return {
    truck_code: code,
    shift_started_at: "2026-10-20T06:00:00+07:00",
    shift_source: "simulated",
    duty_minutes: duty,
    duty_state: dutyState,
    warn_at_minutes: 600,
    block_at_minutes: 720,
    override,
    gate_wait_minutes: gate,
    gate_state: gate === null ? null : gate >= 180 ? "alert" : "ok",
    gate_alert_at_minutes: 180,
    gate_status: gate === null ? null : "waiting",
    gate_arrived_at: null,
    gate_exited_at: null,
    gate_destination: gate === null ? null : "TPST Bantargebang",
    spj_id: null,
    risk_score: Math.max(duty / 720, (gate || 0) / 180),
    classification: "SIMULATED",
    label: "SIMULATED: seeded demo scenario",
  };
}

function overview({ canOverride = true, overrideFor = null } = {}) {
  const override = { by: "supervisor", reason: "Sopir pengganti belum tiba", at: "2026-10-20T13:00:00Z" };
  const trucks = [
    truck("T-201", 745, null, overrideFor === "T-201" ? override : null),
    truck("T-047", 420, 205),
    truck("T-202", 640, 60),
    ...Array.from({ length: 6 }, (_, i) => truck(`T-21${i}`, 120 + i * 10, null)),
  ];
  return {
    trucks,
    gate_wait_p50: 132,
    gate_wait_p90: 190,
    gate_wait_samples: 2,
    counts: { trucks: trucks.length, duty_warn: 1, duty_blocked: 1, gate_alert: 1 },
    warn_at_minutes: 600,
    block_at_minutes: 720,
    gate_alert_at_minutes: 180,
    shift_window: { date: "2026-10-20", timezone: "Asia/Jakarta (WIB, UTC+7)" },
    classification: "SIMULATED",
    label: "SIMULATED: seeded demo scenario",
    alerts: [],
    viewer: { role: canOverride ? "supervisor" : "dispatcher", can_override: canOverride },
  };
}

async function signIn(page, { role = "dispatcher", lang = "en", path = "/app/fleet" } = {}) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
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
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test("duty hours today lists the longest shifts with the Blocked and Plan relief tags", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const card = page.getByTestId("duty-hours");
  await expect(card.locator("li").first()).toBeVisible({ timeout: 20000 });
  await expect(card).toHaveAttribute("data-provenance", "simulated");
  await expect(page.getByText("Warn 10 h · stop 12 h")).toBeVisible();
  const rows = card.locator("li");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText("12 h 25");
  await expect(rows.first()).toContainText("Blocked");
  await expect(rows.nth(1)).toContainText("10 h 40");
  await expect(rows.nth(1)).toContainText("Plan relief");
  await expect(rows.nth(2)).toContainText("7 h");
});

test("the alert tile counts warn and blocked drivers", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const tile = page.getByTestId("fleet-kpi-duty");
  await expect(tile).toContainText("Duty-hour alerts", { timeout: 20000 });
  await expect(tile).toContainText("2");
  await expect(tile).toContainText("1 blocked at 12 h");
});

test("Indonesian copy, 44 px targets and no horizontal overflow at 390 px", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, { lang: "id" });
  await expect(page.getByRole("heading", { name: "Jam tugas hari ini" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("duty-hours").getByText("Terblokir")).toBeVisible();
  const geometry = await page.evaluate(() => {
    const small = [...document.querySelectorAll(".flt button")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.width < 44 || r.height < 44));
    return { small: small.length, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.small).toBe(0);
  expect(geometry.overflow).toBeLessThanOrEqual(2);
});

test("live backend overview: the card carries simulated provenance exactly when the API says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem("pythia_token"));
  const live = await (
    await page.request.get(`${API}/safety/overview`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  await expect(page.getByTestId("fleet-kpi-duty")).toBeVisible({ timeout: 20000 });
  const card = page.getByTestId("duty-hours");
  if (live.classification === "SIMULATED") await expect(card).toHaveAttribute("data-provenance", "simulated");
  else await expect(card).not.toHaveAttribute("data-provenance", "simulated");
});
