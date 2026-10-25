// wave10 session: tokens live in the backend's memory, so a restart invalidates every
// stored command-center session. The app must send the operator back to the
// login (keeping the deep link) instead of leaving every panel empty on 401s.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

const commandSession = () =>
  ["pythia_auth", "pythia_token", "pythia_role"].map((key) => localStorage.getItem(key));

async function storeSession(page, token) {
  await page.goto("/");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_token", value);
    localStorage.setItem("pythia_role", "dispatcher");
  }, token);
}

test("a token the backend no longer knows opens the login with a notice and keeps the deep link", async ({
  page,
}) => {
  await storeSession(page, "token-from-before-a-restart");
  await page.goto("/forecast");

  await expect(page.getByTestId("login-notice")).toHaveText(
    "Sesi berakhir karena server dimulai ulang. Silakan masuk lagi.",
  );
  expect(await page.evaluate(commandSession)).toEqual([null, null, null]);

  await page.locator('input[autocomplete="username"]').fill("dispatcher");
  await page.locator('input[autocomplete="current-password"]').fill("dispatcher-demo-pass");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByTestId("workspace-navigation")).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(page.getByTestId("login-notice")).toHaveCount(0);
});

test("a restart while the tab is in the background signs out when the operator comes back", async ({
  page,
}) => {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  await storeSession(page, (await login.json()).token);
  await page.goto("/fleet");
  await expect(page.getByTestId("workspace-navigation")).toBeVisible({ timeout: 20000 });

  // The backend forgets the token (restart) while the phone screen is off.
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 401, json: { detail: "Invalid or expired token." } }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.getByTestId("login-notice")).toBeVisible();
  expect(await page.evaluate(commandSession)).toEqual([null, null, null]);
});

test("an unreachable server does not sign the operator out", async ({ page }) => {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const { token } = await login.json();
  await page.route("**/api/auth/session", (route) => route.abort("internetdisconnected"));
  await storeSession(page, token);
  await page.goto("/fleet");

  await expect(page.getByTestId("workspace-navigation")).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("login-notice")).toHaveCount(0);
  expect(await page.evaluate(commandSession)).toEqual(["true", token, "dispatcher"]);
});
