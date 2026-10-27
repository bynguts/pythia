import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// #79: every visible and assistive sign-in string follows ID/EN through one
// catalog; the selected locale is available before authentication and persists after login.
const GATE = "/app";

test("sign-in surface follows the selected locale end to end", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("pythia_lang", lang), "en");
  await page.goto(GATE);

  await expect(page.getByRole("heading", { name: "Sign in to Pythia" })).toBeVisible();
  await expect(page.getByTestId("login-proof-list")).toContainText("Every figure traceable to its source");
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("e.g. dispatcher")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the driver app" })).toBeVisible();

  // Switch to ID on the sign-in surface itself.
  await page.getByTestId("login-lang-switch").click();
  await expect(page.getByRole("heading", { name: "Masuk ke Pythia" })).toBeVisible();
  await expect(page.getByLabel("Nama pengguna")).toBeVisible();
  await expect(page.getByLabel("Kata sandi", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tampilkan kata sandi" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Buka aplikasi sopir" })).toBeVisible();

  // The ID choice must survive authentication into the shell.
  await page.getByLabel("Nama pengguna").fill("dispatcher");
  await page.getByLabel("Kata sandi", { exact: true }).fill("dispatcher-demo-pass");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/operations/);
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
});

test("invalid credentials error follows the locale", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("pythia_lang", lang), "en");
  await page.goto(GATE);
  await page.getByLabel("Username").fill("nope");
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid username or password.");

  await page.getByTestId("login-lang-switch").click();
  await page.getByLabel("Nama pengguna").fill("nope");
  await page.getByLabel("Kata sandi", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Nama pengguna atau kata sandi tidak valid.");
});

// gsc phone login: only a 401 means wrong credentials. A dropped connection or a proxy 502
// (backend down) must say the server was not reached, so a driver on a weak
// signal does not retype a correct password; phone keyboards must not
// capitalise or autocorrect what is typed.
test("unreachable server is not reported as a wrong password", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("pythia_lang", lang), "en");
  await page.goto(GATE);
  for (const input of ['input[autocomplete="username"]', 'input[autocomplete="current-password"]']) {
    await expect(page.locator(input)).toHaveAttribute("autocapitalize", "none");
    await expect(page.locator(input)).toHaveAttribute("autocorrect", "off");
  }
  await page.getByLabel("Username").fill("dispatcher");
  await page.getByLabel("Password", { exact: true }).fill("dispatcher-demo-pass");

  await page.route("**/api/auth/login", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Can't reach the Pythia server. Check the connection and try again.",
  );

  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 502, body: "Bad Gateway" }));
  await page.getByTestId("login-lang-switch").click();
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Server Pythia tidak terjangkau. Periksa koneksi lalu coba lagi.",
  );
});

test("sign-in text meets contrast and has no overflow on a phone", async ({ page }) => {
  await page.addInitScript((lang) => localStorage.setItem("pythia_lang", lang), "en");
  await page.goto(GATE);
  await expect(page.getByRole("heading", { name: "Sign in to Pythia" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  expect(results.violations.map(({ nodes }) => nodes.map(({ target }) => target))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("main")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByRole("button", { name: "Show password" })).toBeVisible();
});
