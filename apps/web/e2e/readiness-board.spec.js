// Morning readiness (/app/readiness). The board is read from the real API; the action flows
// (swap to backup, ask for a duty override, WhatsApp, activate) run against a stubbed board so each one
// has a truck to act on, and the requests they post are asserted.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const DATE = "2026-10-26";

async function signIn(page, { role = "dispatcher", lang = "en" } = {}) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
  return principal;
}

function truck(code, overrides = {}) {
  return {
    truck_code: code,
    driver_name: `Driver ${code.slice(-2)}`,
    zone: "Jakarta Barat",
    zone_classification: "SIMULATED",
    gate_slot: null,
    pretrip: { done: true, at: "2026-10-26T05:10:00+07:00", failed_items: [] },
    duty: { minutes: 0, state: "ok", override: null, source: "observed" },
    instruction: { dispatch_id: 1, status: "acknowledged", updated_at: "2026-10-26T05:02:00+07:00" },
    spj: { spj_id: `spj-${code}`, spj_number: `SPJ-${code}`, status: "draft", other_active_spj_id: null },
    damage: { open: 0, heavy: false },
    service: { due_soon: false },
    ready: true,
    blockers: [],
    ...overrides,
  };
}

function board() {
  const trucks = [
    truck("T-019", {
      pretrip: { done: true, at: "2026-10-26T05:00:00+07:00", failed_items: ["rem"] },
      damage: { open: 1, heavy: true },
      ready: false,
      blockers: ["damage_open"],
    }),
    truck("T-088", {
      duty: { minutes: 730, state: "blocked", override: null, source: "observed" },
      ready: false,
      blockers: ["duty_blocked"],
    }),
    truck("T-031", {
      pretrip: { done: false, at: null, failed_items: [] },
      instruction: { dispatch_id: 2, status: "pending", updated_at: "2026-10-26T04:40:00+07:00" },
      ready: false,
      blockers: ["pretrip_missing", "instruction_pending"],
    }),
    truck("T-001"),
    truck("T-047"),
  ];
  return {
    date: DATE,
    generated_at: "2026-10-26T05:20:00+07:00",
    scope_used: "plan",
    first_departure: { depart_at: "06:00", date: DATE, truck_code: "T-001", classification: "MODEL_OUTPUT" },
    backup_candidates: [
      {
        truck_code: "T-140",
        driver_name: "Driver 40",
        pretrip_at: "2026-10-26T05:08:00+07:00",
        zone: "Jakarta Timur",
        classification: "FIELD",
        basis: "pre-trip passed today",
      },
    ],
    thresholds: { duty_warn_min: 600, duty_block_min: 720 },
    trucks,
    counts: { ready: 2, not_ready: 1, blocked: 2 },
  };
}

const PLAN = {
  plan_id: "plan-1",
  plan_date: DATE,
  status: "approved",
  dispatches: [
    {
      truck_code: "T-019",
      fields: { stops: [{ order: 1 }, { order: 2 }, { order: 3 }], gate_slot: { start: "08:45" } },
    },
  ],
};

async function stub(page, posts) {
  await page.route("**/api/readiness*", (route) => route.fulfill({ json: board() }));
  await page.route("**/api/operations/plans?*", (route) => route.fulfill({ json: [PLAN] }));
  for (const path of [
    "operations/plan-1/reassign",
    "alert/follow-up",
    "safety/override",
    "whatsapp/alert",
    "whatsapp/summary",
    "spj/*/activate",
  ]) {
    await page.route(`**/api/${path}`, async (route) => {
      posts.push({
        path: new URL(route.request().url()).pathname.replace("/api/", ""),
        body: route.request().postDataJSON(),
      });
      await route.fulfill({ json: { sent: true, recorded: true } });
    });
  }
}

