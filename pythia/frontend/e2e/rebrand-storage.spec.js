import { expect, test } from "@playwright/test";

// Rebrand: browser state saved under the pre-rebrand jwis_* keys (login,
// language, offline queues) must survive the first load of the Pythia build.
// Queued submissions are merged, never dropped, when both key sets exist.
test("legacy jwis_* browser state moves to pythia_* keys on first load", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("rebrand-seeded")) return;
    sessionStorage.setItem("rebrand-seeded", "1");
    localStorage.clear();
    localStorage.setItem("jwis_lang", "en");
    localStorage.setItem("jwis_role", "dispatcher");
    localStorage.setItem("jwis_field_outbox", JSON.stringify([
      { dispatchId: "D-1", status: "READY", queued_at: "2026-01-01T00:00:00Z" },
      { dispatchId: "D-2", status: "ISSUE", queued_at: "2026-01-01T00:00:00Z" },
    ]));
    // An old tab kept queueing after the new build had already written D-1.
    localStorage.setItem("pythia_field_outbox", JSON.stringify([
      { dispatchId: "D-1", status: "READY", queued_at: "2026-01-02T00:00:00Z" },
    ]));
    localStorage.setItem("jwis_driver_outbox", JSON.stringify([
      { op_id: "op-1", path: "/pretrip", data: {}, fingerprint: "fp-1" },
    ]));
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  const state = await page.evaluate(() => ({
    legacyKeys: Object.keys(localStorage).filter((key) => key.startsWith("jwis_")),
    lang: localStorage.getItem("pythia_lang"),
    role: localStorage.getItem("pythia_role"),
    field: JSON.parse(localStorage.getItem("pythia_field_outbox")),
    driver: JSON.parse(localStorage.getItem("pythia_driver_outbox")),
  }));
  expect(state.legacyKeys).toEqual([]);
  expect(state.lang).toBe("en");
  expect(state.role).toBe("dispatcher");
  expect(state.field.map((item) => `${item.dispatchId}|${item.status}`))
    .toEqual(["D-1|READY", "D-2|ISSUE"]);
  // The new build's own entry is kept as written (its queued_at wins).
  expect(state.field[0].queued_at).toBe("2026-01-02T00:00:00Z");
  expect(state.driver.map((item) => item.op_id)).toEqual(["op-1"]);
});
