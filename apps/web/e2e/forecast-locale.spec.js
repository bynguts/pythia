import { expect, test } from "@playwright/test";
import { signIn } from "./lib/tomorrow.js";

// #68: the Tomorrow page's headings, cards and inputs follow the selected locale
// (English by default, Indonesian selectable).
const COPY = {
  en: {
    title: /^Tomorrow, \w{3} \d{1,2} \w{3}$/,
    forecast: "City-wide waste tomorrow",
    why: "Why it moved",
    resources: "What it takes, city-wide",
    facts: "Field facts",
    placeholder: "Add a fact, e.g. road closed",
    allocation: "Pilot fleet allocation",
    steps: ["Forecast ready", "Field facts", "Allocation", "Approval"],
  },
  id: {
    title: /^Besok, \w{3} \d{1,2} \w{3}$/,
    forecast: "Sampah se-kota besok",
    why: "Mengapa berubah",
    resources: "Kebutuhan se-kota",
    facts: "Fakta lapangan",
    placeholder: "Tambah fakta, mis. jalan ditutup",
    allocation: "Alokasi armada pilot",
    steps: ["Prakiraan siap", "Fakta lapangan", "Alokasi", "Persetujuan"],
  },
};

for (const lang of ["en", "id"]) {
  test(`tomorrow copy follows the locale (${lang})`, async ({ page }) => {
    const copy = COPY[lang];
    await signIn(page, { lang, path: "/app/tomorrow" });
    await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId("tmr-title")).toHaveText(copy.title);
    await expect(page.locator("#tmr-fc-title")).toHaveText(copy.forecast);
    await expect(page.getByTestId("plan-drivers")).toContainText(copy.why);
    await expect(page.locator("#tmr-res-title")).toHaveText(copy.resources);
    await expect(page.locator("#tmr-facts-title")).toHaveText(copy.facts);
    await expect(page.getByTestId("tmr-fact-input")).toHaveAttribute("placeholder", copy.placeholder);
    await expect(page.locator("#tmr-alloc-title")).toHaveText(copy.allocation);
    const labels = page.locator(".planning-progress .ui-progress4-label");
    await expect(labels).toHaveText(copy.steps);
  });
}
