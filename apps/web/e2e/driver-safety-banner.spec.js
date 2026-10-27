// #drv6-safety: R5/R6 in /driver. The banner polls GET /api/safety/driver/{truck}
// (contract owned by the safety agent; stubbed here): 10 h warns, 12 h holds
// new SPJ work unless a supervisor override exists, a gate wait over 3 h says
// the supervisor was told. The classification label lives in a tooltip; a 404 or
// an error hides the notices. The notices live behind the shield
// toggle on the route map (an orange dot marks the toggle when one is up).
import { expect, test } from "@playwright/test";
import {
  apiLogin,
  cancelSpj,
  completeCurrentStop,
  createActiveSpj,
  finishPretrip,
  openDriver,
} from "./lib/driverSpj.js";

const TRUCK = "T-251";
const STOP = { name: "TPS Aman E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

// Each reload closes the pop-over; open it again to read the notices.
async function openSafety(page) {
  const toggle = page.getByTestId("driver-safety-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return page.getByTestId("driver-route-safety");
}

function payload(over) {
  return {
    truck_code: TRUCK,
    shift_started_at: "2026-10-25T00:00:00+00:00",
    duty_minutes: 300,
    duty_state: "ok",
    warn_at_minutes: 600,
    block_at_minutes: 720,
    override: null,
    gate_wait_minutes: null,
    gate_state: null,
    gate_alert_at_minutes: 180,
    classification: "SIMULATED",
    label: "SIMULASI",
    ...over,
  };
}

test("the safety banner follows the duty and gate states and holds new work at the cap", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, TRUCK, [STOP]);
  let response = { status: 404, json: { detail: "Not Found" } };
  await page.route(`**/api/safety/driver/${TRUCK}`, (route) =>
    route.fulfill({ status: response.status, json: response.json }),
  );
  try {
    // 404 (endpoint not shipped yet): no banner, the stop can start.
    await openDriver(page, request, { token, truck: TRUCK });
    const start = page.getByTestId("stop-0").getByTestId("stop-start");
    await expect(start).toBeEnabled({ timeout: 20000 });
    await expect(page.getByTestId("driver-safety-toggle")).not.toHaveClass(/is-alert/);
    await expect(await openSafety(page)).toHaveText("Tidak ada peringatan jam kerja atau gerbang saat ini.");

    response = { status: 200, json: payload({ duty_minutes: 610, duty_state: "warn" }) };
    await page.reload();
    await expect(page.getByTestId("driver-safety-toggle")).toHaveClass(/is-alert/);
    await openSafety(page);
    await expect(page.getByTestId("driver-safety-warn")).toHaveText("Jam kerja 10 jam: istirahat segera");
    const label = page.getByTestId("driver-safety-label");
    await expect(label).toHaveAttribute("data-provenance", "simulated");
    await expect(label).toHaveAttribute("title", /^Skenario contoh:/);
    await expect(label).toHaveText("");
    await expect(start).toBeEnabled();

    response = { status: 200, json: payload({ duty_minutes: 725, duty_state: "blocked" }) };
    await page.reload();
    await openSafety(page);
    await expect(page.getByTestId("driver-safety-blocked")).toContainText(
      "Batas 12 jam: surat jalan baru butuh izin pengawas",
    );
    await expect(start).toBeDisabled();
    await expect(page.getByTestId("stop-held")).toBeVisible();

    response = {
      status: 200,
      json: payload({
        duty_minutes: 725,
        duty_state: "blocked",
        override: {
          by: "supervisor",
          reason: "Rute pendek, sopir cadangan tiba",
          at: "2026-10-25T12:00:00Z",
        },
      }),
    };
    await page.reload();
    await openSafety(page);
    await expect(page.getByTestId("driver-safety-override")).toHaveText("Izin pengawas: supervisor");
    await expect(start).toBeEnabled();

    response = {
      status: 200,
      json: payload({
        gate_wait_minutes: 190,
        gate_state: "alert",
        classification: "OBSERVED_APP_EVENTS",
        label: "Dari kejadian aplikasi",
      }),
    };
    await page.reload();
    await openSafety(page);
    await expect(page.getByTestId("driver-safety-gate")).toHaveText(
      "Antre > 3 jam: pengawas sudah diberi tahu",
    );
    // The long English backend label becomes a tooltip in the driver's language (no on-screen badge).
    const observed = page.getByTestId("driver-safety-label");
    await expect(observed).toHaveAttribute("data-provenance", "observed");
    await expect(observed).toHaveAttribute("title", /^Event aplikasi teramati/);

    response = { status: 500, json: { detail: "boom" } };
    await page.reload();
    await expect(start).toBeEnabled({ timeout: 20000 });
    await expect(page.getByTestId("driver-safety-toggle")).not.toHaveClass(/is-alert/);
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("one tap reports the gate arrival with the device time, starting the gate-wait clock", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-232", [STOP]);
  try {
    await openDriver(page, request, { token, truck: "T-232" });
    await finishPretrip(page);
    await completeCurrentStop(page, 0);
    await page.getByTestId("driver-tab-tpa").click();
    const delivery = page.getByTestId("delivery-card");
    await expect(delivery).toBeVisible({ timeout: 15000 });

    const posted = page.waitForResponse((r) => r.url().includes("/safety/gate-arrival"));
    await delivery.getByTestId("gate-arrival").click();
    const response = await posted;
    expect(response.status()).toBe(201);
    const body = response.request().postDataJSON();
    expect(body.spj_id).toBe(spj.spj_id);
    expect(Number.isNaN(Date.parse(body.arrived_at))).toBe(false);
    await expect(delivery.getByTestId("gate-arrived")).toHaveText(/^Di gerbang sejak \d\d:\d\d$/);
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});
