import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #15: the application shell must follow the selected locale for navigation
// context, connectivity, logout, assistant, profile, and accessibility labels
// — on both desktop and mobile navigation.
async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
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
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function assertShellCopy(page, mode) {
  const id = mode === "id";
  // wave11 design system: the top bar replaced the sidebar. Brand, nav, the status chip
  // (scenario + city + server link), assistant, profile and the profile-menu logout.
  await expect(page.locator(".command-brand")).toHaveAccessibleName(
    id ? "Pythia, ke Armada" : "Pythia, go to Fleet",
  );
  await expect(page.getByTestId("workspace-navigation")).toHaveAccessibleName(
    id ? "Navigasi utama Pythia" : "Pythia main navigation",
  );
  // #honesty: the shell says the scenario is simulated, on every workspace.
  const status = page.getByTestId("shell-status");
  await expect(status).toContainText(id ? "Simulasi" : "Simulated");
  await expect(status).toContainText("DKI Jakarta");
  await expect(status).toHaveAttribute("title", id ? "Server terhubung" : "Server connected");
  await expect(page.locator(".command-assistant span")).toHaveText(
    id ? "Asisten operasi" : "Operations assistant",
  );
  // H12: the profile names the signed-in role (shared demo account), not a fixed "Operator".
  await expect(page.locator(".command-profile strong")).toHaveText(id ? "Pengatur armada" : "Dispatcher");
  await expect(page.locator(".command-profile small")).toHaveText(
    id ? "Akun demo bersama: dispatcher" : "Shared demo account: dispatcher",
  );
  await page.getByTestId("profile-button").click();
  await expect(page.getByTestId("profile-logout")).toHaveText(id ? "Keluar" : "Log out");
  await page.keyboard.press("Escape");
  await expect(page.locator(".command-language")).toHaveAccessibleName(
    id ? "Pilih bahasa" : "Select language",
  );
}

test("shell copy follows the locale in both language modes (desktop)", async ({ page }) => {
  await signIn(page, "id");
  await assertShellCopy(page, "id");

  await page.getByTestId("lang-switch-en").click();
  await assertShellCopy(page, "en");

  await page.getByTestId("lang-switch-id").click();
  await assertShellCopy(page, "id");
});

test("mobile navigation and active workspace description follow the locale", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "en");
  await expect(page.locator(".command-mobile-nav")).toHaveAccessibleName("Mobile workspace navigation");
  // wave9 fleet composition: Fleet is the first workspace again; the 3D city sits last.
  await expect(page.locator(".command-mobile-nav button").first()).toContainText("Fleet");

  // wave11 design system: the workspace description is the nav pill's tooltip now.
  const active = page.getByTestId("workspace-navigation").locator('[aria-current="page"]');
  await expect(active).toHaveAttribute("title", "Monitor and act on today's operations");

  await page.getByTestId("lang-switch-id").click();
  await expect(page.locator(".command-mobile-nav")).toHaveAccessibleName("Navigasi ruang kerja seluler");
  await expect(active).toHaveAttribute("title", "Pantau dan tangani operasi hari ini");
});

test("workspace descriptions localize for every navigation item", async ({ page }) => {
  await signIn(page, "en");
  for (const [name, description] of [
    ["Forecast", "Anticipate the next service load"],
    ["Planning", "Compose and approve operations plans"],
    ["Drivers", "Manage driver compliance and performance"],
    // wave9 settings: Settings replaced the audit workspace in the rail.
    ["Settings", "Integrations, team access and data sources"],
  ]) {
    const button = page.locator(".command-nav").getByRole("button", { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(button).toHaveAttribute("title", description);
  }
});
