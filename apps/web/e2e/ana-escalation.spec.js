// Ana drafts, the operator decides. A draft from /assistant/query
// (`proposed_actions`) shows as a card with its recipient, channels and full text; Edit changes
// the text, Send posts it with the operator's own token, and only that truck's driver gets it:
// the driver app shows a new-message banner and the tab badge, and the driver's answer flows
// back to the card. An escalation lands in the supervisor's queue (Needs you and the bell).
// Only the LLM answer is stubbed; every send goes to the real backend.
import { expect, test } from "@playwright/test";
import { API, apiLogin, authHeaders, openDriver } from "./lib/driverSpj.js";

const TRUCK = "T-239";

async function signIn(page, path = "/app/reports", lang = "id", role = "dispatcher") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    (token) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", token.lang);
      localStorage.setItem("pythia_token", token.token);
      localStorage.setItem("pythia_role", token.role);
    },
    { ...principal, lang },
  );
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("ask-ana")).toBeVisible();
}

async function stubAna(page, proposal, answer) {
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "openai",
        mode: "llm",
        provider_name: "LLM",
        model: "test-model",
        answer,
        tools_used: ["propose_action"],
        proposed_actions: [proposal],
      }),
    }),
  );
}

async function ask(page, question) {
  await page.getByTestId("ask-ana").click();
  const dialog = page.getByRole("dialog", { name: "Ana" });
  await dialog.locator("#assistant-question").fill(question);
  await dialog.getByTestId("assistant-send").click();
  return dialog;
}

test("Ana's draft is edited, sent to one driver, and the driver app shows it with a badge", async ({
  page,
  browser,
  request,
}) => {
  const { token } = await apiLogin(request);
  const key = `e2e-ana-${Date.now()}`;

  // The driver app is open first: what is already there on its first live read is not "new".
  const driverContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const firstRead = driver.waitForResponse((r) => r.url().endsWith(`/api/dispatch/${TRUCK}`) && r.ok());
  await openDriver(driver, request, { token, truck: TRUCK });
  await firstRead;
  await expect(driver.getByTestId("driver-message-alert")).toHaveCount(0);

  await signIn(page);
  await stubAna(
    page,
    {
      id: key, // a fresh proposal id: the server sends one proposal once
      action: "message_driver",
      truck_code: TRUCK,
      text: "Tunggu di gerbang TPS. Detail: [rute](https://evil.example/x)",
      recipient: { type: "driver", truck_code: TRUCK },
      channels: ["in_app"],
      executed: false,
    },
    "Draf pesan untuk sopir menunggu persetujuan Anda.",
  );
  const dialog = await ask(page, `Kabari sopir ${TRUCK} untuk menunggu`);
  const card = dialog.getByTestId("proposal-card");
  await expect(card).toContainText(`Kirim ke sopir ${TRUCK}?`);
  await expect(card.getByTestId("send-preview-to")).toHaveText(
    `Sopir ${TRUCK} · aplikasi sopir · WhatsApp setelah nomor ditambahkan`,
  );
  // The injected link is shown as the characters it is, never as a link.
  await expect(card.getByTestId("send-preview-text")).toHaveText(
    "Tunggu di gerbang TPS. Detail: [rute](https://evil.example/x)",
  );
  await expect(card.locator("a")).toHaveCount(0);
  await expect(card).toContainText("Keputusan di tangan Anda.");

  await card.getByTestId("send-preview-edit").click();
  const text = `Tunggu di gerbang TPS 10 menit (${key}).`;
  await card.getByTestId("send-preview-input").fill(text);
  const sent = page.waitForResponse(
    (r) => r.url().endsWith("/api/driver/messages") && r.request().method() === "POST",
  );
  await card.getByTestId("send-preview-send").click();
  const response = await sent;
  expect(response.status()).toBe(201);
  const { dispatch } = await response.json();
  expect(dispatch).toMatchObject({ truck_code: TRUCK, instruction: text, manager_id: "dispatcher" });
  // The card sends an operation id; a retry with it (or the same proposal) is not a second message.
  const operationId = response.request().headers()["x-operation-id"];
  expect(operationId).toBeTruthy();
  const retry = await request.post(`${API}/driver/messages`, {
    headers: { ...authHeaders(token), "X-Operation-Id": operationId },
    data: { truck_code: TRUCK, text, source: "assistant", proposal_id: key },
  });
  expect(await retry.json()).toMatchObject({ replayed: true, dispatch: { id: dispatch.id } });

  try {
    const done = dialog.getByTestId("proposal-sent");
    await expect(done).toContainText(`Terkirim ke sopir ${TRUCK} lewat aplikasi sopir`);
    await expect(done.getByTestId("send-driver-answer")).toHaveText("Sopir: terkirim, menunggu dibaca");

    // The driver app: banner with the text, the Instructions badge, and the instruction itself.
    const alert = driver.getByTestId("driver-message-alert");
    await expect(alert).toBeVisible({ timeout: 25000 });
    await expect(alert).toContainText("Pesan baru dari dispatcher");
    await expect(driver.getByTestId("driver-message-alert-text")).toHaveText(text);
    await expect(alert).toContainText("lewat WhatsApp setelah nomor Anda terdaftar");
    await expect(driver.getByTestId("driver-tab-instruksi-count")).toHaveText("1");
    await driver.getByTestId("driver-message-alert-open").click();
    await expect(alert).toHaveCount(0);
    const item = driver.getByTestId(`driver-instruction-${dispatch.id}`);
    await expect(item).toContainText(text);

    // The driver accepts; the console card shows it was read.
    await item.getByTestId("driver-instruction-ready").click();
    await expect(done.getByTestId("send-driver-answer")).toHaveText("Sopir: sudah dibaca dan diterima", {
      timeout: 15000,
    });
  } finally {
    await request.post(`${API}/dispatch/${dispatch.id}/confirm`, {
      headers: authHeaders(token),
      data: { status: "READY", note: "E2E cleanup" },
    });
    await driverContext.close();
  }
});

