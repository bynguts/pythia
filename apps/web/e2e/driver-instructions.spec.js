// #drv6-dispatch: audit gap 2 (D2). Dispatcher instructions and approved-plan
// assignments reach /driver: the card polls /dispatch/{truck}, renders the
// backend text as it arrives, and "Terima instruksi" is one tap (queued when
// offline). A plan with a gate slot leads with its departure time.
import { expect, test } from "@playwright/test";
import { API, apiLogin, authHeaders, openDriver } from "./lib/driverSpj.js";

async function sendInstruction(request, token, truck, instruction) {
  const res = await request.post(`${API}/dispatch`, {
    headers: authHeaders(token),
    data: { truck_code: truck, instruction, manager_id: "dispatcher" },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function dispatchStatus(request, token, id) {
  const res = await request.get(`${API}/dispatch/${id}/status`, { headers: authHeaders(token) });
  return (await res.json()).field_status;
}

test("a dispatcher instruction shows on /driver and one tap on Terima instruksi confirms it", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const text = `Kirim rute: lewat Jl. TB Simatupang (uji e2e ${Date.now()})`;
  const dispatch = await sendInstruction(request, token, "T-246", text);

  await openDriver(page, request, { token, truck: "T-246" });
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toBeVisible({ timeout: 20000 });
  await expect(item).toContainText(text);
  await expect(item).toContainText("Pesan dari dispatcher");
  await expect(item).toContainText(/Baru \d\d:\d\d/);

  await item.getByTestId("driver-instruction-ready").click();
  await expect(item).toHaveCount(0);
  await expect.poll(() => dispatchStatus(request, token, dispatch.id)).toBe("READY");
  // The screen says the instruction was accepted and the tab badge drops
  // at once, not "Belum ada instruksi" beside a badge of 1 until the next poll.
  await expect(page.getByTestId("driver-instructions-empty-title")).toHaveText(
    /^Instruksi diterima \d\d:\d\d$/,
  );
  await expect(page.getByTestId("driver-tab-instruksi-count")).toHaveCount(0, { timeout: 3000 });
});

test("an approved-plan assignment is labelled as a plan and renders the backend text as is", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  await page.route("**/api/dispatch/T-247", (route) =>
    route.fulfill({
      json: [
        {
          id: "plan-e2e-1",
          truck_code: "T-247",
          instruction: "Angkut 18 t di Kebayoran Lama (rencana e2e)",
          manager_id: "operations_optimizer",
          field_status: "PENDING",
          created_at: "2026-10-25T01:30:00+00:00",
        },
      ],
    }),
  );
  await openDriver(page, request, { token, truck: "T-247" });
  const item = page.getByTestId("driver-instruction-plan-e2e-1");
  await expect(item).toBeVisible({ timeout: 20000 });
  await expect(item).toContainText("Rencana disetujui");
  await expect(item).toContainText("Angkut 18 t di Kebayoran Lama (rencana e2e)");
});

test("an instruction accepted offline queues the confirmation and syncs it on reconnect", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const dispatch = await sendInstruction(request, token, "T-248", `Instruksi luring (uji e2e ${Date.now()})`);
  await openDriver(page, request, { token, truck: "T-248" });
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toBeVisible({ timeout: 20000 });

  await context.setOffline(true);
  await item.getByTestId("driver-instruction-ready").click();
  await expect(item).toHaveCount(0);
  await expect(page.getByTestId("driver-pending-count")).toHaveText("1 menunggu kirim");
  expect(await dispatchStatus(request, token, dispatch.id)).toBe("PENDING");

  await context.setOffline(false);
  await expect.poll(() => dispatchStatus(request, token, dispatch.id), { timeout: 30000 }).toBe("READY");
  // Once synced the screen is live again, never "could not load" beside "Synced".
  const title = page.getByTestId("driver-instructions-empty-title");
  await expect(title).toHaveText(/^Instruksi diterima \d\d:\d\d$/);
  await expect(page.getByTestId("driver-instructions-cached")).toHaveCount(0, { timeout: 10000 });
  await expect(title).not.toContainText("gagal dimuat");
});

