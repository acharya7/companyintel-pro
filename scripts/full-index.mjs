#!/usr/bin/env node
/**
 * CompanyIntel — one command for the COMPLETE dataset.
 *
 *   bun run index:full -- --version v1-full-2026-10-17 --yes
 *   bun run index:full -- --version v1-full-2026-10-17 --yes --activate
 *   bun run index:full -- --version v1-full-2026-10-17 --yes --upload-only
 *   bun run index:full -- --version v1-full-2026-10-17 --preflight-only
 *
 * WHY IT EXISTS
 * -------------
 * A full run is not one step, it is a pipeline: preflight, Pass 1, Pass 2,
 * validation, upload, post-upload verification and (optionally) activation. Driven
 * by hand it becomes a long sequence of PowerShell commands, and every one of them
 * is a chance to type the wrong version id, to re-run with `--no-resume` and throw
 * away hours of spooled work, or to publish a version that never passed validation.
 *
 * This script runs the pipeline in order, stops at the first problem, and is
 * RESUMABLE at every stage: the indexer's own checkpoint resumes Pass 2, its upload
 * skips objects already present with the right size, and re-running this script
 * after an interruption continues from where it stopped. It never passes
 * `--no-resume`, never deletes a spool and never overwrites a published version.
 *
 * WHAT IT REFUSES TO DO WITHOUT EXPLICIT APPROVAL
 * -----------------------------------------------
 *   - start the material run without `--yes` (the full corpus is ~64 GB: it costs
 *     hours of local CPU/disk and, on upload, real R2 requests),
 *   - activate the version without `--activate` (activation is what the app serves;
 *     it is a separate, deliberate decision — the Dataset page can do it too),
 *   - upload anything for a version whose validation did not pass.
 *
 * Exit codes: 0 = every requested stage succeeded, 1 = a stage failed (the message
 * says which), 2 = the arguments are wrong or a required file is missing.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const configPath = resolve(root, String(flag("config") ?? "tools/indexer/indexer.config.json"));
const version = typeof flag("version") === "string" ? flag("version") : null;
const confirmed = Boolean(flag("yes"));
const activate = Boolean(flag("activate"));
const preflightOnly = Boolean(flag("preflight-only"));
const uploadOnly = Boolean(flag("upload-only"));
const reportDir = resolve(root, String(flag("report-dir") ?? "index-reports"));

if (flag("help")) {
  console.log(
    [
      "CompanyIntel full-dataset index pipeline",
      "",
      "  bun run index:full -- --version <id> [--yes] [--activate] [--upload-only] [--preflight-only]",
      "                        [--config <path>] [--report-dir <dir>]",
      "",
      "  --version <id>     REQUIRED. Immutable output prefix; re-running resumes it.",
      "  --yes              approve the material run (full corpus: hours of CPU/disk + R2 upload).",
      "  --activate         flip manifests/active.json to this version after verification.",
      "  --upload-only      skip indexing; upload/verify an already-built local version.",
      "  --preflight-only   check auth, sources, mapping, disk and RAM, then stop.",
      "  --config <path>    indexer config (default tools/indexer/indexer.config.json).",
      "  --report-dir <dir> where the run log and JSON summary are written (default index-reports).",
      "",
      "Every stage is resumable; this script never passes --no-resume and never deletes a spool.",
    ].join("\n"),
  );
  process.exit(0);
}

if (!version) {
  console.error(
    "A version id is required: --version v1-full-<date>.\n" +
      "  It names the immutable output prefix, so a re-run resumes the same version instead of starting a second one.",
  );
  process.exit(2);
}
if (!existsSync(configPath)) {
  console.error(`No indexer config at ${configPath}.`);
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const outputDir = resolve(root, config.outputDir ?? ".indexer-output");
const reportPath = join(reportDir, `full-index-${version}.log`);
mkdirSync(reportDir, { recursive: true });

const stages = [];

/** Run one indexer CLI stage, streaming its output into the report file. */
function stage(name, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    console.log(`\n=== ${name} ===`);
    console.log(`  bun tools/indexer/src/cli.ts ${args.join(" ")}`);
    const child = spawn("bun", ["tools/indexer/src/cli.ts", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const forward = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      appendFileSync(reportPath, text, "utf8");
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => {
      stages.push({ name, ok: false, seconds: 0, error: error.message });
      resolvePromise(false);
    });
    child.on("close", (code) => {
      const ok = code === 0 || allowFailure;
      stages.push({ name, ok, exitCode: code, seconds: Math.round((Date.now() - startedAt) / 1000) });
      resolvePromise(ok);
    });
  });
}

function note(line) {
  console.log(line);
  appendFileSync(reportPath, `${line}\n`, "utf8");
}

function validationPath() {
  return join(outputDir, "manifests", version, "validation.json");
}