test("Dismiss drops Ana's draft and sends nothing", async ({ page }) => {
  await signIn(page);
  const writes = [];
  await page.route(/\/api\/(driver\/messages|escalations|dispatch)$/, async (route) => {
    writes.push(route.request().url());
    await route.fulfill({ json: {} });
  });
  await stubAna(
    page,
    {
      id: "e2e-prop-2",
      action: "send_instruction",
      kind: "use_route",
      truck_code: TRUCK,
      text: "Gunakan Rute B.",
      channels: ["in_app"],
    },
    "Draf instruksi menunggu persetujuan Anda.",
  );
  const dialog = await ask(page, "Kirim rute B");
  const card = dialog.getByTestId("proposal-card");
  await expect(card).toContainText("Instruksi rute");
  await card.getByTestId("send-preview-dismiss").click();
  await expect(dialog.getByTestId("proposal-dismissed")).toHaveText(
    "Diabaikan. Minta draf baru ke Ana kapan saja.",
  );
  expect(writes).toEqual([]);
});

test("an approved escalation waits in the supervisor's queue and the bell", async ({ page, request }) => {
  const subject = `Rem ${TRUCK} perlu dicek (${Date.now()})`;
  await signIn(page, "/app/operations");
  await stubAna(
    page,
    {
      id: `e2e-prop-3-${Date.now()}`,
      action: "escalate_to_supervisor",
      subject,
      truck_code: TRUCK,
      text: "Sopir melapor rem terasa blong.",
      channels: ["console_inbox"],
    },
    "Draf eskalasi menunggu persetujuan Anda.",
  );
  const dialog = await ask(page, "Eskalasi rem");
  const card = dialog.getByTestId("proposal-card");
  await expect(card).toContainText("Eskalasikan ke pengawas lapangan?");
  await expect(card.getByTestId("send-preview-to")).toHaveText("Pengawas lapangan · antrean Perlu Anda");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/escalations"));
  await card.getByTestId("send-preview-send").click();
  const escalation = await (await sent).json();
  try {
    await expect(dialog.getByTestId("proposal-sent")).toHaveText(
      "Terkirim. Kini ada di antrean pengawas lapangan.",
    );
    await page.keyboard.press("Escape");

    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-popover")).toContainText(`Eskalasi: ${subject}`, { timeout: 15000 });
    await page.keyboard.press("Escape");

    const row = page.locator(`[data-testid=action-row][data-item-id="${escalation.id}"]`);
    await expect(row).toContainText(`Eskalasi: ${subject}`, { timeout: 70000 });
    await expect(row).toContainText("Untuk pengawas");
    await expect(row.getByTestId("needs-next-step")).toContainText("Pengawas: tinjau dan putuskan");
    // Closing it is the supervisor's call: the dispatcher who raised it gets no button.
    await expect(row.getByTestId("needs-action-mark_handled")).toHaveCount(0);

    // The supervisor's Mark handled closes the escalation record and the row leaves the queue.
    await signIn(page, "/app/operations", "id", "supervisor");
    await expect(row).toBeVisible({ timeout: 70000 });
    const handled = page.waitForResponse((r) => r.url().endsWith("/handled") && r.ok());
    await row.getByTestId("needs-action-mark_handled").click();
    expect(await (await handled).json()).toMatchObject({ id: escalation.id, status: "handled" });
    await expect(row).toHaveCount(0, { timeout: 15000 });
  } finally {
    const supervisor = await apiLogin(request, "supervisor");
    await request.post(`${API}/escalations/${encodeURIComponent(escalation.id)}/handled`, {
      headers: authHeaders(supervisor.token),
    });
  }
});

