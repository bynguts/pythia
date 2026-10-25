// wave12 gate slots: the TPA queue tab lists per-truck gate-slot holds from
// GET /api/gate/slots (SIMULATED), each with one "Terapkan" that sends the hold to the
// driver; without an approved plan it says there is nothing to balance yet.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
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

test("a gate-slot hold is applied with one tap and then reads as sent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The overloaded slot is stubbed: a real one depends on the day's approved plans.
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) =>
    route.fulfill({
      json: {
        date: "2026-10-27",
        slot_minutes: 15,
        capacity_per_slot: 30,
        slots: [],
        recommendations: [REC],
        classification: "SIMULATED",
        reason: null,
      },
    }),
  );
  let accepted = 0;
  await page.route(`**/api/gate/slots/recommendations/${REC.id}/accept`, (route) => {
    accepted += 1;
    return route.fulfill({
      json: { rec_id: REC.id, dispatch_id: "d-e2e", truck_code: "T-031", new_slot: "08:15" },
    });
  });
  await signIn(page);
  await page.getByRole("tab", { name: /Antrean TPA/ }).click();

  const recs = page.getByTestId("gate-slot-recs");
  await expect(recs).toBeVisible({ timeout: 30000 });
  await expect(recs.getByTestId("prov")).toHaveText("SIMULASI");
  const row = recs.getByTestId("gate-slot-rec");
  await expect(row).toContainText("T-031: tahan keberangkatan 15 mnt, slot gerbang 08:00 → 08:15");
  await row.getByTestId("gate-slot-accept").click();
  await expect(row.getByTestId("gate-slot-accepted")).toHaveText("Terkirim ke sopir sebagai instruksi");
  await expect(row.getByTestId("gate-slot-accept")).toHaveCount(0);
  expect(accepted).toBe(1);
});

test("the gate-slot list follows the real API, empty or not", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token } = await signIn(page);
  const board = await (
    await page.request.get(`${API}/gate/slots`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(board.classification).toBe("SIMULATED");

  await page.getByRole("tab", { name: /Antrean TPA/ }).click();
  const recs = page.getByTestId("gate-slot-recs");
  await expect(recs).toBeVisible({ timeout: 30000 });
  if (board.recommendations.length === 0) {
    await expect(recs.getByTestId("gate-slot-empty")).toBeVisible();
  } else {
    await expect(recs.getByTestId("gate-slot-rec")).toHaveCount(board.recommendations.length);
  }
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
  await page.getByRole("tab", { name: /Antrean TPA/ }).click();
  await expect(page.getByTestId("gate-slot-empty")).toHaveText(
    "Slot 09:00, 09:15 sudah penuh oleh kedatangan di luar rencana; menahan hingga 60 mnt tidak memperpendek antre model.",
    { timeout: 30000 },
  );
});
