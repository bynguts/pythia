#!/usr/bin/env node
/**
 * #41: bundle budget gate — run after `vite build` (dist/ must exist).
 *
 * Budgets are recorded in bytes (raw). A chunk that exceeds its budget fails
 * CI. Chunks without an explicit budget fall under the default cap.
 *
 * Usage: node e2e/lib/bundle-budget.mjs   (exit 1 on violation)
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist", "assets");
const KB = 1024;

/** Agreed budgets (raw bytes). Lazy chunks are allowed to be larger than
 * the startup path but still capped. */
const BUDGETS = {
  // Startup path: the main JS bundle must stay lean for field networks.
  main: 700 * KB,
  // Map stack: shipped as its own versioned vendor chunk, loaded only when
  // Fleet mounts (already lazy). Split from LiveFleetMap so the app shell
  // never downloads it twice across deploys.
  maplibre: 1100 * KB,
  LiveFleetMap: 300 * KB,
  // PDF tooling: loaded on demand from ReportActions only.
  html2pdf: 1100 * KB,
  // Any other lazy chunk.
  default: 600 * KB,
  // Single stylesheet cap.
  css: 200 * KB,
};

function budgetFor(name) {
  if (name.startsWith("maplibre")) return BUDGETS.maplibre;
  if (name.startsWith("LiveFleetMap")) return name.endsWith(".js") ? BUDGETS.LiveFleetMap : BUDGETS.default;
  if (name.startsWith("html2pdf")) return BUDGETS.html2pdf;
  if (name.startsWith("index-") && name.endsWith(".js")) return BUDGETS.main;
  if (name.endsWith(".css")) return BUDGETS.css;
  return BUDGETS.default;
}

const files = readdirSync(dist);
const violations = [];
const report = [];

for (const file of files) {
  if (!file.endsWith(".js") && !file.endsWith(".css")) continue;
  const size = statSync(join(dist, file)).size;
  const budget = budgetFor(file);
  const status = size <= budget ? "ok" : "OVER";
  report.push(`${status.padEnd(4)} ${file}  ${(size / KB).toFixed(1)} kB / ${(budget / KB).toFixed(0)} kB`);
  if (size > budget) violations.push(`${file}: ${(size / KB).toFixed(1)} kB exceeds ${(budget / KB).toFixed(0)} kB budget`);
}

console.log(report.join("\n"));
if (violations.length) {
  console.error("\nBUNDLE BUDGET VIOLATIONS:\n" + violations.join("\n"));
  process.exit(1);
}
console.log("\nAll chunks within budget.");
