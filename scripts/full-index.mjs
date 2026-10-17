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

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const noUpload = Boolean(flag("no-upload"));
const sample = typeof flag("sample") === "string" ? Number(flag("sample")) : null;
const diskFloor = typeof flag("disk-floor") === "string" ? Number(flag("disk-floor")) : null;
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
      "  --no-upload        build and validate locally, then stop (nothing is written to R2).",
      "  --sample <n>       SMOKE TEST ONLY: n records per source. The version is labelled PARTIAL",
      "                     and --activate is refused. Omit it for the complete dataset.",
      "  --verify-batch <n> objects read back per remote-verification call (default 400).",
      "  --disk-floor <mb>  free-space floor the merge stops at (default 512 MB). Lower it only when",
      "                     the volume is tight and the output is known to be small.",
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

function manifestPath() {
  return join(outputDir, "manifests", version, "manifest.json");
}

/** `bun <script> --flag` guarded so a missing binary is a clear message, not a crash. */
function tool(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

/**
 * Stage 1 — dependencies.
 *
 * A full run is hours long; failing here because `node_modules` is missing costs
 * seconds instead of an hour of downloading a 54 GB object first.
 */
function checkDependencies() {
  const bun = tool("bun", ["--version"]);
  if (!bun) {
    note("bun is not on PATH. Install it from https://bun.sh and re-run.");
    process.exit(2);
  }
  note(`bun ${bun}`);
  if (!existsSync(join(root, "node_modules"))) {
    note("node_modules is missing — run `bun install` first (the indexer needs no network beyond R2, but the CLI does need its dependencies).");
    process.exit(2);
  }
  const client = ["tools/indexer/src/r2.ts", "tools/indexer/src/build.ts", "tools/indexer/src/cli.ts", "scripts/full-index.mjs"];
  const missing = client.filter((file) => !existsSync(join(root, file)));
  if (missing.length) {
    note(`Source files are missing: ${missing.join(", ")}. This is not a complete checkout.`);
    process.exit(2);
  }
  note("dependencies present");
}

/**
 * Stage 2 — which source version is being run.
 *
 * A full index is reproducible only if the revision that built it is known, so the
 * commit (and whether the tree was dirty) is recorded in the run report. Git is
 * optional: a source archive has no `.git` and that is reported as such, not faked.
 */
function sourceVersion() {
  const commit = tool("git", ["rev-parse", "HEAD"]);
  if (!commit) {
    note("source version: no git metadata in this checkout (running from an archive)");
    return { commit: null, dirty: null };
  }
  const status = tool("git", ["status", "--porcelain"]);
  const dirty = status === null ? null : status.length > 0;
  note(`source version: ${commit.slice(0, 12)}${dirty ? " (working tree has uncommitted changes)" : " (clean)"}`);
  return { commit, dirty };
}

/**
 * Stage 8 — resume state, reported BEFORE any reading starts.
 *
 * "Resumable" is only useful if the operator can see what will be reused. This prints
 * the checkpoint's stage and counters and the spool manifest's partition count, so
 * `elapsed` dropping later is explained rather than surprising.
 */
function resumeStatus() {
  const workDir = resolve(root, config.workDir ?? ".indexer-work");
  const checkpointPath = join(workDir, "checkpoint.json");
  const manifestFile = join(workDir, "spool-manifest.json");
  if (!existsSync(checkpointPath)) {
    note("no checkpoint: this run starts from Pass 1 (both sources are read end to end)");
    return { found: false };
  }
  let checkpoint = null;
  try {
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    checkpoint = null;
  }
  const partitions = existsSync(manifestFile)
    ? Object.keys(JSON.parse(readFileSync(manifestFile, "utf8")).partitions ?? {}).length
    : 0;
  const sample = checkpoint?.identity?.sampleLimit ?? null;
  note(
    `checkpoint found: stage ${checkpoint?.stage ?? "unknown"}, version ${checkpoint?.identity?.version ?? "?"}, ` +
      `sample ${sample === null ? "none (full)" : sample}, ${partitions} spooled partition(s)`,
  );
  if (sample !== null) {
    note(
      "  NOTE: that checkpoint belongs to a SAMPLE run. A full run cannot resume it — Pass 1 will be rebuilt " +
        "(the existing spool is left untouched; use a separate workDir if you want to keep it).",
    );
  }
  return { found: true, stage: checkpoint?.stage ?? null, sampleLimit: sample, partitions };
}

/**
 * Cost estimate, in the units Cloudflare actually bills.
 *
 * R2 Standard (2026): storage $0.015 per GB-month, Class A operations $4.50 per
 * million, Class B operations $0.36 per million, egress free. The numbers printed
 * before the run are per-GB/per-object so the operator can multiply them by the
 * real index size instead of trusting an extrapolation.
 */
const R2_PRICES = { storagePerGbMonth: 0.015, classAPerMillion: 4.5, classBPerMillion: 0.36 };

function costLine(objectCount, bytes) {
  const gb = bytes / 1e9;
  const writeCost = (objectCount / 1e6) * R2_PRICES.classAPerMillion;
  return (
    `${gb.toFixed(2)} GB · ${objectCount.toLocaleString()} object(s) · ` +
    `~$${(gb * R2_PRICES.storagePerGbMonth).toFixed(2)}/month storage · ` +
    `~$${writeCost.toFixed(2)} to upload once (Class A) · ` +
    `~$${((objectCount / 1e6) * R2_PRICES.classBPerMillion).toFixed(4)} per full verification pass (Class B)`
  );
}

function estimateLine() {
  note(
    [
      "cost estimate (R2 Standard, from Cloudflare's published prices):",
      "  a full index is expected in the 9–20 GB range (preflight prints its own estimate). At 20 GB:",
      `    storage        ~$${(20 * R2_PRICES.storagePerGbMonth).toFixed(2)}/month`,
      `    one upload     ~$${(((20e9 / 40e6) * 24) / 1e6 * R2_PRICES.classAPerMillion).toFixed(2)} of Class A writes (≈12,000 objects at ~1.7 MB each)`,
      `    one read pass  ~$${((12000 / 1e6) * R2_PRICES.classBPerMillion).toFixed(4)} of Class B reads`,
      "  egress is free, and search only ever reads shards and partitions, never the source objects.",
    ].join("\n"),
  );
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

/* Stages 1–3 of the pipeline: dependencies, source version, cost expectation. */
note("\n-- 1/20 dependencies");
checkDependencies();
note("\n-- 2/20 source version");
const source = sourceVersion();
note("\n-- 3/20 cost expectation");
estimateLine();
note("\n-- 4/20 resume state");
const resume = resumeStatus();

/*
 * Preflight first, always. It verifies R2 credentials and the source objects
 * actually exist, that the configured columns map onto the real headers, and that
 * this machine has the disk and RAM for the run — the cheapest possible way to
 * learn that the 64 GB job would fail in hour three.
 */
const preflightArgs = ["run", "--config", configPath, "--preflight-only", "--version", version];
// The preflight estimate has to describe the run that will follow: without this, a
// smoke test would be measured as if it were the 64 GB job and refuse to start.
if (sample !== null) preflightArgs.push("--sample", String(sample));
if (!(await stage("preflight (auth, sources, schema mapping, disk, RAM)", preflightArgs))) {
  note("\nPreflight failed — nothing was indexed. Fix what it reported and re-run.");
  process.exit(1);
}
if (preflightOnly) {
  note("\nPreflight only: ready. Nothing was indexed or uploaded.");
  process.exit(0);
}

if (sample !== null && (!Number.isFinite(sample) || sample <= 0)) {
  console.error("--sample needs a positive number of records per source.");
  process.exit(2);
}
if (sample !== null) {
  note(
    `\n--sample ${sample} requested: this is a SMOKE TEST of the pipeline, not the full dataset.\n` +
      "  The version will be labelled PARTIAL and cannot be activated.",
  );
  if (activate) {
    note("  --sample and --activate contradict each other: refusing to activate a partial index.");
    process.exit(1);
  }
}
if (diskFloor !== null && (!Number.isFinite(diskFloor) || diskFloor <= 0)) {
  console.error("--disk-floor needs a positive number of megabytes.");
  process.exit(2);
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
  const runArgs = ["run", "--config", configPath, "--version", version];
  if (sample !== null) runArgs.push("--sample", String(sample));
  if (diskFloor !== null) runArgs.push("--disk-floor", String(diskFloor));
  if (!(await stage("index (Pass 1 + Pass 2 + local validation)", runArgs))) {
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
 * Coverage gate.
 *
 * "Passed validation" and "complete dataset" are different claims, and the run's own
 * checkpoint is the only place that knows which one this is: a checkpoint stores the
 * sample limit it was built with. When that is not null the version is a SAMPLE, and
 * activating it would silently replace a full dataset with a subset. So the run is
 * labelled, and activation is refused — while uploading is still allowed, because a
 * sample is a legitimate thing to publish under its own immutable version id.
 */
let coverage = { complete: false, sampleLimit: null };
{
  const workDir = resolve(root, config.workDir ?? ".indexer-work");
  const checkpointPath = join(workDir, "checkpoint.json");
  if (existsSync(checkpointPath)) {
    try {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      const sampleLimit = checkpoint?.identity?.sampleLimit ?? null;
      coverage = { complete: sampleLimit === null, sampleLimit };
    } catch {
      coverage = { complete: false, sampleLimit: null };
    }
  }
}
if (resume.sampleLimit !== null && coverage.complete) {
  // The full run rebuilt Pass 1 over the sources, so the sample checkpoint is gone.
  note("Pass 1 was rebuilt over the complete sources; the sample checkpoint is no longer in use.");
}
if (coverage.complete) {
  note("\nCoverage: COMPLETE — no sample limit is recorded for this run.");
} else {
  note(
    `\nCoverage: PARTIAL — this run carries a sample limit (${coverage.sampleLimit ?? "unknown"}) per source.\n` +
      "  It will be uploaded under its own version id, and ACTIVATION IS DISABLED: a sample must never replace the full dataset.",
  );
  if (activate) {
    note("  Refusing --activate for a partial index. Re-run without --sample for the complete dataset.");
    process.exit(1);
  }
}

if (noUpload) {
  note("\n--no-upload: nothing was written to R2. The version exists locally only.");
}

/*
 * Upload, then verify. `uploadOutput` skips an object whose remote size already
 * matches, so an interrupted upload is resumed by appending to the stored list;
 * the loop below makes that explicit and bounded.
 */
for (let attempt = 1; attempt <= 3 && !noUpload; attempt += 1) {
  if (!(await stage(`upload to R2 (attempt ${attempt})`, ["run", "--config", configPath, "--version", version, "--upload"]))) {
    note("\nUpload failed. It is resumable: re-run this script (or the same command) to continue where it stopped.");
    process.exit(1);
  }
  const progress = uploadedProgress();
  if (!progress || progress.stage === "completed") break;
  note("Upload reported an incomplete version; retrying the remaining objects.");
}

/*
 * Post-upload verification: read every object back FROM R2 and compare content.
 *
 * A local re-hash only proves the files on disk match their own record. This stage
 * runs `validate --remote` in bounded batches (each batch is one terminal call's worth
 * of work), so the check survives a large index and a slow link — and it ends by
 * confirming the uploaded manifest and validation report are present and passing,
 * which is exactly what `publish` will require.
 */
if (!noUpload) {
  const objectsFile = join(outputDir, "objects.jsonl");
  if (!existsSync(objectsFile)) {
    note(`\nNo ${objectsFile} — cannot verify remote objects.`);
    process.exit(1);
  }
  const total = readFileSync(objectsFile, "utf8").split("\n").filter((line) => line.trim()).length;
  const batch = Number(flag("verify-batch") ?? 400) || 400;
  note(`\n-- post-upload verification: ${total} object(s), ${batch} per batch`);
  for (let offset = 0; offset < total; offset += batch) {
    const limit = Math.min(batch, total - offset);
    if (
      !(await stage(`verify objects ${offset + 1}–${offset + limit} of ${total} from R2`, [
        "validate", "--config", configPath, "--version", version, "--remote",
        "--offset", String(offset), "--limit", String(limit),
      ]))
    ) {
      note("\nPost-upload verification reported problems. Nothing was activated.");
      process.exit(1);
    }
  }
}

if (activate && !noUpload) {
  if (!(await stage("activate (flip manifests/active.json)", ["publish", "--config", configPath, "--version", version, "--yes"]))) {
    note("\nActivation failed. The uploaded version is complete and unchanged; activate it later from the Dataset page.");
    process.exit(1);
  }
  note(`\nActivated ${version}. The application now serves it.`);
} else if (!noUpload) {
  note(
    `\nUploaded and verified ${version}, but it is NOT active.\n` +
      "  Activate it when you are ready with:  bun run index:full -- --version " +
      version +
      " --activate --yes --upload-only\n" +
      "  (or from the Dataset page).",
  );
}

const manifestFile = manifestPath();
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
const counters = manifest?.counters ?? null;
const summary = {
  version,
  activated: activate && coverage.complete,
  coverage: coverage.complete ? "complete" : `sample (${coverage.sampleLimit} per source)`,
  sourceVersion: source,
  resume,
  stages,
  counters,
  objects: manifest?.objectCount ?? null,
  bytes: manifest?.bytes ?? null,
  cost: manifest ? costLine(Number(manifest.objectCount ?? 0), Number(manifest.bytes ?? 0)) : null,
  report: reportPath,
  finishedAt: new Date().toISOString(),
};
writeFileSync(join(reportDir, `full-index-${version}.json`), JSON.stringify(summary, null, 2), "utf8");

console.log("\n=== summary ===");
for (const entry of stages) {
  console.log(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.seconds ? ` (${entry.seconds}s)` : ""}`);
}
if (counters) {
  console.log(
    `  ${Number(counters.rowsRead).toLocaleString()} rows read · ${Number(counters.rowsRejected).toLocaleString()} rejected · ` +
      `${Number(counters.uniqueCompanies).toLocaleString()} companies · ${Number(counters.uniqueContacts).toLocaleString()} contacts`,
  );
}
if (manifest) {
  console.log(
    `  ${Number(manifest.objectCount).toLocaleString()} objects · ${(Number(manifest.bytes) / 1e9).toFixed(2)} GB · ` +
      `format v${manifest.indexFormatVersion ?? "?"} · validation ${manifest.validationPassed ? "passed" : "FAILED"}`,
  );
  console.log(`  cost  ${costLine(Number(manifest.objectCount), Number(manifest.bytes))}`);
}
console.log(`  coverage  ${summary.coverage}`);
console.log(`  activated ${summary.activated ? "yes" : "no"}`);
console.log(`  report ${reportPath}`);
