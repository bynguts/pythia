// #gap-ocr: the weighbridge-ticket OCR moved to the reviewer's side. A receipt shows its
// photo, the OCR reading as a "MODEL OUTPUT · belum dikonfirmasi" suggestion and the
// recorded weights; a dispatcher confirms ("Cocok") or corrects ("Koreksi") it, and a
// role without dispatch:create sees no buttons. The SPJ list and review calls are stubbed.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const SPJ_ID = "spj-ocr-e2e";
const SPJ_NUMBER = "DLH-DKI/SPJ/25-10-2026/000901";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function ocrBlock(overrides = {}) {
  return {
    gross_kg: 15200,
    tare_kg: null,
    net_kg: null,
    confidence: "high",
    source: "vision-ocr (stub)",
    classification: "MODEL_OUTPUT",
    label: "MODEL OUTPUT: weighbridge-ticket OCR suggestion, not a recorded weight",
    status: "unreviewed",
    reason: null,
    read_at: "2026-10-25T03:00:00+00:00",
    reviewed_by: null,
    reviewed_at: null,
    ...overrides,
  };
}

function spjWith(receipt) {
  return {
    spj_id: SPJ_ID,
    spj_number: SPJ_NUMBER,
    date: "2026-10-25",
    driver_name: "Pengemudi Sim 07",
    truck_code: "T-901",
    destination: "TPST Bantargebang",
    weigh_on_site: false,
    priority: "normal",
    note: "",
    status: "selesai",
    stops: [{ name: "TPS E2E 1", kecamatan: "Gambir", status: "completed", evidence_summary: null }],
    route_point_count: 2,
    receipt,
  };
}

const unreviewedReceipt = {
  photo_name: "struk.jpg",
  total_weight_kg: null,
  gross_weight_kg: null,
  tare_weight_kg: null,
  net_weight_kg: null,
  weight_source: "unspecified",
  submitted_by: "driver",
  recorded_at: "2026-10-25T02:59:00+00:00",
  has_photo: true,
  ocr: ocrBlock(),
};

async function stubSpj(page, state) {
  await page.route(
    (url) => url.pathname.endsWith("/api/spj"),
    (route) => route.fulfill({ json: { spj: [spjWith(state.receipt)], count: 1 } }),
  );
  await page.route(`**/api/spj/${SPJ_ID}/evidence-summary`, (route) =>
    route.fulfill({
      json: { spj_id: SPJ_ID, weigh_on_site: false, stops: [], receipt: state.receipt, complete: false },
    }),
  );
  await page.route(`**/api/spj/${SPJ_ID}/receipt/thumb`, (route) =>
    route.fulfill({ body: PNG, contentType: "image/png" }),
  );
  await page.route(`**/api/spj/${SPJ_ID}/receipt/review`, async (route) => {
    const body = route.request().postDataJSON();
    state.reviews.push(body);
    const confirm = body.action === "confirm";
    const gross = confirm ? state.receipt.ocr.gross_kg : body.gross_weight_kg;
    const tare = confirm ? state.receipt.tare_weight_kg : body.tare_weight_kg;
    state.receipt = {
      ...state.receipt,
      total_weight_kg: gross,
      gross_weight_kg: gross,
      tare_weight_kg: tare,
      net_weight_kg: tare == null ? null : gross - tare,
      weight_source: confirm ? "ocr_confirmed" : "reviewer_corrected",
      ocr: {
        ...state.receipt.ocr,
        status: confirm ? "confirmed" : "corrected",
        reviewed_by: state.role,
        reviewed_at: "2026-10-25T03:05:00+00:00",
      },
    };
    await route.fulfill({
      json: { status: state.receipt.ocr.status, spj_id: SPJ_ID, receipt: state.receipt },
    });
  });
}

async function openDetail(page, request, role) {
  const res = await request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(res.ok()).toBeTruthy();
  const principal = await res.json();
  await page.goto("/");
  await page.evaluate(({ token, role: signedIn }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", signedIn);
  }, principal);
  await page.goto("/app/work-orders", { waitUntil: "domcontentloaded" });
  await page.getByTestId("wo-tab-closed").click();
  await expect(page.getByTestId("spj-receipt-needs-review")).toHaveText("Struk perlu ditinjau");
  await page.getByTestId("wo-row").filter({ hasText: SPJ_NUMBER }).click();
  return page.getByTestId("wo-detail").getByTestId(`spj-receipt-review-${SPJ_ID}`);
}

