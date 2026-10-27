// Behaviour: every WhatsApp message is one language. A dispatcher picks that language in
// Settings → WhatsApp (stored on the server, default Indonesian); the readiness reminder
// is then written fully in it, whatever language the console shows.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, role, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
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
  return principal.token;
}

async function setLanguage(request, token, lang) {
  const res = await request.post(`${API}/whatsapp/language`, {
    data: { lang },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
}

test("a dispatcher switches the WhatsApp message language in Settings", async ({ page }) => {
  const token = await signIn(page, "dispatcher", "en");
  await setLanguage(page.request, token, "id");
  try {
    // The gateway itself is not under test: never let a write reach it.
    for (const path of ["**/whatsapp/logout", "**/whatsapp/test", "**/whatsapp/gateway/start"]) {
      await page.route(path, (route) => route.abort());
    }
    await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
    const indonesian = page.getByTestId("settings-wa-lang-id");
    const english = page.getByTestId("settings-wa-lang-en");
    await expect(page.getByRole("heading", { name: "Message language" })).toBeVisible();
    await expect(indonesian).toHaveAttribute("aria-pressed", "true");

    const saved = page.waitForRequest((r) => r.url().endsWith("/whatsapp/language") && r.method() === "POST");
    await english.click();
    expect((await saved).postDataJSON()).toEqual({ lang: "en" });
    await expect(page.getByTestId("settings-wa-notice")).toHaveText(
      "Message language saved. The next WhatsApp message uses it.",
    );
    await expect(english).toHaveAttribute("aria-pressed", "true");
    const stored = await page.request.get(`${API}/whatsapp/language`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await stored.json()).lang).toBe("en");
  } finally {
    await setLanguage(page.request, token, "id");
  }
});

test("the supervisor sees the message language but cannot change it", async ({ page }) => {
  await signIn(page, "supervisor", "id");
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-lang")).toHaveText("Indonesia");
  await expect(page.getByTestId("settings-wa-lang-en")).toHaveCount(0);
});
