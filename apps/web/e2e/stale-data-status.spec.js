import { expect, test } from "@playwright/test";

/**
 * #46: cached API data must be distinguishable from a live backend connection.
 *
 * Scenario: the backend becomes unreachable while the browser network stays
 * up. The service worker serves the cached /api response with stale metadata,
 * and the instructions must say they are cached, with the age of the cached
 * Data — never shown as live. /field merged into the
 * driver app's Instruksi tab.
 */

const FIELD = "/driver?tab=instruksi";

async function signInAsField(page, truckCode = "T-047") {
  await page.addInitScript(
    ({ code }) => {
      localStorage.setItem("pythia_field_token", "e2e-field-token");
      localStorage.setItem("pythia_field_role", "driver");
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: code }));
      localStorage.setItem("pythia_lang", "id");
    },
    { code: truckCode },
  );
  // gsc-2026 P0-2: the driver sign-in gate validates the stored token; this
  // scenario stubs the backend, so the session check is stubbed too.
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { role: "driver", permissions: ["dispatch:confirm"] } }),
  );
}

test("stale cached dispatch is labelled as cached with its age, not as live", async ({ page }) => {
  await signInAsField(page);

  // Phase 1: live backend. Phase 2: the service worker's cached-API fallback
  // (headers X-Pythia-Stale / X-Pythia-Cached-At are attached by sw.js when it
  // serves /api responses from cache after the backend is unreachable).
  let backendUp = true;
  const dispatchBody = JSON.stringify([
    {
      id: "stale-e2e-1",
      truck_code: "T-047",
      kecamatan: "Cilandak",
      field_status: "PENDING",
      instruction: "cached instruction",
      created_at: new Date().toISOString(),
    },
  ]);
  await page.route("**/api/dispatch/*", async (route) => {
    if (backendUp) {
      return route.fulfill({ status: 200, contentType: "application/json", body: dispatchBody });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "X-Pythia-Stale": "1",
        "X-Pythia-Cached-At": new Date(Date.now() - 5 * 60_000).toISOString(),
        // Cross-origin fetches only expose safe-listed headers unless listed.
        "Access-Control-Expose-Headers": "X-Pythia-Stale, X-Pythia-Cached-At",
      },
      body: dispatchBody,
    });
  });

  await page.goto(FIELD);
  await expect(page.getByText("cached instruction")).toBeVisible();
  await expect(page.getByTestId("driver-instructions-cached")).toHaveCount(0);

  // Backend dies while the browser network stays up (navigator.onLine === true).
  backendUp = false;
  await page.reload();

  // The SW/layer serving the stale copy exposes metadata; the card must say
  // the data is cached and surface the age of the cached operational data.
  const status = page.getByTestId("driver-instructions-cached");
  await expect(status).toContainText(/Cache/i);
  // Age is surfaced to operators (cached ~5 minutes ago).
  await expect(status).toContainText(/menit|minute/i);

  // The stale instruction itself stays visible — operators keep their copy.
  await expect(page.getByText("cached instruction")).toBeVisible();
});
