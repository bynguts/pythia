// wave13 TPA gate (/app/gate): the board and its recommendation come from GET /api/gate/slots
// (SIMULATED). "Accept and send" sends each hold to its driver; without an approved plan the card
// says there is nothing to balance yet.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, language }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", language);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
      localStorage.removeItem("pythia_gate_dismissed");
    },
    { ...principal, language: lang },
  );
  await page.goto("/app/gate", { waitUntil: "domcontentloaded" });
  return principal;
}

const REC = {
  id: "rec-2026-10-27-T-031-2",
  truck_code: "T-031",
  action: "hold",
  hold_minutes: 15,
  from_slot: "08:00",
  to_slot: "08:15",
  expected_wait_reduction_min: 12.5,
  reason: "slot over capacity",
  accepted: false,
  dispatch_id: null,
};

const slot = (start, wait, trucks = []) => ({
  start,
  end: start,
  background_load: 10,
  queue_carried_in: 0,
  planned_trucks: trucks,
  expected_wait_min: wait,
});

test("a gate-slot hold is sent with one tap and then reads as sent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = { accepted: false };
  // The overloaded slot is stubbed: a real one depends on the day's approved plans.
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) =>
    route.fulfill({
      json: {
        date: "2026-10-27",
        slot_minutes: 15,
        capacity_per_slot: 30,
        slots: [slot("08:00", 38, ["T-031"]), slot("08:15", 21)],
        recommendations: [{ ...REC, accepted: state.accepted }],
        impact: {
          peak_wait_before: 38,
          peak_wait_after: 21,
          longest_wait_before: 38,
          longest_wait_after: 21,
        },
        classification: "SIMULATED",
        reason: null,
      },
    }),
  );
  let accepted = 0;
  await page.route(`**/api/gate/slots/recommendations/${REC.id}/accept`, (route) => {
    accepted += 1;
    state.accepted = true;
    return route.fulfill({
      json: { rec_id: REC.id, dispatch_id: "d-e2e", truck_code: "T-031", new_slot: "08:15" },
    });
  });
  await signIn(page);

  const recs = page.getByTestId("gate-slot-recs");
  await expect(recs).toBeVisible({ timeout: 30000 });
  await expect(recs).toContainText("T-031");
  await expect(recs.getByTestId("gate-impact")).toContainText("38 mnt");
  await expect(page.getByTestId("gate-wait-chart")).toBeVisible();
  await recs.getByTestId("gate-slot-accept").click();
  await expect(recs.getByTestId("gate-slot-accepted")).toHaveText("Terkirim ke sopir sebagai instruksi");
  await expect(recs.getByTestId("gate-slot-accept")).toHaveCount(0);
  expect(accepted).toBe(1);
});

test("a dismissed recommendation stays hidden after a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) =>
    route.fulfill({
      json: {
        date: "2026-10-27",
        slot_minutes: 15,
        capacity_per_slot: 30,
        slots: [slot("08:00", 38, ["T-031"])],
        recommendations: [REC],
        classification: "SIMULATED",
        reason: null,
      },
    }),
  );
  await signIn(page);
  await expect(page.getByTestId("gate-slot-rec")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("gate-slot-dismiss").click();
  await expect(page.getByTestId("gate-slot-rec")).toHaveCount(0);
  await expect(page.getByTestId("gate-slot-empty")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("gate-slot-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("gate-slot-rec")).toHaveCount(0);
});

test("the gate board follows the real API, empty or not", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token } = await signIn(page);
  const board = await (
    await page.request.get(`${API}/gate/slots`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(board.classification).toBe("SIMULATED");

  const recs = page.getByTestId("gate-slot-recs");
  await expect(recs).toBeVisible({ timeout: 30000 });
  if (board.recommendations.length === 0) {
    await expect(recs.getByTestId("gate-slot-empty")).toBeVisible();
  } else {
    await expect(recs.getByTestId("gate-slot-rec")).toBeVisible();
  }
  if (board.slots.length === 0) await expect(page.getByTestId("gate-no-board")).toBeVisible();
  else await expect(page.getByTestId("gate-wait-chart")).toBeVisible();
});

test("a saturated day says no hold helps instead of claiming a short wait", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) =>
    route.fulfill({
      json: {
        date: "2026-10-27",
        slots: [],
        recommendations: [],
        classification: "SIMULATED",
        reason: "saturated",
        saturated: true,
        saturated_slots: ["09:00", "09:15"],
      },
    }),
  );
  await signIn(page);
  await expect(page.getByTestId("gate-slot-empty")).toHaveText(
    "Slot 09:00, 09:15 sudah penuh oleh kedatangan di luar rencana; menahan hingga 60 mnt tidak memperpendek antre model.",
    { timeout: 30000 },
  );
});
