// #drv7-receipt / weigh ticket: at the gate the driver photographs the
// ticket; with no OCR engine (e2e) the gross and tare are typed from the paper.
// The shift summary shows gross, tare and net exactly as the server recorded
// them (H10), an invalid tare blocks sending, and a ticket queued offline says
// its weights are pending until it syncs, then shows them.
import { expect, test } from "@playwright/test";
import {
  API,
  apiLogin,
  authHeaders,
  cancelSpj,
  completeCurrentStop,
  createActiveSpj,
  finishPretrip,
  openDriver,
  PHOTO,
  sendReceipt,
} from "./lib/driverSpj.js";

const STOP = { name: "TPS Struk E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

async function openDelivery(page, request, token, truck) {
  await openDriver(page, request, { token, truck });
  await finishPretrip(page);
  await completeCurrentStop(page, 0);
  await page.getByTestId("driver-tab-tpa").click();
  const delivery = page.getByTestId("delivery-card");
  await expect(delivery).toBeVisible({ timeout: 15000 });
  return delivery;
}

test("gross and tare on the ticket give a server-computed net on the done screen", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-235", [STOP]);
  try {
    await openDelivery(page, request, token, "T-235");
    await sendReceipt(page, { gross: "12450", tare: "8200" });

    const weights = page.getByTestId("receipt-weights");
    await expect(weights).toBeVisible({ timeout: 15000 });
    await expect(weights.getByTestId("receipt-weight-gross")).toContainText("12.450 kg");
    await expect(weights.getByTestId("receipt-weight-tare")).toContainText("8.200 kg");
    await expect(weights.getByTestId("receipt-weight-net")).toContainText("4.250 kg");

    const detail = await (
      await request.get(`${API}/spj/${spj.spj_id}`, { headers: authHeaders(token) })
    ).json();
    expect(detail.receipt.gross_weight_kg).toBe(12450);
    expect(detail.receipt.tare_weight_kg).toBe(8200);
    expect(detail.receipt.net_weight_kg).toBe(4250);
    expect(detail.receipt.weight_source).toBe("manual");
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a tare at or above the gross weight blocks sending the ticket", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-236", [STOP]);
  try {
    const delivery = await openDelivery(page, request, token, "T-236");
    await delivery.getByTestId("gate-arrival").click();
    await delivery.getByTestId("receipt-input").setInputFiles(PHOTO);
    const ticket = page.getByTestId("weigh-ticket");
    await ticket.getByLabel("Berat bruto (kg)").fill("8000");
    await ticket.getByLabel("Truk kosong (tara)").fill("8000");
    await expect(ticket.getByTestId("receipt-weight-error")).toBeVisible();
    await expect(ticket.getByTestId("receipt-send")).toBeDisabled();

    // A valid tare unblocks it again.
    await ticket.getByLabel("Truk kosong (tara)").fill("7000");
    await expect(ticket.getByTestId("receipt-weight-error")).toHaveCount(0);
    await expect(ticket.getByTestId("receipt-send")).toBeEnabled();
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a receipt photographed offline is queued and its weights show as pending", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-237", [STOP]);
  try {
    const delivery = await openDelivery(page, request, token, "T-237");
    await delivery.getByTestId("gate-arrival").click();
    await expect(delivery.getByTestId("gate-arrived")).toBeVisible();
    await context.setOffline(true);
    await delivery.getByTestId("receipt-input").setInputFiles(PHOTO);
    const ticket = page.getByTestId("weigh-ticket");
    await ticket.getByLabel("Berat bruto (kg)").fill("12450");
    await ticket.getByTestId("receipt-send").click();
    await expect(page.getByTestId("receipt-weights-pending")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("driver-queued-count")).toBeVisible();
    // The queued receipt photo sits in IndexedDB, not in the localStorage index.
    const raw = await page.evaluate(() => localStorage.getItem("pythia_driver_outbox"));
    expect(raw).toContain("/receipt");
    expect(raw).toContain('"$photo"');
    expect(raw).not.toContain("data:image");

    // Back online: the outbox (10 s retry) sends the receipt, and the done
    // screen swaps the pending note for the weights the server stored.
    await context.setOffline(false);
    await expect(page.getByTestId("driver-queued-count")).toHaveCount(0, { timeout: 25000 });
    await expect(page.getByTestId("receipt-weights")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("receipt-weight-gross")).toContainText("12.450 kg");
    await expect(page.getByTestId("receipt-weights-pending")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await cancelSpj(request, token, spj.spj_id);
  }
});
