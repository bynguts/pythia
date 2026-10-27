// gsc-2026 P1-9 + C2: Ana runs a what-if into the Twin/XR (plan + sources card, deep links with the venue) and takes voice input.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const QUESTION_ID = "Kalau hujan 80 mm pas konser 50 ribu di GBK besok?";

const SCENARIO = {
  tool: "run_scenario",
  classification: "MODEL_OUTPUT",
  city: "jakarta",
  scenario: { rainfall_mm: 80, event_attendance: 50000, venue: "GBK", day: 1, date: "2026-10-23" },
  summary: {
    total_tons: 9120.4,
    normal_tons: 8410.2,
    extra_tons: 710.2,
    districts_at_risk: 6,
    trucks_required: 507,
    extra_trucks: 40,
    extra_crews: 40,
    extra_workers: 160,
    truck_capacity_tons: 18,
    crew_size_workers: 4,
  },
  top_districts: [
    {
      name: "Tanah Abang",
      admin_area: "Jakarta Pusat",
      tons: 410,
      normal_tons: 300,
      extra_tons: 110,
      risk: "critical",
      extra_trucks: 7,
    },
  ],
  queue_minutes_per_truck: {
    baseline_mean: 42.5,
    staggered_mean: 18,
    baseline_p95: 90,
    staggered_p95: 35,
    replications: 30,
    baseline_band: [31.2, 47.9],
    classification: "SIMULATED",
    source: "Seeded discrete-event queue simulation",
    scenario_specific: false,
  },
  plan: ["parse_scenario", "district_forecast", "normal_day_baseline", "resource_units", "queue_metric"],
  sources: [
    { id: "district_forecast", class: "MODEL_OUTPUT", source: "Prophet + XGBoost per kecamatan" },
    { id: "resource_units", class: "PLANNING_RULE", source: "canonical units: 1 truck = 18 t" },
    { id: "landfill_queue", class: "SIMULATED", source: "Seeded discrete-event queue simulation" },
  ],
  links: {
    twin: "/twin?city=jakarta&rain=80&event=50k&day=1&present=1",
    xr: "/xr?city=jakarta&rainfall_mm=80.0&event_attendance=50000&event_lat=-6.2183&event_lng=106.8022",
  },
  note: "Scenario forecast, not an observation.",
};

async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
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
  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });
}

async function openAssistant(page) {
  await page.getByTestId("ask-ana").click();
  await expect(page.getByTestId("ana-drawer")).toBeVisible();
}

test("what-if answer shows plan, sources, provenance and opens the twin with the scenario", async ({
  page,
}) => {
  await signIn(page, "en");
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({
      json: {
        provider: "local",
        mode: "local",
        answer: "**Scenario (MODEL OUTPUT, not an observation):** 80 mm rain + 50,000-person event at GBK.",
        tools_used: ["run_scenario"],
        scenario: SCENARIO,
      },
    }),
  );
  await openAssistant(page);
  const request = page.waitForRequest((req) => req.url().includes("/assistant/query"));
  await page.getByTestId("assistant-prompt-scenario").click();
  expect((await request).postDataJSON().question).toContain("80 mm");

  const card = page.getByTestId("assistant-scenario-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("assistant-scenario-badge")).toHaveText("MODEL OUTPUT");
  await expect(page.getByTestId("assistant-scenario-plan").locator("li")).toHaveCount(5);
  await expect(page.getByTestId("assistant-scenario-plan")).toContainText(
    "district forecast used by the Twin",
  );
  await expect(page.getByTestId("assistant-scenario-sources")).toContainText("SIMULATED");
  await expect(page.getByTestId("assistant-scenario-sources")).toContainText("Prophet + XGBoost");
  await expect(card).toContainText("Tanah Abang");
  // The queue figure keeps its sensitivity band, labelled simulated, like the Twin HUD;
  // equal truck and crew counts name the one-crew-per-truck rule from the payload's crew size.
  await expect(card.locator(".is-queue dd").first()).toHaveText("42.5 (31.2–47.9) → 18");
  await expect(page.getByTestId("assistant-scenario-queue-band")).toHaveText(
    "Range 31.2–47.9: unstaggered wait across departure spreads",
  );
  await expect(page.getByTestId("assistant-scenario-crew-rule")).toHaveText("1 crew per truck (4 workers)");
  await expect(page.getByTestId("assistant-scenario-snapped")).toHaveCount(0);
  await expect(page.getByTestId("assistant-open-xr")).toHaveAttribute("href", SCENARIO.links.xr);
  const twin = page.getByTestId("assistant-open-twin");
  await expect(twin).toHaveText("Open in Twin");
  const box = await twin.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);

  await twin.click();
  await page.waitForURL(/\/twin\?/);
  const url = new URL(page.url());
  expect(url.pathname).toBe("/twin");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    city: "jakarta",
    rain: "80",
    event: "50k",
    day: "1",
    present: "1",
  });
  // GBK is Jakarta's default venue, so the link stays short.
  expect(url.searchParams.has("venue")).toBe(false);
});

