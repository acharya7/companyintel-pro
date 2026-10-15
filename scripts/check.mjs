#!/usr/bin/env node
/**
 * CompanyIntel QA gate.
 *
 *   bun run check
 *
 * Runs, in order, and reports PASS/FAIL for each:
 *   1. frontend + shared   tsc -b --noEmit
 *   2. Cloudflare Worker   tsc -p worker/tsconfig.json --noEmit
 *   3. local indexer       tsc -p tools/indexer/tsconfig.json --noEmit
 *   4. read-only R2 probe  tsc -p probe/tsconfig.json --noEmit
 *   5. test suite          bun test
 *
 * Exits non-zero if anything fails. It deliberately does NOT run a production
 * build (that is a separate, explicit step: `bun run build`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tsc = resolve(root, "node_modules/.bin/tsc");
const bunBin = process.versions.bun ? process.execPath : "bun";

const steps = [
  { name: "typecheck frontend + shared", cmd: tsc, args: ["-b", "--noEmit"] },
  { name: "typecheck worker", cmd: tsc, args: ["-p", "worker/tsconfig.json", "--noEmit"] },
  { name: "typecheck indexer", cmd: tsc, args: ["-p", "tools/indexer/tsconfig.json", "--noEmit"] },
  { name: "typecheck probe", cmd: tsc, args: ["-p", "probe/tsconfig.json", "--noEmit"] },
  { name: "tests", cmd: bunBin, args: ["test"] },
];

const results = [];

for (const step of steps) {
  if (step.cmd === tsc && !existsSync(tsc)) {
    results.push({ ...step, status: "SKIPPED", note: "typescript is not installed — run `bun install`" });
    continue;
  }
  process.stdout.write(`\n=== ${step.name} (${step.cmd.split(/[\\/]/).pop()} ${step.args.join(" ")}) ===\n`);
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args, { cwd: root, stdio: "inherit", shell: false });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    results.push({ ...step, status: "FAIL", note: result.error.message });
  } else {
    results.push({ ...step, status: result.status === 0 ? "PASS" : "FAIL", note: `${seconds}s` });
  }
}

console.log("\n=== summary ===");
let failed = 0;
for (const result of results) {
  if (result.status === "FAIL") failed += 1;
  console.log(`${result.status.padEnd(7)} ${result.name}${result.note ? `  (${result.note})` : ""}`);
}
process.exitCode = failed > 0 ? 1 : 0;