test("the board lists every truck of the API, blockers first", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const data = await (
    await page.request.get(`${API}/readiness?scope=plan`, {
      headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("pythia_token"))}` },
    })
  ).json();
  await page.goto("/app/readiness");
  await expect(page.getByRole("heading", { level: 1, name: "Morning readiness" })).toBeVisible();
  await expect(page.getByTestId("readiness-page")).toHaveAttribute("data-scope", data.scope_used, {
    timeout: 30000,
  });
  await expect(page.getByTestId("readiness-tab-all")).toContainText(`All · ${data.trucks.length}`);
  await page.getByTestId("readiness-tab-all").click();
  await expect(page.getByTestId("readiness-list").locator("tbody tr:not(.ui-table-expanded)")).toHaveCount(
    data.trucks.length,
  );
});

test("swap to backup shows the backup card and posts the reassign", async ({ page }) => {
  const posts = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await stub(page, posts);
  await page.goto("/app/readiness");
  await expect(page.getByText("First departure 06:00 · 2 of 5 trucks ready to roll")).toBeVisible();
  const card = page.getByTestId("readiness-swap-card");
  await expect(card).toContainText("Backup T-140 passed the pre-trip check at 05:08");
  await expect(card).toContainText("3 planned trips");
  await expect(card).toContainText("08:45 gate slot");
  await expect(page.getByTestId("readiness-swap")).toHaveText("Swap to T-140");
  await page.getByTestId("readiness-swap-confirm").click();
  await expect(page.getByTestId("readiness-notice")).toContainText("T-019 swapped for T-140.");
  expect(posts.find((p) => p.path === "operations/plan-1/reassign").body).toMatchObject({
    from_truck: "T-019",
    to_truck: "T-140",
  });
});

test("a dispatcher asks for a duty override with a reason; a supervisor grants it", async ({ page }) => {
  const posts = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await stub(page, posts);
  await page.goto("/app/readiness");
  await page.getByTestId("readiness-override").click();
  const submit = page.getByRole("button", { name: "Send request" });
  await expect(submit).toBeDisabled();
  await page.getByLabel(/Why may T-088 keep driving/).fill("Replacement driver is late");
  await submit.click();
  await expect(page.getByTestId("readiness-notice")).toContainText("Override requested for T-088.");
  expect(posts.find((p) => p.path === "alert/follow-up").body).toMatchObject({
    alert_id: "duty-T-088",
    status: "OPEN",
  });

  await signIn(page, { role: "supervisor" });
  await page.goto("/app/readiness");
  await page.getByTestId("readiness-override").click();
  await page.getByLabel(/Why may T-088 keep driving/).fill("Replacement driver is late");
  await page.getByRole("button", { name: "Grant override" }).click();
  await expect(page.getByTestId("readiness-notice")).toContainText("Override granted for T-088.");
  expect(posts.find((p) => p.path === "safety/override").body).toEqual({
    truck_code: "T-088",
    reason: "Replacement driver is late",
  });
});

test("remind and activate act on the right trucks and say what was sent", async ({ page }) => {
  const posts = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await stub(page, posts);
  await page.goto("/app/readiness");
  await expect(page.getByTestId("readiness-remind")).toHaveText("Remind 1 driver");
  await page.getByTestId("readiness-remind").click();
  await expect(page.getByTestId("readiness-notice")).toContainText("WhatsApp sent for 1 of 1 trucks.");
  // One message to the alert group for all reminded trucks, never one per truck.
  expect(posts.filter((p) => p.path === "whatsapp/alert")).toEqual([]);
  const summaries = posts.filter((p) => p.path === "whatsapp/summary");
  expect(summaries).toHaveLength(1);
  expect(summaries[0].body.text).toContain("T-031");

  await expect(page.getByTestId("readiness-activate")).toHaveText("Activate 2 work orders");
  await page.getByTestId("readiness-activate").click();
  await expect(page.getByTestId("readiness-notice")).toContainText("2 of 2 work orders activated.");
  expect(
    posts
      .filter((p) => p.path.endsWith("/activate"))
      .map((p) => p.path)
      .sort(),
  ).toEqual(["spj/spj-T-001/activate", "spj/spj-T-047/activate"]);
});

test("Indonesian copy, no horizontal overflow and 44 px actions at 390 px", async ({ page }) => {
  const posts = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, { lang: "id" });
  await stub(page, posts);
  await page.goto("/app/readiness");
  await expect(page.getByRole("heading", { level: 1, name: "Kesiapan pagi" })).toBeVisible();
  await expect(page.getByTestId("readiness-swap")).toHaveText("Tukar ke T-140");
  const geometry = await page.evaluate(() => {
    const small = [...document.querySelectorAll(".rdy button")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.width < 44 || r.height < 44));
    return { small: small.length, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.small).toBe(0);
  expect(geometry.overflow).toBeLessThanOrEqual(2);
});
