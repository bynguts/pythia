// #twin-table-handoff: "Put this on the table". The twin opens a QR dialog for a
// /xr link already joined to a shared XR session on the twin's city, day and
// scenario; an Ask Pythia what-if (and a day change) on the twin is written to the
// session, a second device opened on that link shows the same scenario, and the
// twin counts the devices on the table. The dialog is modal (focus stays inside,
// Esc closes), keeps the honesty note, lets the host be edited for a phone on the
// LAN, and fits a 390 px screen.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const QUESTION = "What if 120 mm of rain hits during the JIS concert tomorrow?";
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/;

async function signIn(page, lang = "en") {
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
      localStorage.removeItem("pythia_table_origin");
      sessionStorage.removeItem("pythia_table_session");
    },
    { ...principal, lang },
  );
}

async function waitForTwin(page, predicate = "true", timeout = 45000) {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout,
  });
}

async function session(page, code) {
  const res = await page.request.get(`${API}/xr/session/${code}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function openHandoff(page) {
  await page.getByTestId("twin-table-open").click();
  await expect(page.getByTestId("twin-handoff")).toBeVisible();
  await expect(page.getByTestId("twin-handoff-qr")).toBeVisible({ timeout: 15000 });
  const code = (await page.getByTestId("twin-handoff-code").textContent()).trim();
  const url = (await page.getByTestId("twin-handoff-url").textContent()).trim();
  return { code, url };
}

test("the twin puts its scenario on the table and every joined phone follows it", async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await expect(page.getByTestId("twin-table-open")).toHaveText("Put on the table");

  // The dialog: a QR (SVG) for a link that joins the session, plus the code and URL as text.
  const { code, url } = await openHandoff(page);
  const dialog = page.getByTestId("twin-handoff");
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  expect(url).toContain(`/xr?session=${code}`);
  expect(url).toContain("city=jakarta");
  const qrPath = await page.getByTestId("twin-handoff-qr").locator("path").getAttribute("d");
  expect(qrPath).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  await expect(page.getByTestId("twin-handoff-honesty")).toContainText("not live field data");
  // A localhost link cannot work on a phone, and the dialog says so.
  if (LOCAL_HOST.test(new URL(url).hostname)) {
    await expect(page.getByTestId("twin-handoff-local-hint")).toBeVisible();
  }

  // The session already holds the twin's scenario (no what-if yet).
  expect(await session(page, code)).toMatchObject({
    city: "jakarta",
    rainfall_mm: 0,
    event_preset: "none",
    day: 0,
    classification: "SESSION_STATE",
  });

  // Modal: Tab never leaves the dialog; Esc closes it and focus returns to the trigger.
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest("[data-testid=twin-handoff]"))),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("twin-table-open")).toBeFocused();
  await expect(page.getByTestId("twin-table-presence")).toHaveText("No device on the table yet");

  // An Ask Pythia what-if on the twin is written to the session.
  await page.getByTestId("twin-ask-input").fill(QUESTION);
  await page.getByTestId("twin-ask-send").click();
  await expect(page.getByTestId("twin-ask-applied")).toBeVisible({ timeout: 60000 });
  await expect
    .poll(async () => session(page, code), { timeout: 15000 })
    .toMatchObject({
      city: "jakarta",
      rainfall_mm: 120,
      event_preset: "50k",
      venue_id: "jis",
      day: 1,
      scenario_day: 1,
    });

  // A second device opened on the dialog's URL shows the same scenario.
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(url);
  await phone.waitForFunction(() => window.__pythiaXr && window.__pythiaXr.ready, null, { timeout: 45000 });
  await expect
    .poll(
      () =>
        phone.evaluate(() => {
          const xr = window.__pythiaXr;
          return {
            code: xr.sessionCode,
            rain: xr.rainfall_mm,
            event: xr.eventPreset,
            venue: xr.venueId,
            day: xr.selectedDay,
            scenarioDay: xr.scenarioDay,
          };
        }),
      { timeout: 15000 },
    )
    .toEqual({ code, rain: 120, event: "50k", venue: "jis", day: 1, scenarioDay: 1 });
  // The table re-forecasts that scenario (same model output as the twin).
  await expect
    .poll(() => phone.evaluate(() => window.__pythiaXr.sceneRainfall), { timeout: 20000 })
    .toBe(120);

  // The twin counts the phone on the table.
  await expect(page.getByTestId("twin-table-presence")).toHaveText("1 device on the table", {
    timeout: 15000,
  });
  await expect(page.getByTestId("twin-table-presence")).toHaveAttribute("data-count", "1");

  // A later twin change (the selected day) reaches the phone too.
  await page.getByTestId("twin-day-3").click();
  await expect.poll(() => phone.evaluate(() => window.__pythiaXr.selectedDay), { timeout: 15000 }).toBe(3);

  // The host is editable for a phone on the LAN, remembered on this device.
  await openHandoff(page);
  await expect(page.getByTestId("twin-handoff-presence")).toHaveText("1 device on the table");
  await page.getByTestId("twin-handoff-origin").fill("http://192.168.1.20:5175");
  await expect(page.getByTestId("twin-handoff-url")).toHaveText(
    `http://192.168.1.20:5175/xr?session=${code}&city=jakarta&lang=en`,
  );
  await expect(page.getByTestId("twin-handoff-local-hint")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("pythia_table_origin"))).toBe(
    "http://192.168.1.20:5175",
  );

  // Stop sharing: the twin no longer leads a table.
  await page.getByTestId("twin-handoff-stop").click();
  await expect(page.getByTestId("twin-handoff")).toHaveCount(0);
  await expect(page.getByTestId("twin-table-open")).toHaveText("Put on the table");
  await phone.close();
});

test("the handoff dialog fits a 390 px phone, in Indonesian, with no axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "id");
  await page.goto("/twin");
  await waitForTwin(page);
  await expect(page.getByTestId("twin-table-open")).toHaveText("Taruh di meja");
  await openHandoff(page);
  await expect(page.getByRole("dialog", { name: "Taruh kota ini di meja" })).toBeVisible();
  await expect(page.getByTestId("twin-handoff-presence")).toHaveText("Belum ada perangkat di meja");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByTestId("twin-handoff").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  for (const id of ["twin-handoff-close", "twin-handoff-stop", "twin-handoff-origin"]) {
    const target = await page.getByTestId(id).boundingBox();
    expect(target.height, id).toBeGreaterThanOrEqual(44);
  }
  const closeBox = await page.getByTestId("twin-handoff-close").boundingBox();
  expect(closeBox.width).toBeGreaterThanOrEqual(44);

  const results = await new AxeBuilder({ page }).include("[data-testid=twin-handoff]").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByTestId("twin-handoff-stop").click();
});
