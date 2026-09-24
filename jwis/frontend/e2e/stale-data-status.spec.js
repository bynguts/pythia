import { expect, test } from "@playwright/test";

/**
 * #46: cached API data must be distinguishable from a live backend connection.
 *
 * Scenario: the backend becomes unreachable while the browser network stays
 * up. The service worker serves the cached /api response with stale metadata,
 * and the Field header must show a degraded/stale state with the age of the
 * cached data — not "Daring".
 */

const FIELD = "/field";

async function signInAsField(page, truckCode = "T-047") {
  await page.addInitScript(
    ({ code }) => {
      localStorage.setItem("jwis_auth", "true");
      localStorage.setItem("jwis_token", "e2e-field-token");
      localStorage.setItem("jwis_role", "field");
      localStorage.setItem("jwis_field_truck", code);
      localStorage.setItem("jwis_lang", "id");
    },
    { code: truckCode },
  );
}

test("stale cached dispatch shows a degraded status with data age, not Daring", async ({ page }) => {
  await signInAsField(page);

  // Phase 1: live backend. Phase 2: the service worker's cached-API fallback
  // (headers X-Jwis-Stale / X-Jwis-Cached-At are attached by sw.js when it
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
        "X-Jwis-Stale": "1",
        "X-Jwis-Cached-At": new Date(Date.now() - 5 * 60_000).toISOString(),
        // Cross-origin fetches only expose safe-listed headers unless listed.
        "Access-Control-Expose-Headers": "X-Jwis-Stale, X-Jwis-Cached-At",
      },
      body: dispatchBody,
    });
  });

  await page.goto(FIELD);
  await expect(page.getByTestId("conn-status")).toHaveText("Daring");

  // Backend dies while the browser network stays up (navigator.onLine === true).
  backendUp = false;
  await page.reload();

  // The SW/layer serving the stale copy exposes metadata; the header must NOT
  // claim "Daring" and must surface the age of the cached operational data.
  const status = page.getByTestId("conn-status");
  await expect(status).not.toHaveText("Daring");
  await expect(status).toContainText(/Cache/i);
  // Age is surfaced to operators (cached ~5 minutes ago).
  await expect(status).toContainText(/menit|minute/i);

  // The stale instruction itself stays visible — operators keep their copy.
  await expect(page.getByText("cached instruction")).toBeVisible();
});
