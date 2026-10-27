// Driver exceptions: a quick report from the driver app (POST /api/driver/exceptions)
// Surfaces in the Operations "Needs you" panel (GET /api/ops/needs-you) as its own
// item, accident first as urgent, and closes through the alert follow-up log.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function login(request, username) {
  const response = await request.post(`${API}/auth/login`, {
    data: { username, password: `${username}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function signIn(page, principal) {
  await page.goto("/");
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
}

test("a driver's accident and road-closure reports reach the needs-you panel and close there", async ({
  page,
}) => {
  test.setTimeout(120000);
  const dispatcher = await login(page.request, "dispatcher");
  const driver = await login(page.request, "driver");
  const operatorHeaders = { Authorization: `Bearer ${dispatcher.token}` };
  const driverHeaders = { Authorization: `Bearer ${driver.token}` };

  // A truck the other fleet specs do not lean on: the last one in the simulated fleet.
  const snapshot = await (
    await page.request.get(`${API}/command-center`, { headers: operatorHeaders })
  ).json();
  const truck = snapshot.trucks[snapshot.trucks.length - 1].truck_code;
  const key = `e2e-${Date.now()}`;
  // The operation key stays in operation_id; the note is the driver's words, and the panel
  // must never print an internal id (rows are found by data-item-id).
  const report = async (kind, note) => {
    const response = await page.request.post(`${API}/driver/exceptions`, {
      headers: driverHeaders,
      data: { kind, truck_code: truck, note, operation_id: `${key}-${kind}` },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  // The accident is filed first, so newest-first order alone would not put it on top.
  const accident = await report("accident", "tabrakan ringan di simpang");
  const road = await report("road_closed", "jalan ditutup untuk perbaikan");
  const ids = [accident.exception_id, road.exception_id];
  expect(ids.every(Boolean)).toBe(true);
  const rowOf = (id) => `[data-testid=action-row][data-item-id="driver-exception:${id}"]`;

  try {
    await signIn(page, dispatcher);
    const panel = page.getByTestId("needs-you");
    const rows = panel.locator(ids.map(rowOf).join(", "));
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(rows.first()).toHaveAttribute("data-kind", "accident");
    await expect(rows.first()).toHaveAttribute("data-severity", "urgent");
    await expect(rows.first()).toHaveAttribute("data-provenance", "field");
    await expect(rows.first()).toContainText(`Kecelakaan · ${truck}`);
    await expect(rows.nth(1)).toContainText(`Jalan ditutup · ${truck}`);
    // The sub line is the driver's note; no operation key or exception id is printed.
    await expect(rows.first()).toContainText("tabrakan ringan di simpang");
    await expect(rows.nth(1)).toContainText("jalan ditutup untuk perbaikan");
    const panelText = await panel.innerText();
    expect(panelText).not.toContain(key);
    for (const id of ids) expect(panelText).not.toContain(id);
    await expect(rows.first().getByTestId("needs-action-escalate")).toHaveText("Eskalasi");

    const contrast = await new AxeBuilder({ page })
      .include("[data-testid=needs-you]")
      .withRules(["color-contrast"])
      .analyze();
    expect(contrast.violations.map(({ nodes }) => nodes.map(({ target }) => target))).toEqual([]);

    // "Tandai ditangani" writes the existing follow-up log, so the closure survives a reload.
    const roadRow = page.locator(rowOf(road.exception_id));
    await roadRow.getByTestId("needs-action-mark_handled").click();
    await expect(roadRow).toHaveCount(0, { timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(rowOf(accident.exception_id))).toBeVisible({ timeout: 30000 });
    await expect(page.locator(rowOf(road.exception_id))).toHaveCount(0);
  } finally {
    await page.request.post(`${API}/alert/follow-up`, {
      headers: operatorHeaders,
      data: { alert_id: `driver-exception:${accident.exception_id}`, status: "RESOLVED", note: "e2e" },
    });
    if (accident.damage_report_id)
      await page.request.post(`${API}/damage-reports/${accident.damage_report_id}/resolve`, {
        headers: operatorHeaders,
      });
  }
});