// The English console stays English around a driver message written in the drivers' language:
// every label is English, and the Indonesian text says which language it is in.
test("in English, a draft in the drivers' language is labelled and every control is English", async ({
  page,
}) => {
  await signIn(page, "/app/reports", "en");
  await stubAna(
    page,
    {
      id: "e2e-prop-4",
      action: "message_driver",
      truck_code: TRUCK,
      text: "Tunggu di gerbang TPS.",
      channels: ["in_app"],
      lang: "id",
    },
    "Your message to the driver is ready below.",
  );
  const dialog = await ask(page, `Tell ${TRUCK} to wait`);
  const card = dialog.getByTestId("proposal-card");
  await expect(card).toContainText(`Send to the driver of ${TRUCK}?`);
  await expect(card.getByTestId("send-preview-to")).toHaveText(
    `Driver of ${TRUCK} · driver app · WhatsApp once a number is added`,
  );
  await expect(card.getByTestId("send-preview-lang")).toHaveText("Message to driver · Bahasa Indonesia");
  await expect(card.getByTestId("send-preview-text")).toHaveAttribute("lang", "id");
  await expect(card).toContainText("Ready when you are: review it, edit it, press Send. You decide.");
  await expect(card.getByTestId("send-preview-send")).toHaveText("Send");
  await expect(card.getByTestId("send-preview-edit")).toHaveText("Edit");
  await expect(card.getByTestId("send-preview-dismiss")).toHaveText("Dismiss");
});

test("in English, an escalation reads English in Needs you", async ({ page }) => {
  await page.route(/\/api\/ops\/needs-you$/, (route) =>
    route.fulfill({
      json: {
        date: "2026-01-01",
        counts: { all: 1, urgent: 0, trucks: 1, gate: 0, tps: 0 },
        items: [
          {
            id: "escalation:e2e",
            kind: "escalation",
            category: "trucks",
            severity: "normal",
            truck_code: TRUCK,
            spj_id: null,
            created_at: "2026-01-01T01:00:00+00:00",
            facts: {
              subject: "Brakes on T-239",
              text: "Driver reports soft brakes.",
              raised_by: "dispatcher",
            },
            suggestion: null,
            actions: ["mark_handled"],
            classification: "FIELD",
            next_step: { key: "ea_step_escalation", params: { by: "dispatcher" } },
            rule: { id: "ESCALATION", key: "ea_rule_escalation", params: {} },
          },
        ],
      },
    }),
  );
  await signIn(page, "/app/operations", "en", "supervisor");
  const row = page.locator('[data-testid=action-row][data-kind="escalation"]');
  await expect(row).toContainText("Escalation: Brakes on T-239", { timeout: 30000 });
  await expect(row).toContainText("For the supervisor");
  await expect(row.getByTestId("needs-next-step")).toHaveText(
    "Supervisor: review it and decide (raised by dispatcher). · Rule: escalated by an operator for a supervisor decision",
  );
  await expect(row.getByTestId("needs-action-mark_handled")).toHaveText("Mark handled");
});

test("in English, the driver app announces a new message in English", async ({ page, request }) => {
  const { token } = await apiLogin(request);
  const firstRead = page.waitForResponse((r) => r.url().endsWith(`/api/dispatch/${TRUCK}`) && r.ok());
  await openDriver(page, request, { token, truck: TRUCK, lang: "en" });
  await firstRead;
  const sent = await request.post(`${API}/driver/messages`, {
    headers: authHeaders(token),
    data: { truck_code: TRUCK, text: `Wait at the gate (${Date.now()}).`, source: "console" },
  });
  expect(sent.status()).toBe(201);
  const { dispatch } = await sent.json();
  try {
    const alert = page.getByTestId("driver-message-alert");
    await expect(alert).toBeVisible({ timeout: 25000 });
    await expect(alert).toContainText("New message from dispatch");
    await expect(alert).toContainText("dispatch reaches you on WhatsApp once your number is registered");
    await expect(page.getByTestId("driver-message-alert-open")).toHaveText("Open");
    await expect(page.getByTestId("driver-message-alert-close")).toHaveAttribute(
      "aria-label",
      "Close message alert",
    );
  } finally {
    await request.post(`${API}/dispatch/${dispatch.id}/confirm`, {
      headers: authHeaders(token),
      data: { status: "READY", note: "E2E cleanup" },
    });
  }
});
