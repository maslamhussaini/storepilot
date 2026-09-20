#!/usr/bin/env node
// Regression guard for the Tailwind v4 malformed-`var(...)` CSS build crash
// (StorePilot Phase 1B.1 / 1B.2). Fails if the literal placeholder pattern
// `var(...)` (a literal ellipsis, not a real CSS custom property) appears
// anywhere in the application source tree or in generated CSS, and fails if
// any `.next` build output actually contains a malformed
// `background-color: var(...)` declaration. Does not flag legitimate CSS
// variables such as `var(--sp-something)`.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

// The literal ellipsis placeholder — never a valid CSS var() reference.
// `var(--sp-something)` (a real custom-property name) is legitimate and
// must NOT be flagged; only a literal `...` inside var() is malformed.
const MALFORMED_VAR = /var\(\s*\.\.\.\s*\)/;
// The specific illustrative/placeholder shape that previously broke the
// build when it leaked into scanned source: an arbitrary-value background
// candidate whose "variable name" is itself the literal ellipsis.
const ARBITRARY_VAR_CANDIDATE = /\[var\(\s*\.\.\.\s*\)\]/;

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".mdx", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".vscode", ".kilo"]);

/** @param {string} dir */
function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, results);
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

// Scan both the application source tree (the Tailwind candidate boundary
// itself, verified separately below) and docs/README — not because docs are
// part of Tailwind's scan boundary any more, but because this exact bug
// twice originated as illustrative text in docs/PHASE1_FOUNDATION_REPORT.md,
// so it's worth guarding directly regardless of the CSS boundary.
const scanRoots = [join(root, "src"), join(root, "docs")].filter(existsSync);
const files = scanRoots.flatMap((dir) => walk(dir));
const readmePath = join(root, "README.md");
if (existsSync(readmePath)) files.push(readmePath);

let failures = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (MALFORMED_VAR.test(line)) {
      failures.push(`${file}:${i + 1}: contains malformed placeholder "var(...)" — ${line.trim()}`);
    }
    if (ARBITRARY_VAR_CANDIDATE.test(line)) {
      failures.push(`${file}:${i + 1}: contains "[var(...)]" placeholder shape — this is the exact malformed pattern that broke the build previously — ${line.trim()}`);
    }
  });
}

// If a production build has run, also verify no generated CSS actually
// contains the malformed declaration Tailwind would emit from such a token.
const nextStaticCss = join(root, ".next", "static", "chunks");
if (existsSync(nextStaticCss)) {
  const cssFiles = walk(nextStaticCss).filter((f) => f.endsWith(".css"));
  for (const file of cssFiles) {
    const content = readFileSync(file, "utf8");
    if (/background-color:\s*var\(\.\.\.\)/.test(content)) {
      failures.push(`${file}: generated CSS contains malformed "background-color: var(...)" declaration`);
    }
  }
}

if (failures.length > 0) {
  console.error("check:css FAILED — malformed var(...)/bg-[var( pattern found:\n");
  for (const f of failures) console.error("  " + f);
  console.error(`\n${failures.length} issue(s) found.`);
  process.exit(1);
}

console.log(`check:css passed — scanned ${files.length} source file(s), no malformed var(...) or bg-[var( candidates found.`);