async function expectTapTarget(locator) {
  const box = await locator.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test("a dispatcher confirms the OCR suggestion and the recorded gross follows it", async ({ page }) => {
  const state = { receipt: unreviewedReceipt, reviews: [], role: "dispatcher" };
  await stubSpj(page, state);
  const review = await openDetail(page, page.request, "dispatcher");

  await expect(review.getByTestId("spj-receipt-ocr-badge")).toHaveText("Bacaan model · belum dikonfirmasi");
  await expect(review.getByTestId("spj-receipt-ocr-suggestion")).toContainText("15.200 kg");
  // The OCR reading is not a recorded weight until someone confirms it.
  await expect(review.getByTestId("spj-receipt-recorded")).toContainText("Bruto belum dicatat");
  await expect(review.getByTestId("spj-receipt-photo").getByRole("img")).toHaveAttribute(
    "alt",
    "Foto struk timbang",
  );
  await expectTapTarget(review.getByTestId("spj-receipt-photo"));

  const confirm = review.getByRole("button", { name: "Cocok" });
  await expectTapTarget(confirm);
  await expectTapTarget(review.getByRole("button", { name: "Koreksi" }));
  await confirm.click();

  expect(state.reviews).toEqual([{ action: "confirm" }]);
  await expect(review.getByTestId("spj-receipt-ocr-badge")).toHaveText(
    "Bacaan OCR · dikonfirmasi oleh dispatcher",
  );
  await expect(review.getByTestId("spj-receipt-recorded")).toContainText("Bruto 15.200 kg");
  await expect(review.getByRole("button", { name: "Cocok" })).toHaveCount(0);
  await expect(page.getByTestId("spj-receipt-needs-review")).toHaveCount(0);
});

test("a supervisor corrects the weights from the ticket photo", async ({ page }) => {
  const state = { receipt: unreviewedReceipt, reviews: [], role: "supervisor" };
  await stubSpj(page, state);
  const review = await openDetail(page, page.request, "supervisor");

  await review.getByRole("button", { name: "Koreksi" }).click();
  const gross = review.getByTestId("spj-receipt-gross");
  await expect(gross).toHaveValue("15200"); // prefilled from the suggestion
  await expectTapTarget(gross);
  await gross.fill("15100");
  await review.getByTestId("spj-receipt-tare").fill("15200");
  await review.getByRole("button", { name: "Simpan koreksi" }).click();
  await expect(review.getByRole("alert")).toContainText("lebih kecil dari bruto");
  expect(state.reviews).toEqual([]);

  await review.getByTestId("spj-receipt-tare").fill("9100");
  await review.getByRole("button", { name: "Simpan koreksi" }).click();
  await expect(review.getByTestId("spj-receipt-ocr-badge")).toHaveText("Dikoreksi oleh supervisor");
  expect(state.reviews).toEqual([{ action: "correct", gross_weight_kg: 15100, tare_weight_kg: 9100 }]);
  await expect(review.getByTestId("spj-receipt-recorded")).toContainText("Bersih 6.000 kg");
});

test("a role without dispatch:create sees the suggestion but no review buttons", async ({ page }) => {
  const state = { receipt: unreviewedReceipt, reviews: [], role: "executive" };
  await stubSpj(page, state);
  const review = await openDetail(page, page.request, "executive");

  await expect(review.getByTestId("spj-receipt-ocr-badge")).toHaveText("Bacaan model · belum dikonfirmasi");
  await expect(review.getByRole("button", { name: "Cocok" })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Koreksi" })).toHaveCount(0);
  await expect(review).toContainText("Hanya dispatcher atau pengawas");
});

// Weights the driver typed are the driver's, not a MODEL OUTPUT, and the
// dispatcher is asked to check them against the photo rather than to type them again.
test("weights the driver typed read as entered by the driver, not as OCR output", async ({ page }) => {
  const driverTyped = {
    ...unreviewedReceipt,
    total_weight_kg: 14820,
    gross_weight_kg: 14820,
    tare_weight_kg: 8100,
    net_weight_kg: 6720,
    weight_source: "manual",
    ocr: ocrBlock({
      gross_kg: null,
      confidence: null,
      source: null,
      status: "unavailable",
      reason: "OCR engine not configured",
    }),
  };
  const state = { receipt: driverTyped, reviews: [], role: "dispatcher" };
  await stubSpj(page, state);
  const review = await openDetail(page, page.request, "dispatcher");

  const badge = review.getByTestId("spj-receipt-ocr-badge");
  await expect(badge).toHaveText("Diisi sopir · belum dikonfirmasi");
  await expect(badge).not.toContainText("MODEL OUTPUT");
  const hint = review.getByTestId("spj-receipt-ocr-suggestion");
  await expect(hint).toContainText("Cocokkan berat dari sopir");
  await expect(hint).not.toContainText("manual");
  await expect(review.getByTestId("spj-receipt-recorded")).toContainText("Bruto 14.820 kg");

  await review.getByRole("button", { name: "Koreksi" }).click();
  await expect(review.getByTestId("spj-receipt-gross")).toHaveValue("14820");
  await review.getByRole("button", { name: "Simpan koreksi" }).click();
  await expect(badge).toHaveText("Dikoreksi oleh dispatcher");
});