test("a plan instruction leads with the departure time and tags the modelled gate slot", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const created = new Date().toISOString();
  await page.route("**/api/dispatch/T-245", (route) =>
    route.fulfill({
      json: [
        {
          id: "plan-e2e-slot",
          truck_code: "T-245",
          instruction:
            "Rencana e2e\nBerangkat 05:30 · Slot gerbang TPST Bantargebang 10:00–10:15 (keluaran model)",
          manager_id: "operations_optimizer",
          field_status: "PENDING",
          created_at: created,
        },
      ],
    }),
  );
  await page.route("**/api/operations/instructions/T-245*", (route) =>
    route.fulfill({
      json: [
        {
          dispatch_id: "plan-e2e-slot",
          plan_id: "P-E2E",
          truck_code: "T-245",
          stops: [
            {
              order: 1,
              area: "kalideres",
              kecamatan: "Kalideres",
              window: "06:00–09:00",
              facility: "TPST Bantargebang",
              facility_display: "TPA Bantargebang",
              tons: 8,
            },
          ],
          gate_slot: { facility: "TPST Bantargebang", start: "10:00", end: "10:15", depart_at: "05:30" },
          reason: { areas: [{ kecamatan: "Kalideres", forecast_tons: 41 }] },
        },
      ],
    }),
  );
  await openDriver(page, request, { token, truck: "T-245", lang: "en" });
  // T-245 may still owe a receipt from another spec, which opens the app on TPA.
  await page.getByTestId("driver-tab-instruksi").click();
  const item = page.getByTestId("driver-instruction-plan-e2e-slot");
  await expect(item).toBeVisible({ timeout: 20000 });
  await expect(item.getByTestId("driver-instruction-depart")).toContainText("Leave the depot at");
  await expect(item.getByTestId("driver-instruction-depart")).toContainText("05:30");
  await expect(item.getByTestId("driver-instruction-depart")).toContainText(
    "Gate slot at TPA Bantargebang · 10:00–10:15",
  );
  // Founder decision 2026-10-27: no Model badge; the planned time keeps its provenance.
  await expect(item.getByTestId("driver-instruction-depart")).toHaveAttribute("data-provenance", "model");
  await expect(item.getByText("Model", { exact: true })).toHaveCount(0);
  await expect(item).toContainText("Kalideres district");
  await expect(item).toContainText("Trip plan · 1 trip");
  // Problems go back with a reason instead of an acceptance.
  await item.getByTestId("driver-instruction-cant").click();
  await expect(item.getByTestId("driver-instruction-reason")).toBeVisible();
});

// The real /operations/instructions shape nests the trips under `fields`;
// tomorrow's plan says so and renders in the UI language, never as the Indonesian text.
test("tomorrow's approved plan reads as tomorrow's instruction, in English, from the real backend", async ({
  page,
  request,
}) => {
  const dispatcher = await apiLogin(request);
  const supervisor = await apiLogin(request, "supervisor");
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  const tomorrow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const created = await request.post(`${API}/operations/plan?top_n=1&plan_date=${tomorrow}`, {
    headers: authHeaders(dispatcher.token),
  });
  expect(created.ok()).toBeTruthy();
  const plan = await created.json();
  const approved = await request.post(`${API}/operations/${plan.plan_id}/approve`, {
    headers: authHeaders(supervisor.token),
  });
  expect(approved.ok()).toBeTruthy();
  const { dispatch_ids: ids } = await approved.json();
  const first = plan.dispatches[0];

  await openDriver(page, request, { token: dispatcher.token, truck: first.truck_code, lang: "en" });
  await page.getByTestId("driver-tab-instruksi").click();
  const item = page.getByTestId(`driver-instruction-${ids[0]}`);
  await expect(item).toBeVisible({ timeout: 20000 });
  await expect(item.getByTestId("driver-instruction-day")).toHaveText("Tomorrow's instruction");
  await expect(item).toContainText(`${first.fields.stops[0].kecamatan} district`);
  await expect(item).toContainText("Forecast for");
  await expect(item).not.toContainText("angkut");
  await expect(item).not.toContainText("Alasan");
});
