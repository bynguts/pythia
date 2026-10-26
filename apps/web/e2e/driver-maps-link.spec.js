// #drv6-maps: audit gap 5 (D5). In-cab navigation: every open stop and the
// destination have a "Buka rute di Google Maps" link with the coordinates.
// Wave 13: the links live in the route screen's "Semua titik" sheet.
import { expect, test } from "@playwright/test";
import { apiLogin, cancelSpj, createActiveSpj, openDriver } from "./lib/driverSpj.js";

const STOPS = [
  { name: "TPS Peta A", kecamatan: "Cilandak", address: "Jl. A", lat: -6.29, lng: 106.79 },
  { name: "TPS Peta B", kecamatan: "Pesanggrahan", address: "Jl. B", lat: -6.2501, lng: 106.7602 },
];

test("each stop and the destination open driving directions in Google Maps", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-250", STOPS);
  try {
    await openDriver(page, request, { token, truck: "T-250" });
    await page.getByTestId("driver-tab-rute").click();
    await page.getByTestId("driver-all-stops").click({ timeout: 20000 });
    const first = page.getByTestId("stop-maps-0");
    await expect(first).toBeVisible({ timeout: 20000 });
    await expect(first).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=-6.29,106.79&travelmode=driving",
    );
    await expect(first).toHaveAttribute("target", "_blank");
    await expect(first).toHaveAccessibleName("Buka rute ke TPS Peta A di Google Maps");
    await expect(page.getByTestId("stop-maps-1")).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=-6.2501,106.7602&travelmode=driving",
    );

    // Bantargebang has a verified OSM coordinate in the facility registry.
    const destination = page.getByTestId("destination-maps");
    await expect(page.getByTestId("destination-card")).toContainText("Tujuan: TPST Bantargebang");
    await expect(destination).toHaveAttribute(
      "href",
      /destination=-6\.3495367,106\.9981295&travelmode=driving$/,
    );

    const box = await first.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});