test("a what-if at another venue opens the twin on that venue", async ({ page }) => {
  await signIn(page, "en");
  // Older payloads name the venue only in the scenario; the card maps it to the twin's venue id.
  const atJis = {
    ...SCENARIO,
    // gsc-2026 m9: Ana ran the twin's presets; the card says what was asked.
    scenario: {
      ...SCENARIO.scenario,
      venue: "JIS",
      requested: { rainfall_mm: 83, event_attendance: 60000 },
      snapped_to_twin_presets: true,
    },
    links: {
      twin: "/twin?city=jakarta&rain=80&event=50k&day=1&present=1",
      xr: "/xr?city=jakarta&rainfall_mm=80.0&event_attendance=50000&event_lat=-6.1246&event_lng=106.8584",
    },
  };
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({
      json: {
        provider: "local",
        mode: "local",
        answer: "JIS",
        tools_used: ["run_scenario"],
        scenario: atJis,
      },
    }),
  );
  await openAssistant(page);
  await page.getByTestId("assistant-prompt-scenario").click();
  await expect(page.getByTestId("assistant-scenario-card")).toBeVisible();
  const href = await page.getByTestId("assistant-open-twin").getAttribute("href");
  const query = new URL(href, "http://localhost").searchParams;
  expect(Object.fromEntries(query)).toMatchObject({ city: "jakarta", event: "50k", venue: "jis" });
  await expect(page.getByTestId("assistant-open-xr")).toHaveAttribute("href", atJis.links.xr);
  await expect(page.getByTestId("assistant-scenario-snapped")).toHaveText(
    "Adjusted to the twin's presets (asked: 83 mm, 60,000 people).",
  );
});

test("the real backend answers an Indonesian what-if with a labelled scenario", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "id");
  await openAssistant(page);
  await page.locator("#assistant-question").fill(QUESTION_ID);
  await page.getByTestId("assistant-send").click();
  const card = page.getByTestId("assistant-scenario-card");
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("assistant-scenario-badge")).toHaveText("MODEL OUTPUT");
  await expect(page.getByTestId("assistant-open-twin")).toHaveText("Buka di Twin");
  const href = await page.getByTestId("assistant-open-twin").getAttribute("href");
  expect(href).toContain("rain=80");
  expect(href).toContain("event=50k");
  expect(href).toContain("day=1");
  expect(await page.getByTestId("assistant-open-xr").getAttribute("href")).toContain(
    "event_attendance=50000",
  );
});

test("mic button is hidden when the browser has no speech recognition", async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
    }
  });
  await signIn(page, "id");
  await openAssistant(page);
  await expect(page.locator("#assistant-question")).toBeVisible();
  await expect(page.getByTestId("assistant-voice")).toHaveCount(0);
});

test("voice input fills the question in the UI language", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      start() {
        window.__speechLang = this.lang;
        setTimeout(() => {
          this.onresult?.({
            results: [[{ transcript: "kalau hujan 80 mm pas konser 50 ribu di GBK besok" }]],
          });
          this.onend?.();
        }, 50);
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    window.SpeechRecognition = FakeRecognition;
  });
  await signIn(page, "id");
  await openAssistant(page);
  const mic = page.getByTestId("assistant-voice");
  await expect(mic).toHaveAccessibleName("Ucapkan pertanyaan");
  const box = await mic.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await mic.click();
  await expect(page.locator("#assistant-question")).toHaveValue(
    "kalau hujan 80 mm pas konser 50 ribu di GBK besok",
  );
  expect(await page.evaluate(() => window.__speechLang)).toBe("id-ID");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
});
