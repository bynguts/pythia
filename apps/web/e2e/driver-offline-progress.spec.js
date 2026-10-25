// #drv6-offline: audit gap 9 (D9) and R3. A stop queued offline counts as
// done locally so the next stop unlocks; the SPJ, the queue and the sync
// status survive a reload with the backend unreachable and a 16 h old queue;
// a 409 replay is listed under "Perlu tindakan", never counted as synced.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  API,
  apiLogin,
  authHeaders,
  cancelSpj,
  completeCurrentStop,
  createActiveSpj,
  driverNameFor,
  finishPretrip,
  openDriver,
  PHOTO,
} from "./lib/driverSpj.js";

const STOPS = [
  { name: "TPS Luring A", kecamatan: "Cilandak", address: "Jl. A", lat: -6.29, lng: 106.79 },
  { name: "TPS Luring B", kecamatan: "Cilandak", address: "Jl. B", lat: -6.291, lng: 106.792 },
];

async function serverStop(request, token, spjId, index) {
  const detail = await (await request.get(`${API}/spj/${spjId}`, { headers: authHeaders(token) })).json();
  return detail.stops[index];
}

test("a stop queued offline unlocks the next stop and survives a reload without the backend", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-243", STOPS);
  try {
    await openDriver(page, request, { token, truck: "T-243" });
    await finishPretrip(page);
    await expect(page.getByTestId("driver-last-sync")).toHaveText(/^Terakhir sinkron \d\d:\d\d$/);

    await context.setOffline(true);
    await completeCurrentStop(page, 0);
    // Stop 1 is done on this phone; stop 2 is now the current stop.
    await expect(page.getByTestId("stop-0")).toContainText("DI HP");
    await expect(page.getByTestId("stop-0").getByTestId("stop-queued-note")).toBeVisible();
    await expect(page.getByTestId("stop-1").getByTestId("stop-start")).toBeEnabled();
    await expect(page.getByTestId("driver-pending-count")).toHaveText("1 menunggu kirim");

    // Reload with the backend unreachable (no service worker under automation).
    // Block the API before going back online: the "online" event flushes the queue at once.
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId("stop-0")).toContainText("DI HP");
    await expect(page.getByTestId("stop-1").getByTestId("stop-start")).toBeEnabled();
    await expect(page.getByTestId("driver-pending-count")).toHaveText("1 menunggu kirim");
    await expect(page.getByTestId("driver-last-sync")).toHaveText(/^Terakhir sinkron \d\d:\d\d$/);
    expect((await serverStop(request, token, spj.spj_id, 0)).status).not.toBe("completed");

    // Backend back: the queue drains in order and the server records stop 1.
    await page.unroute("**/api/**");
    await expect(async () => {
      expect((await serverStop(request, token, spj.spj_id, 0)).status).toBe("completed");
    }).toPass({ timeout: 30000 });
    await expect(page.getByTestId("driver-pending-count")).toHaveText("Semua terkirim", { timeout: 15000 });
    await expect(page.getByTestId("driver-needs-action")).toHaveCount(0);
  } finally {
    await page.unroute("**/api/**").catch(() => {});
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a 409 replay is listed under Perlu tindakan with its reason and is never marked synced", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-244", [STOPS[0]]);
  try {
    await openDriver(page, request, { token, truck: "T-244" });
    await finishPretrip(page);
    await context.setOffline(true);
    await completeCurrentStop(page, 0);
    await expect(page.getByTestId("driver-pending-count")).toHaveText("1 menunggu kirim");

    // The dispatcher cancels the SPJ while the phone is offline.
    await cancelSpj(request, token, spj.spj_id);
    await context.setOffline(false);

    const needs = page.getByTestId("driver-needs-action");
    await expect(needs).toBeVisible({ timeout: 30000 });
    await expect(needs).toContainText("Perlu tindakan");
    await expect(needs.getByTestId("driver-rejected-item")).toContainText("Ditolak (409)");
    await expect(page.getByTestId("driver-pending-count")).toHaveText("Semua terkirim");
    await expect(page.getByText(/Tersinkron: \d+ aksi/)).toHaveCount(0);
    expect((await serverStop(request, token, spj.spj_id, 0)).status).not.toBe("completed");

    // The list survives a reload until the driver dismisses it.
    await page.reload();
    await expect(page.getByTestId("driver-rejected-item")).toHaveCount(1);
    await page.getByTestId("driver-needs-action").getByRole("button", { name: "Tutup" }).click();
    await expect(page.getByTestId("driver-needs-action")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a 16 h old queue and last-sync time survive a reload and still sync", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-245", [STOPS[0]]);
  const photo = `data:image/png;base64,${readFileSync(PHOTO).toString("base64")}`;
  const sixteenHoursAgo = new Date(Date.now() - 16 * 3600 * 1000);
  const driverName = await driverNameFor(request, "T-245");
  try {
    await page.goto("/");
    // HH:MM in the browser's own time zone.
    const hhmm = await page.evaluate((iso) => {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }, sixteenHoursAgo.toISOString());
    await page.evaluate(
      ({ token, spj, photo, at, driverName }) => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
        }
        localStorage.setItem("pythia_lang", "id");
        localStorage.setItem("pythia_field_token", token);
        localStorage.setItem(
          "pythia_driver",
          JSON.stringify({ driver_name: driverName, truck_code: "T-245" }),
        );
        localStorage.setItem("pythia_driver_last_sync", at);
        localStorage.setItem("pythia_driver_spj_T-245", JSON.stringify({ aktif: spj, selesai: [] }));
        const evidence = {
          arrival: { photo_name: "a.png", photo_b64: photo, lat: -6.29, lng: 106.79, approx: true },
          weighing: [],
          officer: { name: "Petugas Shift", photo_name: "o.png", photo_b64: photo },
        };
        localStorage.setItem(
          "pythia_driver_outbox",
          JSON.stringify([
            {
              op_id: "e2e-long-shift-op",
              path: `/spj/${spj.spj_id}/stops/0/complete`,
              data: { evidence },
              label: "Titik 1",
              fingerprint: "e2e-long-shift",
              queued_at: at,
              attempts: 40,
            },
          ]),
        );
      },
      { token, spj, photo, at: sixteenHoursAgo.toISOString(), driverName },
    );
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.goto("/driver");
    await expect(page.getByTestId("driver-last-sync")).toHaveText(`Terakhir sinkron ${hhmm}`);
    await expect(page.getByTestId("driver-pending-count")).toHaveText("1 menunggu kirim");
    await expect(page.getByTestId("stop-0")).toContainText("DI HP");

    await page.unroute("**/api/**");
    await expect(async () => {
      expect((await serverStop(request, token, spj.spj_id, 0)).status).toBe("completed");
    }).toPass({ timeout: 30000 });
    await expect(page.getByTestId("driver-last-sync")).not.toHaveText(`Terakhir sinkron ${hhmm}`);
  } finally {
    await page.unroute("**/api/**").catch(() => {});
    await cancelSpj(request, token, spj.spj_id);
  }
});
