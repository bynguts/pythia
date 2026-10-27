// gsc-2026 M1: the field gate (/driver, /field) and the command center keep separate sessions.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

const commandSession = () =>
  ["pythia_auth", "pythia_token", "pythia_role"].map((key) => localStorage.getItem(key));

test("a driver signing in on a second tab keeps the supervisor's command-center session", async ({
  page,
  context,
}) => {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "supervisor", password: "supervisor-demo-pass" },
  });
  expect(login.ok()).toBeTruthy();
  const supervisor = await login.json();
  await page.goto("/");
  await page.evaluate(({ token, role }) => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, supervisor);
  // "/" is the public landing; the console lives under /app.
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-navigation")).toBeVisible({ timeout: 20000 });

  // Second tab, same browser profile: the driver signs in through the field gate.
  const driverTab = await context.newPage();
  await driverTab.goto("/driver");
  await expect(driverTab.locator('input[autocomplete="username"]')).toHaveValue("driver");
  await driverTab.locator('input[autocomplete="current-password"]').fill("driver-demo-pass");
  await driverTab.getByRole("button", { name: "Sign in" }).click();
  await expect(driverTab.getByTestId("driver-app")).toBeVisible();

  expect(await page.evaluate(commandSession)).toEqual(["true", supervisor.token, "supervisor"]);
  const fieldToken = await driverTab.evaluate(() => localStorage.getItem("pythia_field_token"));
  expect(fieldToken).toBeTruthy();
  expect(fieldToken).not.toBe(supervisor.token);
  expect(await driverTab.evaluate(() => localStorage.getItem("pythia_field_role"))).toBe("driver");

  // The command center still acts as the supervisor after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-navigation")).toBeVisible({ timeout: 20000 });
  const session = await page.request.get(`${API}/auth/session`, {
    headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("pythia_token"))}` },
  });
  expect((await session.json()).role).toBe("supervisor");

  // Signing out of the command center leaves the driver's session (and its outbox) alone.
  // Log out lives in the profile menu (no sidebar footer).
  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-logout").click();
  expect(await page.evaluate(commandSession)).toEqual([null, null, null]);
  expect(await driverTab.evaluate(() => localStorage.getItem("pythia_field_token"))).toBe(fieldToken);
  await driverTab.reload({ waitUntil: "domcontentloaded" });
  await expect(driverTab.getByTestId("driver-app")).toBeVisible();
  await driverTab.close();
});

test("a role without field permissions is refused at the field gate", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", "en");
  });
  await page.goto("/field");
  await page.locator('input[autocomplete="username"]').fill("auditor");
  await page.locator('input[autocomplete="current-password"]').fill("auditor-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("login-notice")).toHaveText(
    "This account cannot act on field work. Sign in as a driver or field officer.",
  );
  expect(await page.evaluate(() => localStorage.getItem("pythia_field_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("pythia_auth"))).toBeNull();
});
