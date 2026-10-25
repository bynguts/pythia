// wave9 driver exceptions: a quick report from the driver app (GET/POST /api/driver/exceptions)
// surfaces in the command centre's "Perlu tindakan" rail as its own alert type, accident
// first and in danger tone, closes through the alert follow-up log, and shows in the drawer.
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
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
}

test("a driver's accident and road-closure reports reach the rail and the truck drawer", async ({ page }) => {
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
  const report = async (kind, note) => {
    const response = await page.request.post(`${API}/driver/exceptions`, {
      headers: driverHeaders,
      data: { kind, truck_code: truck, note, operation_id: `${key}-${kind}` },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  // The accident is filed first, so newest-first order alone would not put it on top.
  const accident = await report("accident", `${key} tabrakan ringan`);
  await report("road_closed", `${key} jalan ditutup`);

  try {
    await signIn(page, dispatcher);
    const rail = page.getByTestId("fleet-rail-action");
    const rows = rail.getByTestId("driver-exception-row").filter({ hasText: key });
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(rows.first()).toHaveAttribute("data-kind", "accident");
    await expect(rows.first()).toHaveClass(/is-danger/);
    await expect(rows.first()).toContainText("Kecelakaan");
    await expect(rows.first()).toContainText(truck);
    await expect(rows.nth(1)).toContainText("Jalan tertutup");
    await expect(rows.first().getByRole("button", { name: "Hubungi sopir" })).toBeVisible();

    const contrast = await new AxeBuilder({ page })
      .include("[data-testid=driver-exceptions]")
      .withRules(["color-contrast"])
      .analyze();
    expect(contrast.violations.map(({ nodes }) => nodes.map(({ target }) => target))).toEqual([]);

    // "Tandai ditangani" writes the existing follow-up log, so it survives a reload.
    const road = rows.filter({ hasText: "Jalan tertutup" });
    await road.getByRole("button", { name: "Tandai ditangani" }).click();
    await expect(road).toContainText("Ditangani");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByTestId("driver-exception-row").filter({ hasText: `${key} jalan ditutup` }),
    ).toContainText("Ditangani", { timeout: 30000 });

    // The truck drawer lists the same reports, read-only.
    await page.getByRole("tab", { name: "Truk", exact: true }).click();
    await page.getByPlaceholder("Cari kode, plat, sopir, wilayah").fill(truck);
    await page.locator(`[data-testid=truck-row][data-truck="${truck}"]`).click();
    const section = page.getByTestId("drawer-exceptions");
    await expect(section).toContainText("Kecelakaan");
    await expect(section).toContainText(`${key} jalan ditutup`);
  } finally {
    if (accident.damage_report_id)
      await page.request.post(`${API}/damage-reports/${accident.damage_report_id}/resolve`, {
        headers: operatorHeaders,
      });
  }
});
