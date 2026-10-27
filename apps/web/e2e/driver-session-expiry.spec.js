// #drv6-session: item 9. When the backend restarts and forgets the field
// session, the next driver write turns the app into "Masuk lagi"
// (design D2vpX "Signed out"): no raw English server detail, the password signs in
// again in place, and the deep link stays.
import { expect, test } from "@playwright/test";
import { API, apiLogin, authHeaders, openDriver } from "./lib/driverSpj.js";

test("an expired session is reported in Indonesian and leads back to the sign-in", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const res = await request.post(`${API}/dispatch`, {
    headers: authHeaders(token),
    data: { truck_code: "T-249", instruction: `Uji sesi berakhir ${Date.now()}`, manager_id: "dispatcher" },
  });
  const dispatch = await res.json();

  await openDriver(page, request, { token, truck: "T-249" });
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toBeVisible({ timeout: 20000 });

  // Simulate a backend restart: the stored token is no longer known.
  await page.evaluate(() => localStorage.setItem("pythia_field_token", "token-from-before-restart"));
  await item.getByTestId("driver-instruction-ready").click();

  const expired = page.getByTestId("driver-session-expired");
  await expect(expired).toBeVisible();
  await expect(expired.getByRole("heading", { name: "Masuk lagi" })).toBeVisible();
  await expect(expired).toContainText("Sesi Anda berakhir");
  await expect(page.getByText(/invalid|expired token|not authenticated/i)).toHaveCount(0);

  await expired.getByLabel("Kata sandi").fill("dispatcher-demo-pass");
  await expired.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(expired).toHaveCount(0);
  await expect(page.getByTestId("driver-tab-instruksi")).toBeVisible();
  await expect(page).toHaveURL(/\/driver/);
  expect(await page.evaluate(() => localStorage.getItem("pythia_field_token"))).not.toBe(
    "token-from-before-restart",
  );
});
