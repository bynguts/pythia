import { expect, test } from "@playwright/test";

/**
 * #23: Scentinel sensor-placement evidence surfaces in Data & Model Audit.
 *
 * Imported runs must be labelled external_simulation (never live telemetry),
 * show every quality gate with its true state, and keep the model-boundary
 * disclaimer visible in both locales.
 */

const API = "http://127.0.0.1:8001/api";

const MANIFEST = {
  schema: "scentinel.run.v1",
  run_id: `e2e-scentinel-${Date.now()}`,
  source_repository: "https://github.com/alertxsto/scentinel",
  source_version: "v1.2.0",
  scenario: "tps-cilandak-compact",
  gas_set: ["ch4", "h2s"],
  candidate_sensors: [
    { sensor_id: "S1", lat: -6.29, lng: 106.79, rationale: "upwind boundary" },
  ],
  execution: {
    pipeline_success: true,
    numerical_convergence: true,
    mesh_independence: false,
    mass_balance: true,
    experimental_validation: false,
    finished_at: "2026-09-24T04:00:00Z",
  },
  input_digest: "e2edigest123",
};

const CSV = "timestamp,sensor_id,gas,ppm\n2026-09-24T04:00:01Z,S1,ch4,12.5\n";

async function apiLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dispatcher", password: "dispatcher-demo-pass" }),
  });
  return res.json();
}

test("scentinel evidence renders as external simulation with visible gates", async ({ page }) => {
  const principal = await apiLogin();
  const headers = { Authorization: `Bearer ${principal.token}` };

  const importRes = await fetch(`${API}/scentinel/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ manifest: MANIFEST, sensor_csv: CSV, truck_code: "T-047" }),
  });
  expect(importRes.status).toBe(201);

  // Authenticate then open the Data & Model Audit workspace via the rail.
  await page.goto("/");
  await page.evaluate((token) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", "dispatcher");
    localStorage.setItem("jwis_lang", "en");
  }, principal.token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Data & ML Audit" }).click();

  const panel = page.getByTestId("scentinel-evidence-panel");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(MANIFEST.run_id)).toBeVisible();

  // External-simulation classification, never live telemetry (this run's card
  // specifically — the store may hold earlier imported runs too).
  const runCard = page.locator(".scentinel-run").filter({ hasText: MANIFEST.run_id });
  await expect(runCard.getByTestId("scentinel-evidence-class")).toContainText(/external simulation/i);

  // Quality gates render with their true state (mixed pass/fail).
  const gates = runCard.getByTestId(`scentinel-gates-${MANIFEST.run_id}`);
  await expect(gates.getByText(/numerical convergence/i)).toBeVisible();
  await expect(gates.getByText(/mesh independence/i)).toBeVisible();
  await expect(gates.locator("li.good")).toHaveCount(3);
  await expect(gates.locator("li.limited")).toHaveCount(2);

  // Provenance stays auditable (scoped to this run's card).
  await expect(runCard.getByText(/alertxsto\/scentinel@v1\.2\.0/)).toBeVisible();

  // Model boundary disclaimer explains the simulation/telemetry distinction.
  await expect(panel).toContainText(/not live vehicle sensor measurements/i);
});

test("incompatible manifest schema is rejected with an actionable error", async () => {
  const principal = await apiLogin();
  const headers = { Authorization: `Bearer ${principal.token}` };
  const res = await fetch(`${API}/scentinel/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      manifest: { ...MANIFEST, schema: "scentinel.run.v9", run_id: "e2e-bad-schema" },
      sensor_csv: CSV,
    }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.detail).toContain("scentinel.run.v1");
});
