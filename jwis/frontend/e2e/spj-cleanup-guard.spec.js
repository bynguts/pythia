import { expect, test } from "@playwright/test";
import { assertNoLeftoverActiveSpj, cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

// #89 regression guard: cleanup must run and complete even when the scenario
// body fails (or times out). A leftover active/draft SPJ on T-210 would poison
// the next run of spj-workflow. This spec simulates the failure mode: the
// scenario body throws AFTER creating an SPJ, and the independent cleanup
// path must still cancel it before the run ends. The run must stay green —
// a red suite from a working guard would just train people to ignore it.
const API = "http://127.0.0.1:8001/api";

test.afterAll(async () => {
  await disposeCleanupContext();
});

test("cleanup runs to completion when the scenario body throws", async ({ page }) => {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };

  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: "E2E Cleanup Guard",
      truck_code: "T-210",
      destination: "TPST Bantargebang",
      weigh_on_site: false,
      priority: "normal",
      note: "cleanup-guard",
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();

  // Simulate the failure mode (#89): scenario dies mid-flight. Capture it
  // instead of letting it fail the test — the assertion target is cleanup.
  let scenarioError = null;
  try {
    throw new Error("deliberate scenario failure (#89 guard)");
  } catch (error) {
    scenarioError = error;
  } finally {
    // The production cleanup path (independent context) must still cancel,
    // and this must hold even though the scenario "failed".
    const outcome = await cancelSpjIndependently(token, spj.spj_id);
    console.log(`[cleanup-guard] ${spj.spj_number}: ${outcome}`);
    expect(outcome).toBe("cancelled");
    await assertNoLeftoverActiveSpj(token);
  }
  // Prove we really exercised the failure path, not a happy path by accident.
  expect(scenarioError.message).toContain("deliberate scenario failure");
});
