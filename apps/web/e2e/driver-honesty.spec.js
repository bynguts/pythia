// #drv6-honesty: H1 and H3 in /driver. An arrival geotag without a GPS fix is
// shown and sent as approximate ("Lokasi perkiraan, bukan GPS"), never as
// GPS; the simulated roster stays machine-readable (data-provenance="simulated"
// plus a title) on the picker and on the driver's name, as wave 13's thin labels.
import { expect, test } from "@playwright/test";
import { apiLogin, cancelSpj, createActiveSpj, finishPretrip, openDriver, PHOTO } from "./lib/driverSpj.js";

const STOP = { name: "TPS Jujur E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

test("without a GPS fix the arrival geotag is labelled approximate and sent as approx", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-252", [STOP]);
  await context.clearPermissions();
  try {
    await openDriver(page, request, { token, truck: "T-252" });
    await finishPretrip(page);
    await page.getByTestId("driver-tab-rute").click();
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();
    await card.getByTestId("arrival-input").setInputFiles(PHOTO);
    const geotag = card.getByTestId("arrival-geotag");
    await expect(geotag).toHaveAttribute("data-geotag", "approx", { timeout: 20000 });
    await expect(geotag).toHaveText("Lokasi perkiraan, bukan GPS");

    await card.getByTestId("officer-input").setInputFiles(PHOTO);
    await card.getByTestId("officer-name").fill("Petugas Jujur");
    const posted = page.waitForRequest((r) => r.url().includes(`/spj/${spj.spj_id}/stops/0/complete`));
    await card.getByTestId("stop-finish").click();
    const arrival = (await posted).postDataJSON().evidence.arrival;
    expect(arrival.approx).toBe(true);
    expect(arrival.accuracy_m).toBeUndefined();
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("with a GPS fix the geotag shows GPS and its accuracy", async ({ page, context, request }) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-253", [STOP]);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -6.2901, longitude: 106.7902, accuracy: 12 });
  try {
    await openDriver(page, request, { token, truck: "T-253" });
    await finishPretrip(page);
    await page.getByTestId("driver-tab-rute").click();
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();
    await card.getByTestId("arrival-input").setInputFiles(PHOTO);
    const geotag = card.getByTestId("arrival-geotag");
    await expect(geotag).toHaveAttribute("data-geotag", "gps", { timeout: 20000 });
    // Wave 13 (rq5U9): the line reads "Lokasi terlampir"; the accuracy is its title.
    await expect(geotag).toHaveText("Lokasi terlampir");
    await expect(geotag).toHaveAttribute("title", "Lokasi GPS ±12 m");
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("the driver picker and the greeting mark the roster as simulated", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  await page.route("**/api/dispatch/T-254", (route) =>
    route.fulfill({
      json: [
        {
          id: "honesty-e2e-1",
          truck_code: "T-254",
          instruction: "Uji kejujuran e2e",
          manager_id: "dispatcher",
          field_status: "PENDING",
          created_at: new Date().toISOString(),
        },
      ],
    }),
  );
  await page.goto("/");
  await page.evaluate((token) => {
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_field_token", token);
    localStorage.removeItem("pythia_driver");
  }, token);
  await page.goto("/driver");
  const roster = page.getByRole("list", { name: "Truk" });
  await expect(roster).toHaveAttribute("data-provenance", "simulated");
  await expect(roster).toHaveAttribute("title", "Armada simulasi: nama truk dan sopir bukan data personel.");
  await expect(page.getByTestId("driver-roster-sim")).toHaveText(
    "Armada simulasi: nama truk dan sopir bukan data personel.",
  );
  await page.getByTestId("driver-truck-search").fill("T-254");
  await page.getByTestId("pick-T-254").getByRole("button").click();
  await page.getByTestId("driver-pick-start").click();
  const identity = page.getByTestId("driver-identity");
  await expect(identity).toBeVisible({ timeout: 20000 });
  await expect(identity).toHaveAttribute("data-provenance", "simulated");
  await expect(page.getByText("SIMULASI", { exact: true })).toHaveCount(0);
});
