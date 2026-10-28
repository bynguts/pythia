// #driver-message: "Message dispatch" on the route opens a message sheet over the map (the
// phone's back button closes it, not the app); the message reaches Needs you, where a Reply
// goes to that driver only and handles it. The stop sheet folds so the map shows, and a tab
// change is a history step.
import { expect, test } from "@playwright/test";
import {
  API,
  apiLogin,
  authHeaders,
  cancelSpj,
  createActiveSpj,
  finishPretrip,
  openDriver,
} from "./lib/driverSpj.js";

const TRUCK = "T-206";
const STOP = { name: "TPS Pesan E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

test("a driver's message reaches Needs you and the reply handles it", async ({ page, request, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, TRUCK, [STOP]);
  try {
    await openDriver(page, request, { token, truck: TRUCK, lang: "en" });
    await finishPretrip(page);
    await page.getByTestId("driver-tab-rute").click();
    const arrive = page.getByTestId("stop-start");
    await expect(arrive).toBeVisible({ timeout: 20000 });

    // The sheet folds to its title so the map shows, and opens again.
    const grab = page.getByTestId("driver-sheet-toggle");
    await grab.click();
    await expect(grab).toHaveAttribute("aria-expanded", "false");
    await expect(arrive).toBeHidden();
    await grab.click();
    await expect(arrive).toBeVisible();

    // A tab change is a history step: back returns to the route, inside the app.
    await page.getByTestId("driver-tab-lapor").click();
    await expect(page.getByTestId("driver-exceptions")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/driver\?.*tab=rute/);
    await expect(arrive).toBeVisible();

    // Back closes the message sheet and stays on the route.
    await page.getByTestId("driver-message-dispatch").click();
    const sheet = page.getByTestId("exc-sheet");
    await expect(sheet).toContainText("Message dispatch");
    await expect(sheet.getByTestId("exc-send")).toBeDisabled();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/driver/);
    await expect(arrive).toBeVisible();

    const note = "Spare tyre not replaced yet, ok to continue? e2e";
    await page.getByTestId("driver-message-dispatch").click();
    await sheet.getByTestId("exc-note").fill(note);
    await sheet.getByTestId("exc-send").click();
    await expect(sheet).toBeHidden();
    const mine = await (
      await request.get(`${API}/driver/exceptions?truck_code=${TRUCK}`, { headers: authHeaders(token) })
    ).json();
    expect(mine.exceptions.filter((e) => e.kind === "driver_message").map((e) => e.note)).toContain(note);

    // Operations: the message is a Needs-you row; Reply previews, sends to that driver and handles it.
    await page.goto("/");
    await page.evaluate((tok) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_token", tok);
      localStorage.setItem("pythia_role", "dispatcher");
      localStorage.setItem("pythia_lang", "en");
    }, token);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/operations");
    const row = page
      .locator(`[data-testid="action-row"][data-kind="driver_message"]`)
      .filter({ hasText: note });
    await expect(row).toContainText(`Message from the driver of ${TRUCK}`, { timeout: 30000 });
    await row.getByTestId("needs-action-reply").click();
    const preview = row.getByTestId("needs-send-preview");
    await expect(preview.getByTestId("send-preview-text")).toContainText("Pesan diterima.");
    await preview.getByTestId("send-preview-send").click();
    await expect(page.getByTestId("needs-you-notice")).toHaveText(`Reply sent to ${TRUCK}. Marked handled.`);
    await expect(row).toHaveCount(0);
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});
