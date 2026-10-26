// #w15-ocr: the vision model reads the whole weighbridge ticket. Its gross and
// tare pre-fill the weigh sheet, the ticket number and plate show as a model
// reading to check, and a photo that is not a ticket asks for a retake.
// The OCR endpoint is stubbed; the receipt goes to the real backend.
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
} from "./lib/driverSpj.js";

const STOP = { name: "TPS OCR E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

function stubOcr(page, reading) {
  return page.route("**/api/ocr/timbangan", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ raw_text: "", source: "vision (stub)", ...reading }),
    }),
  );
}

async function photographTicket(page, request, token, truck) {
  await openDriver(page, request, { token, truck });
  await finishPretrip(page);
  await completeCurrentStop(page, 0);
  await page.getByTestId("driver-tab-tpa").click();
  const delivery = page.getByTestId("delivery-card");
  await expect(delivery).toBeVisible({ timeout: 15000 });
  await delivery.getByTestId("gate-arrival").click();
  await delivery.getByTestId("receipt-input").setInputFiles(PHOTO);
  return page.getByTestId("weigh-ticket");
}

test("the ticket read by the model pre-fills gross and tare and is recorded as OCR", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-258", [STOP]);
  try {
    await stubOcr(page, {
      document: "weighbridge_ticket",
      weight_kg: 12450,
      gross_kg: 12450,
      tare_kg: 8200,
      net_kg: 4250,
      ticket_no: "TB-000123",
      plate: "B 1234 XYZ",
      confidence: "high",
    });
    const ticket = await photographTicket(page, request, token, "T-258");
    await expect(ticket.getByTestId("weigh-ocr-value")).toContainText("12.450", { timeout: 15000 });
    await expect(ticket.getByTestId("receipt-tare")).toHaveValue("8200");
    const read = ticket.getByTestId("weigh-ticket-read");
    await expect(read).toContainText("TB-000123");
    await expect(read).toContainText("B 1234 XYZ");

    await ticket.getByTestId("weigh-correct").click();
    await expect(page.getByTestId("receipt-weights")).toBeVisible({ timeout: 15000 });
    const detail = await (
      await request.get(`${API}/spj/${spj.spj_id}`, { headers: authHeaders(token) })
    ).json();
    expect(detail.receipt.gross_weight_kg).toBe(12450);
    expect(detail.receipt.tare_weight_kg).toBe(8200);
    expect(detail.receipt.weight_source).toBe("ocr");
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a photo that is not a weighbridge ticket asks the driver to retake it", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-259", [STOP]);
  try {
    await stubOcr(page, {
      document: "not_a_ticket",
      weight_kg: null,
      gross_kg: null,
      tare_kg: null,
      net_kg: null,
      ticket_no: null,
      plate: null,
      confidence: "low",
    });
    const ticket = await photographTicket(page, request, token, "T-259");
    await expect(ticket.getByTestId("weigh-not-ticket")).toBeVisible({ timeout: 15000 });
    await expect(ticket.getByTestId("weigh-ocr-none")).toHaveCount(0);
    await expect(ticket.getByTestId("weigh-ticket-read")).toHaveCount(0);
    // The manual path stays open.
    await expect(ticket.getByTestId("receipt-gross")).toBeVisible();
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});