function uploadedProgress() {
  const path = join(outputDir, "manifests", version, "progress.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* --------------------------------- stages --------------------------------- */

console.log(`CompanyIntel full index — version ${version}`);
console.log(`  config   ${configPath}`);
console.log(`  output   ${outputDir}`);
console.log(`  report   ${reportPath}`);

/*
 * Preflight first, always. It verifies R2 credentials and the source objects
 * actually exist, that the configured columns map onto the real headers, and that
 * this machine has the disk and RAM for the run — the cheapest possible way to
 * learn that the 64 GB job would fail in hour three.
 */
if (!(await stage("preflight (auth, sources, schema mapping, disk, RAM)", ["run", "--config", configPath, "--preflight-only", "--version", version]))) {
  note("\nPreflight failed — nothing was indexed. Fix what it reported and re-run.");
  process.exit(1);
}
if (preflightOnly) {
  note("\nPreflight only: ready. Nothing was indexed or uploaded.");
  process.exit(0);
}

if (!confirmed && !uploadOnly) {
  note(
    "\nRefusing to start the full run without --yes.\n" +
      "  A full pass reads both source files end to end (~64 GB), writes a Pass 1 spool of comparable size,\n" +
      "  and uploads the generated index to R2. Re-run with --yes once you are ready for that.",
  );
  process.exit(1);
}

if (!uploadOnly) {
  /*
   * Index + validate. `run` without `--upload` builds and validates locally first,
   * so a broken index never reaches the bucket. Interrupting it is safe: the
   * checkpoint (Pass 1) and the merge checkpoint (Pass 2) both resume.
   */
  if (!(await stage("index (Pass 1 + Pass 2 + local validation)", ["run", "--config", configPath, "--version", version]))) {
    note("\nIndexing stopped. The spool and checkpoint are intact — re-run this script to RESUME (never --no-resume).");
    process.exit(1);
  }
  if (!existsSync(validationPath())) {
    note(`\nNo validation report at ${validationPath()} — refusing to upload an unvalidated version.`);
    process.exit(1);
  }
  const validation = JSON.parse(readFileSync(validationPath(), "utf8"));
  if (!validation.passed) {
    note(`\nVersion ${version} FAILED validation; nothing was uploaded. Inspect ${validationPath()}.`);
    process.exit(1);
  }
  note(`Validation passed for ${version}.`);
}

/*
 * Upload, then verify. `uploadOutput` skips an object whose remote size already
 * matches, so an interrupted upload is resumed by appending to the stored list;
 * the loop below makes that explicit and bounded.
 */
for (let attempt = 1; attempt <= 3; attempt += 1) {
  if (!(await stage(`upload to R2 (attempt ${attempt})`, ["run", "--config", configPath, "--version", version, "--upload"]))) {
    note("\nUpload failed. It is resumable: re-run this script (or the same command) to continue where it stopped.");
    process.exit(1);
  }
  const progress = uploadedProgress();
  if (!progress || progress.stage === "completed") break;
  note("Upload reported an incomplete version; retrying the remaining objects.");
}

if (!(await stage("post-upload verification (read every object back)", ["validate", "--config", configPath, "--version", version]))) {
  note("\nPost-upload verification reported problems. Nothing was activated.");
  process.exit(1);
}

if (activate) {
  if (!(await stage("activate (flip manifests/active.json)", ["publish", "--config", configPath, "--version", version, "--yes"]))) {
    note("\nActivation failed. The uploaded version is complete and unchanged; activate it later from the Dataset page.");
    process.exit(1);
  }
  note(`\nActivated ${version}. The application now serves it.`);
} else {
  note(
    `\nUploaded and verified ${version}, but it is NOT active.\n` +
      "  Activate it when you are ready with:  bun run index:full -- --version " +
      version +
      " --activate --yes --upload-only\n" +
      "  (or from the Dataset page).",
  );
}

const manifestPath = join(outputDir, "manifests", version, "manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const summary = {
  version,
  activated: activate,
  stages,
  counters: manifest?.counters ?? null,
  objects: manifest?.objectCount ?? null,
  bytes: manifest?.bytes ?? null,
  report: reportPath,
  finishedAt: new Date().toISOString(),
};
writeFileSync(join(reportDir, `full-index-${version}.json`), JSON.stringify(summary, null, 2), "utf8");

console.log("\n=== summary ===");
for (const entry of stages) {
  console.log(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.seconds ? ` (${entry.seconds}s)` : ""}`);
}
if (manifest) {
  console.log(
    `  ${Number(manifest.counters.uniqueCompanies).toLocaleString()} companies · ` +
      `${Number(manifest.counters.uniqueContacts).toLocaleString()} contacts · ` +
      `${Number(manifest.objectCount).toLocaleString()} objects · ${(Number(manifest.bytes) / 1e9).toFixed(2)} GB`,
  );
}
console.log(`  report ${reportPath}`);
