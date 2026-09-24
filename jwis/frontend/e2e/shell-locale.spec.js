import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

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
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function assertShellCopy(page, mode) {
  const id = mode === "id";
  // Sidebar: brand subtitle, workspaces label, connectivity, logout.
  await expect(page.locator(".command-brand small")).toHaveText(id ? "Pusat kendali DLH" : "DLH command center");
  await expect(page.locator(".command-nav-label")).toHaveText(id ? "Ruang kerja" : "Workspaces");
  await expect(page.locator(".system-connection strong")).toHaveText(id ? "Sistem terhubung" : "System connected");
  await expect(page.locator(".system-connection small")).toHaveText(id ? "Data diperbarui otomatis" : "Data refreshes automatically");
  await expect(page.locator(".command-logout span")).toHaveText(id ? "Keluar" : "Log out");
  // Topbar: context eyebrow, assistant, profile.
  await expect(page.locator(".command-eyebrow")).toHaveText(id ? "Operasi DKI Jakarta" : "Jakarta operations");
  await expect(page.locator(".command-assistant span")).toHaveText(id ? "Asisten operasi" : "Operations assistant");
  await expect(page.locator(".command-profile strong")).toHaveText(id ? "Tim JWIS" : "JWIS Team");
  await expect(page.locator(".command-profile small")).toHaveText(id ? "Operator DLH" : "DLH Operator");
  // Accessible labels.
  await expect(page.locator(".command-sidebar")).toHaveAccessibleName(id ? "Navigasi utama JWIS" : "JWIS main navigation");
  await expect(page.locator(".command-language")).toHaveAccessibleName(id ? "Pilih bahasa" : "Select language");
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
  await expect(page.locator(".command-mobile-nav button").first()).toContainText("Fleet");

  // Workspace description next to the title follows the locale too.
  await expect(page.locator(".command-title-row span")).toHaveText("Monitor and act on today's operations");

  await page.getByTestId("lang-switch-id").click();
  await expect(page.locator(".command-mobile-nav")).toHaveAccessibleName("Navigasi ruang kerja seluler");
  await expect(page.locator(".command-title-row span")).toHaveText("Pantau dan tangani operasi hari ini");
});

test("workspace descriptions localize for every navigation item", async ({ page }) => {
  await signIn(page, "en");
  for (const [name, description] of [
    ["Forecast", "Anticipate the next service load"],
    ["Planning", "Compose and approve operations plans"],
    ["Drivers", "Manage driver compliance and performance"],
    ["Data & ML Audit", "Audit data and model quality"],
  ]) {
    await page.locator(".command-nav").getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".command-title-row span")).toHaveText(description);
  }
});
