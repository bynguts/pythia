// #drv6-dispatch: audit gap 2 (D2). Dispatcher instructions and approved-plan
// assignments reach /driver: the card polls /dispatch/{truck}, renders the
// backend text as it arrives, and "Siap" is one tap (queued when offline).
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

test("a dispatcher instruction shows on /driver and one tap on Siap confirms it", async ({
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
  await expect(item).toContainText("Perintah dispatcher");
  await expect(item).toContainText(/Diterima \d\d:\d\d/);

  await item.getByTestId("driver-instruction-ready").click();
  await expect(item).toHaveCount(0);
  await expect.poll(() => dispatchStatus(request, token, dispatch.id)).toBe("READY");
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

test("Siap tapped offline queues the confirmation and syncs it on reconnect", async ({
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
});
