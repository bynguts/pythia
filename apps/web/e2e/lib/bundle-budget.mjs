#!/usr/bin/env node
/**
 * #41: bundle budget gate — run after `vite build` (dist/ must exist).
 *
 * Budgets are recorded in bytes (raw). A chunk that exceeds its budget fails
 * CI. Chunks without an explicit budget fall under the default cap.
 *
 * R2: the /driver startup path (dist/index.html's entry script plus its
 * modulepreload links) is also capped by its gzip size, which is what a
 * driver's phone downloads before the app renders.
 *
 * Usage: node e2e/lib/bundle-budget.mjs   (exit 1 on violation, or when dist/ is missing)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(process.cwd(), "dist");
const dist = join(root, "assets");
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
  // the Twin bundles deck.gl and loads only when the Twin
  // mounts. (A separate deck.gl vendor chunk would pull Vite's preload helper
  // into it and onto the startup path.)
  TwinWorkspace: 1100 * KB,
  // the /xr tabletop; it loads only on /xr.
  XrTabletop: 700 * KB,
  // three.js, shared by the /xr tabletop and the driver's WebXR street path;
  // loaded only by those lazy chunks.
  three: 650 * KB,
  // PDF tooling: loaded on demand from ReportActions only.
  html2pdf: 1100 * KB,
  // Any other lazy chunk.
  default: 600 * KB,
  // Single stylesheet cap.
  css: 200 * KB,
  // R2: /driver startup JS, gzip bytes (entry script + modulepreloads).
  driverStartupGzip: 250 * KB,
};

function budgetFor(name) {
  if (name.startsWith("maplibre")) return BUDGETS.maplibre;
  if (name.startsWith("TwinWorkspace") && name.endsWith(".js")) return BUDGETS.TwinWorkspace;
  if (name.startsWith("XrTabletop") && name.endsWith(".js")) return BUDGETS.XrTabletop;
  if (name.startsWith("three.module") && name.endsWith(".js")) return BUDGETS.three;
  if (name.startsWith("LiveFleetMap")) return name.endsWith(".js") ? BUDGETS.LiveFleetMap : BUDGETS.default;
  if (name.startsWith("html2pdf")) return BUDGETS.html2pdf;
  if (name.startsWith("index-") && name.endsWith(".js")) return BUDGETS.main;
  if (name.endsWith(".css")) return BUDGETS.css;
  return BUDGETS.default;
}

// The same-origin scripts index.html loads before the first render: its
// module entry and every modulepreload link (attribute order does not matter).
function startupScripts(html) {
  const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1];
  const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map(([tag]) => tag);
  const entries = tags("script")
    .filter((tag) => attr(tag, "type") === "module")
    .map((tag) => attr(tag, "src"));
  const preloads = tags("link")
    .filter((tag) => attr(tag, "rel") === "modulepreload")
    .map((tag) => attr(tag, "href"));
  return [...new Set([...entries, ...preloads])].filter((src) => src?.startsWith("/"));
}

if (!existsSync(dist)) {
  console.error(`No build output at ${dist}: run "npm run build" first.`);
  process.exit(1);
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
  if (size > budget)
    violations.push(`${file}: ${(size / KB).toFixed(1)} kB exceeds ${(budget / KB).toFixed(0)} kB budget`);
}

const indexHtml = join(root, "index.html");
if (existsSync(indexHtml)) {
  const scripts = startupScripts(readFileSync(indexHtml, "utf8"));
  let gzip = 0;
  for (const src of scripts) {
    const path = join(root, src.slice(1));
    if (existsSync(path)) gzip += gzipSync(readFileSync(path)).length;
    else violations.push(`index.html loads ${src}, which is not in dist/`);
  }
  const budget = BUDGETS.driverStartupGzip;
  const status = gzip <= budget ? "ok" : "OVER";
  const sizes = `${(gzip / KB).toFixed(1)} kB / ${(budget / KB).toFixed(0)} kB`;
  report.push(`${status.padEnd(4)} /driver startup, ${scripts.length} scripts (gzip)  ${sizes}`);
  if (gzip > budget)
    violations.push(
      `/driver startup: ${(gzip / KB).toFixed(1)} kB gzip exceeds ${(budget / KB).toFixed(0)} kB`,
    );
} else {
  violations.push("dist/index.html is missing, so the /driver startup budget cannot be measured");
}

console.log(report.join("\n"));
if (violations.length) {
  console.error("\nBUNDLE BUDGET VIOLATIONS:\n" + violations.join("\n"));
  process.exit(1);
}
console.log("\nAll chunks within budget.");
