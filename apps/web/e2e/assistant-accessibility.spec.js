import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

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
  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("ask-ana")).toBeVisible();
}

test("Ana drawer keeps keyboard focus inside and restores it after dismissal", async ({ page }) => {
  await signIn(page);
  const trigger = page.getByTestId("ask-ana");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ana" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Tanya apa saja ke Ana" })).toBeFocused();
  await expect(page.locator("#root")).toHaveJSProperty("inert", true);

  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator("#root")).toHaveJSProperty("inert", false);

  await trigger.click();
  await page.getByRole("dialog", { name: "Ana" }).getByRole("button", { name: "Tutup" }).click();
  await expect(trigger).toBeFocused();
});

test("mobile Ana trigger keeps an accessible name in both languages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "id");
  await expect(page.getByTestId("ask-ana")).toHaveAccessibleName("Tanya Ana");
  await signIn(page, "en");
  const trigger = page.getByTestId("ask-ana");
  await expect(trigger).toHaveAccessibleName("Ask Ana");
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Ana" })).toBeVisible();
});

test("signed-in operator can query the protected assistant endpoint", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/assistant/query", async (route) => {
    const authorized = route.request().headers().authorization?.startsWith("Bearer ");
    await route.fulfill({
      status: authorized ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        authorized
          ? {
              provider: "local",
              answer: "Data armada Pythia: 1 truk mengalami deviasi rute.",
              tools_used: ["get_fleet_status"],
            }
          : { detail: "Missing bearer token" },
      ),
    });
  });
  await page.getByTestId("ask-ana").click();
  const dialog = page.getByRole("dialog", { name: "Ana" });
  await dialog
    .getByRole("textbox", { name: "Tanya apa saja ke Ana" })
    .fill("Berapa truk yang mengalami deviasi rute?");
  await dialog.getByRole("button", { name: "Kirim pesan" }).click();
  await expect(dialog.getByText("Data armada Pythia: 1 truk mengalami deviasi rute.")).toBeVisible();
  // The answer names the tool it ran.
  await expect(dialog.getByTestId("assistant-used")).toContainText("Status armada");
});
