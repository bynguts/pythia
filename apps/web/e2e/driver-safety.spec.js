// #safety: R5/R6 driver-safety panel — duty hours against the 10 h / 12 h marks, gate wait against the
// 3 h mark, p50/p90, classification label, and a reasoned override that needs spj:override.
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

async function signIn(page, { role = "supervisor", lang = "id", path = "/pengawas" } = {}) {
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

test("supervisor sees trucks by risk with duty and gate marks, p50/p90 and the SIMULATED label", async ({
  page,
}) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await signIn(page);
  const panel = page.getByTestId("safety-panel");
  await expect(panel.getByRole("heading", { name: "Keselamatan sopir" })).toBeVisible();
  await expect(panel.getByTestId("safety-classification")).toHaveText("SIMULASI");
  await expect(panel.getByTestId("safety-basis")).toContainText("Skenario simulasi");
  await expect(panel.getByTestId("safety-p50")).toHaveText("2 j 12 mnt");
  await expect(panel.getByTestId("safety-p90")).toHaveText("3 j 10 mnt");

  const rows = panel.getByTestId("safety-row");
  await expect(rows).toHaveCount(6); // collapsed: the riskiest six first
  await expect(rows.first()).toHaveAttribute("data-duty-state", "blocked");
  await expect(rows.nth(1)).toHaveAttribute("data-gate-state", "alert");
  // Duty bar carries the 10 h and 12 h marks; the gate bar the 3 h mark.
  await expect(rows.nth(1).getByTestId("safety-gauge-mark")).toHaveCount(3);
  await expect(rows.first().getByRole("meter", { name: "Jam tugas T-201" })).toHaveAttribute(
    "aria-valuenow",
    "745",
  );

  await panel.getByRole("button", { name: "Tampilkan semua 9 truk" }).click();
  await expect(rows).toHaveCount(9);
});

test("override needs a reason of 10+ characters and posts it for the blocked truck", async ({ page }) => {
  let posted = null;
  let overridden = false;
  await page.route("**/api/safety/overview", (route) =>
    route.fulfill({ json: overview({ overrideFor: overridden ? "T-201" : null }) }),
  );
  await page.route("**/api/safety/override", async (route) => {
    posted = route.request().postDataJSON();
    overridden = true;
    await route.fulfill({ status: 201, json: truck("T-201", 745, null) });
  });
  await signIn(page);
  const panel = page.getByTestId("safety-panel");
  await panel.getByTestId("safety-override-open").click();
  const dialog = page.getByTestId("safety-override-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Izinkan SPJ baru untuk T-201" })).toBeVisible();

  await dialog.getByTestId("safety-override-submit").click();
  await expect(dialog.getByRole("alert")).toHaveText("Tulis alasan minimal 10 karakter.");
  expect(posted).toBeNull();

  await dialog.getByTestId("safety-override-reason").fill("Sopir pengganti belum tiba");
  await dialog.getByTestId("safety-override-submit").click();
  await expect(dialog).toBeHidden();
  expect(posted).toEqual({ truck_code: "T-201", reason: "Sopir pengganti belum tiba" });
  await expect(panel.getByTestId("safety-override-note")).toContainText("Override oleh supervisor");
});

test("a role without spj:override sees no override action", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) =>
    route.fulfill({ json: overview({ canOverride: false }) }),
  );
  await signIn(page, { role: "dispatcher" });
  await expect(page.getByTestId("safety-row").first()).toBeVisible();
  await expect(page.getByTestId("safety-override-open")).toHaveCount(0);
});

test("English locale, 44 px targets and no horizontal overflow at 390 px", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, { lang: "en" });
  const panel = page.getByTestId("safety-panel");
  await expect(panel.getByRole("heading", { name: "Driver safety" })).toBeVisible();
  await expect(panel.getByTestId("safety-classification")).toHaveText("SIMULATED");
  await expect(panel.getByTestId("safety-p50")).toHaveText("2 h 12 min");
  await expect(panel.getByRole("button", { name: "Override for T-201" })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const small = [...document.querySelectorAll(".safety-panel button")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.width < 44 || r.height < 44));
    return { small: small.length, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.small).toBe(0);
  expect(geometry.overflow).toBeLessThanOrEqual(2);
});

test("fleet workspace safety chip opens the driver-safety tab", async ({ page }) => {
  await page.route("**/api/safety/overview", (route) => route.fulfill({ json: overview() }));
  await signIn(page, { role: "dispatcher", path: "/fleet" });
  const chip = page.getByTestId("problem-chip-safety");
  await expect(chip).toBeEnabled();
  await expect(chip).toContainText("2"); // one blocked without override + one gate alert
  await expect(chip).toContainText("SIMULASI");
  await chip.click();
  await expect(page.getByTestId("fleet-safety-surface").getByTestId("safety-panel")).toBeVisible();
});

test("live backend overview keeps one classification and a matching badge", async ({ page }) => {
  await signIn(page);
  const badge = page.getByTestId("safety-classification");
  await expect(badge).toBeVisible({ timeout: 20000 });
  const classification = await badge.getAttribute("data-classification");
  expect(["SIMULATED", "OBSERVED_APP_EVENTS"]).toContain(classification);
  await expect(badge).toHaveText(classification === "SIMULATED" ? "SIMULASI" : "EVENT APLIKASI");
});
