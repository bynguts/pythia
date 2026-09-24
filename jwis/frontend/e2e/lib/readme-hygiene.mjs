#!/usr/bin/env node
/**
 * #88: README hygiene gate — the README must not hardcode an E2E test count
 * (or any "N tests pass" claim) that goes stale as scenarios are added.
 *
 * Run from anywhere:  node jwis/frontend/e2e/lib/readme-hygiene.mjs
 * Exit 1 prints the offending lines.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../");
const readme = join(root, "README.md");
const text = readFileSync(readme, "utf8");

const offenders = [];
text.split("\n").forEach((line, i) => {
  // "42 tests", "45 passed", "N tests, headless" — hardcoded pass/count claims.
  if (/\*\*\d+\s+(tests?|passed|failed)\*\*/i.test(line) ||
      /\b\d+\s+tests?,\s*(headless|all|zero)/i.test(line) ||
      /\ball\s+\d+\s+tests?\s+pass/i.test(line)) {
    offenders.push(`README.md:${i + 1}: ${line.trim()}`);
  }
});

if (offenders.length) {
  console.error("README hardcodes a manually maintained E2E test count (issue #88):");
  for (const o of offenders) console.error("  " + o);
  console.error("\nReplace stale counts with the command to reproduce, and link CI artifacts for status.");
  process.exit(1);
}
console.log("README hygiene OK: no hardcoded test counts.");
