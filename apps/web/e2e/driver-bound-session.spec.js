// #drv7-session: a personal driver account is bound to its truck by
// GET /api/driver/session, so /driver skips the truck picker, cannot switch
// trucks, names the account itself and drops the simulated-roster badge. The
// shared demo logins (no truck_code) keep the picker.
import { expect, test } from "@playwright/test";
import { apiLogin } from "./lib/driverSpj.js";

async function openWithSession(page, token, session) {
  if (session) await page.route("**/api/driver/session", (route) => route.fulfill({ json: session }));
  await page.goto("/");
  await page.evaluate((value) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
    }
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_field_token", value);
  }, token);
  await page.goto("/driver");
}

test("a truck-bound driver account opens straight on its own truck", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  await openWithSession(page, token, {
    username: "sopir-t238",
    role: "driver",
    truck_code: "T-238",
    display_name: "Sopir Uji",
    shared_account: false,
  });
  const app = page.getByTestId("driver-app");
  await expect(app).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".driver-brand small")).toHaveText("T-238");
  await expect(page.locator(".driver-identity h1")).toContainText("Sopir Uji");
  await expect(page.locator('[data-testid^="pick-"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ganti" })).toHaveCount(0);
  await expect(page.getByTestId("driver-identity-sim")).toHaveCount(0);
  // The session is cached so an offline start stays on the bound truck.
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("pythia_driver_session")));
  expect(cached.truck_code).toBe("T-238");
});

test("a shared demo login still picks its truck from the roster", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  await openWithSession(page, token, null);
  await expect(page.locator('[data-testid^="pick-"]').first()).toBeVisible({ timeout: 15000 });
});
