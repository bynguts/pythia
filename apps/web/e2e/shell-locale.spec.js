import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #15 / wave 13: the console shell follows the selected locale (sidebar, search, top
// bar, Ask Ana, profile menu), English is the default, and the language lives in the
// profile menu on desktop and on the phone's off-canvas sidebar.
async function signIn(page, { role = "dispatcher", lang } = {}) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      if (lang) localStorage.setItem("pythia_lang", lang);
      else localStorage.removeItem("pythia_lang");
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
  await page.goto("/app/settings");
}

async function assertShellCopy(page, mode) {
  const id = mode === "id";
  await expect(page.locator("html")).toHaveAttribute("lang", mode);
  await expect(page.getByTestId("workspace-navigation")).toHaveAccessibleName(
    id ? "Navigasi utama Pythia" : "Pythia main navigation",
  );
  await expect(page.getByTestId("nav-readiness")).toContainText(id ? "Kesiapan pagi" : "Morning readiness");
  await expect(page.getByTestId("console-search")).toHaveAttribute(
    "placeholder",
    id ? "Cari truk, SPJ, TPS" : "Search truck, work order, TPS",
  );
  await expect(page.getByTestId("ask-ana")).toHaveText(id ? "Tanya Ana" : "Ask Ana");
  await expect(page.getByTestId("supervisor-toggle")).toContainText(id ? "Mode pengawas" : "Supervisor mode");
  await expect(page.getByTestId("profile-role")).toHaveText(id ? "Pengatur armada" : "Dispatcher");
  await page.getByTestId("profile-button").click();
  await expect(page.getByTestId("profile-logout")).toHaveText(id ? "Keluar" : "Log out");
  await page.keyboard.press("Escape");
}

test("English is the default and the shell copy follows the profile-menu language switch", async ({
  page,
}) => {
  await signIn(page);
  await assertShellCopy(page, "en");

  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-lang-id").click();
  await assertShellCopy(page, "id");
  expect(await page.evaluate(() => localStorage.getItem("pythia_lang"))).toBe("id");

  await page.reload();
  await assertShellCopy(page, "id");

  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-lang-en").click();
  await assertShellCopy(page, "en");
});

test("the phone sidebar opens from the menu button without horizontal overflow", async ({ page }) => {
  await signIn(page, { lang: "en" });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/app/settings?from=test");
    await expect(page.getByTestId("workspace-navigation")).toBeHidden();
    await page.getByRole("button", { name: "Open the menu" }).click();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
    // Settings: the shell is under test here, not a screen lane's page.
    await page.getByTestId("nav-settings").click();
    await expect(page).toHaveURL(/\/app\/settings$/);
    await expect(page.getByTestId("workspace-navigation")).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test("Ask Ana opens a drawer that ?ana=1 keeps open and Escape closes", async ({ page }) => {
  await signIn(page, { lang: "en" });
  await page.getByTestId("ask-ana").click();
  const drawer = page.getByRole("dialog", { name: "Ana" });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/ana=1/);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/ana=1/);
  await expect(page.getByTestId("ask-ana")).toBeFocused();

  await page.goto("/app/settings?ana=1");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawer).toHaveCount(0);
});

test("supervisor mode is locked for a dispatcher and persists for a supervisor", async ({ page }) => {
  await signIn(page, { lang: "en" });
  const toggle = page.getByTestId("supervisor-toggle");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  // aria-disabled keeps the tooltip reachable, so the click lands and does nothing.
  await toggle.click({ force: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await signIn(page, { role: "supervisor", lang: "en" });
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("pythia_supervisor_mode"))).toBe("1");
  await page.reload();
  await expect(page.getByTestId("supervisor-toggle")).toHaveAttribute("aria-checked", "true");
});
