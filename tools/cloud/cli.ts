#!/usr/bin/env bun
/**
 * Cloud indexing CLI.
 *
 * This is the executable a Cloudflare Container runs (the container image's
 * entrypoint is a thin wrapper around `run`). It is also the only way a bounded
 * benchmark is started in this workspace, so the numbers in `docs/cloud.md` come
 * from the same code path that would process the full corpus.
 *
 * Commands
 *   preflight   HEAD both sources, read their headers, print the plan and the
 *               measured storage ratios. Writes nothing but a state object.
 *   benchmark   Process N bytes of EACH source, verify every segment, then print
 *               measured throughput/R2 usage and low/expected/high cost forecast.
 *   run         Process from the recorded checkpoint (bounded or full).
 *   status      Print the durable job state.
 *   pause|resume|abort   Set the control flags the engine reads between chunks.
 *   verify      Re-read every segment and check coverage, checksums and counts.
 *
 * A full run (no `--max-source-mb`) additionally requires `--approve-full`,
 * which refuses unless `control.json` already records operator approval. This is
 * deliberate: the 64 GB job may not be started by a typo or a cron.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { R2Client, credentialsFromEnv } from "../indexer/src/r2";
import type { IndexerConfig } from "../indexer/src/build";
import {
  CLOUD_CONTROL_VERSION,
  cloudKeys,
  type CloudControl,
  type CloudJobState,
} from "../../src/shared/cloud/types";

import { assembleRun } from "./assemble";
import { forecast, type BenchmarkMeasurement } from "./cost";
import { cloudSourcesFromConfig, runPass1, verifyRun } from "./pass1";
import { runCloudPass2 } from "./pass2";
import { R2BlobStore } from "./store";

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");

function flag(name: string): string | true | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function num(name: string): number | null {
  const value = flag(name);
  return typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function configPath(): string {
  const path = typeof flag("config") === "string" ? String(flag("config")) : "tools/indexer/indexer.config.json";
  return resolve(root, path);
}

function loadConfig(): { config: IndexerConfig; path: string } {
  const path = configPath();
  if (!existsSync(path)) throw new Error(`No indexer config at ${path}.`);
  const config = JSON.parse(readFileSync(path, "utf8")) as IndexerConfig;
  if (!config.sources?.length) throw new Error("The config has no sources.");
  return { config, path };
}

function storeFor(): R2BlobStore {
  const credentials = credentialsFromEnv();
  if (!credentials) {
    throw new Error(
      "No R2 credentials. Set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (or the private .r2-credentials.json).",
    );
  }
  return new R2BlobStore(new R2Client(credentials));
}

function version(): string {
  const value = flag("version");
  if (typeof value !== "string" || !value.trim()) throw new Error("--version <id> is required.");
  return value;
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function hhmm(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function preflight(store: R2BlobStore): Promise<void> {
  const { config } = loadConfig();
  const sources = cloudSourcesFromConfig(config);
  let total = 0;
  console.log("\nCloud preflight (read-only)");
  for (const source of sources) {
    const head = await store.head(source.key);
    if (!head.exists || head.size === null) throw new Error(`Source ${source.id} is missing at ${source.key}.`);
    total += head.size;
    console.log(`  ok  ${source.id}  ${gb(head.size)}  r2://<bucket>/${source.key}  etag ${head.etag ?? "?"}`);
  }
  console.log(`  input total            ${gb(total)}`);
  console.log(`  partitions             ${config.partitions}`);
  console.log("  row encoding           format v2 positional rows (one copy, no field names)");
  console.log("  chunking               record-boundary exact, quote- and UTF-8-safe");
  console.log("\nNothing was read in bulk and nothing was written.\n");
}

async function runCommand(store: R2BlobStore): Promise<void> {
  const id = version();
  const { config } = loadConfig();
  const sources = cloudSourcesFromConfig(config);
  const maxMb = num("max-source-mb");
  const approveFull = Boolean(flag("approve-full"));

  if (maxMb === null && !approveFull) {
    throw new Error(
      "Refusing to run the FULL corpus. Pass --max-source-mb <n> for a bounded benchmark, or --approve-full after\n" +
        "  reviewing the forecast and recording approval in control.json. The 64 GB job is not started by accident.",
    );
  }
  if (approveFull) {
    const control = await store.getJson<CloudControl>(cloudKeys.control(id));
    if (!control?.approvedFullRun) {
      throw new Error(
        `control.json for ${id} does not record approval (approvedFullRun=false). Run the bounded benchmark, review the\n` +
          "  forecast, then set approval explicitly.",
      );
    }
  }

  const partitions = num("partitions") ?? config.partitions;
  if (maxMb === null && partitions !== config.partitions) {
    throw new Error(`--partitions must equal the configured ${config.partitions} for a full run; it exists for bounded benchmarks only.`);
  }
  const result = await runPass1({
    store,
    version: id,
    sources,
    partitions,
    chunkBytes: (num("chunk-mb") ?? 128) * 1024 * 1024,
    maxSourceBytes: maxMb === null ? undefined : maxMb * 1024 * 1024,
    mode: maxMb === null ? "full" : "benchmark",
    onLog: (line) => console.log(`  ${line}`),
  });
  console.log(`\nStage: ${result.state.stage} · ${result.stopped}`);
  printState(result.state);
  if (maxMb === null && result.stopped === "complete") {
    console.log("\nPass 1 complete. The next stage merges these verified segments (see docs/cloud.md).");
  }
}

async function benchmark(store: R2BlobStore): Promise<void> {
  const id = version();
  const { config } = loadConfig();
  const sources = cloudSourcesFromConfig(config);
  const maxMb = num("max-source-mb") ?? 64;
  const started = Date.now();
  const before = store.countersSnapshot();
  // A benchmark may use fewer partitions so the sandbox's R2 round-trip latency
  // does not turn a small sample into hundreds of sequential PUT+GET pairs. The
  // request counts are scaled back to the production partition count below.
  const benchPartitions = num("partitions") ?? config.partitions;
  const partitionScale = config.partitions / benchPartitions;

  const result = await runPass1({
    store,
    version: id,
    sources,
    partitions: benchPartitions,
    chunkBytes: (num("chunk-mb") ?? 32) * 1024 * 1024,
    maxSourceBytes: maxMb * 1024 * 1024,
    mode: "benchmark",
    onLog: (line) => console.log(`  ${line}`),
  });
  const seconds = Math.max(0.001, (Date.now() - started) / 1000);
  const after = store.countersSnapshot();

  console.log("\nVerifying every uploaded segment from R2 (independent of the writer)…");
  const verification = await verifyRun({ store, version: id, sources });
  // A bounded benchmark covers a prefix, so `verifyRun`'s "covers the whole
  // object" check is expected to fail; report the properties that must hold.
  const coverageProblems = verification.problems.filter((problem) => problem.includes("chunks cover"));
  const realProblems = verification.problems.filter((problem) => !problem.includes("chunks cover"));
  const ok = realProblems.length === 0;

  const measurement: BenchmarkMeasurement = {
    sourceBytes: result.state.totals.sourceBytesRead,
    seconds,
    rows: result.state.totals.rowsRead,
    rejected: result.state.totals.rowsRejected,
    segmentBytes: result.state.totals.segmentBytes,
    // Normalised to the production partition count: the operator approves a
    // forecast for 256 partitions, not for the benchmark's reduced layout.
    segments: Math.round(result.state.totals.segments * partitionScale),
    classA: Math.round((after.classA - before.classA) * partitionScale),
    classB: Math.round((after.classB - before.classB) * partitionScale),
    bytesRead: after.bytesRead - before.bytesRead,
    bytesWritten: after.bytesWritten - before.bytesWritten,
  };

  // Corpus size is read from the objects themselves, not guessed.
  let totalCorpus = 0;
  for (const source of sources) {
    const head = await store.head(source.key);
    totalCorpus += head.size ?? 0;
  }
  const options = { corpusBytes: totalCorpus, corpusRows: Math.round((measurement.rows / measurement.sourceBytes) * totalCorpus) };
  const scenarios = (["low", "expected", "high"] as const).map((scenario) => forecast(measurement, options, scenario));

  const report = {
    version: id,
    generatedAt: new Date().toISOString(),
    mode: "bounded real-R2 benchmark",
    perSourceBytes: maxMb * 1024 * 1024,
    measurement: {
      ...measurement,
      benchmarkPartitions: benchPartitions,
      productionPartitions: config.partitions,
      objectCountsScaledBy: partitionScale,
      rowsPerSecond: measurement.rows / seconds,
      sourceMbPerSecond: measurement.sourceBytes / seconds / 1e6,
      spoolRatio: measurement.segmentBytes / Math.max(1, measurement.sourceBytes),
      segmentsPer1000Rows: (measurement.segments / Math.max(1, measurement.rows)) * 1000,
      classAPer1000Rows: (measurement.classA / Math.max(1, measurement.rows)) * 1000,
      classBPer1000Rows: (measurement.classB / Math.max(1, measurement.rows)) * 1000,
      verificationOk: ok,
      coverageNote: coverageProblems.length ? "bounded prefix (expected)" : "full source",
    },
    corpus: { bytes: totalCorpus, projectedRows: options.corpusRows },
    forecasts: scenarios,
    note:
      "Sandbox timings (1 shared vCPU, network-bound R2 reads), NOT container timings. Pass 2 is an estimate, not a measurement. " +
      "Allowances are the published Workers Paid monthly inclusions.",
  };

  const reportPath = resolve(root, typeof flag("report") === "string" ? String(flag("report")) : `index-reports/cloud-benchmark-${id}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("\nCloud Pass 1 benchmark (bounded, real R2 objects)");
  console.log(`  source read            ${gb(measurement.sourceBytes)} in ${seconds.toFixed(1)} s`);
  console.log(`  rows                   ${measurement.rows.toLocaleString()} (${measurement.rejected.toLocaleString()} rejected)`);
  console.log(`  throughput             ${(measurement.rows / seconds).toFixed(0)} rows/s · ${(measurement.sourceBytes / seconds / 1e6).toFixed(1)} MB/s`);
  console.log(`  spool                  ${gb(measurement.segmentBytes)} (${(report.measurement.spoolRatio * 100).toFixed(1)}% of source)`);
  console.log(`  segments               ${measurement.segments.toLocaleString()} objects`);
  console.log(`  R2 Class A / Class B   ${measurement.classA.toLocaleString()} / ${measurement.classB.toLocaleString()}`);
  console.log(`  segment verification   ${ok ? "PASSED (every sha256 + row count)" : `FAILED: ${realProblems.join("; ")}`}`);
  console.log(`  report                 ${reportPath}`);
  for (const scenario of scenarios) {
    console.log(
      `\n  ${scenario.scenario.toUpperCase()} forecast: ${hhmm(scenario.pass1.wallSeconds)} pass 1 + ` +
        `${hhmm(scenario.pass2.wallSeconds)} pass 2 · spool ${gb(scenario.pass1.spoolBytes)} · ` +
        `~$${scenario.billableUsd.toFixed(2)} incremental`,
    );
  }
  console.log("\nFull-run execution remains blocked pending your approval (control.json approvedFullRun).\n");
}

async function status(store: R2BlobStore): Promise<void> {
  const id = version();
  const state = await store.getJson<CloudJobState>(cloudKeys.state(id));
  if (!state) {
    if (flag("json")) console.log(JSON.stringify({ version: id, state: null }));
    else console.log(`No cloud job state at ${cloudKeys.state(id)}.`);
    return;
  }
  if (flag("json")) {
    console.log(JSON.stringify({ version: id, state, control: await store.getJson<CloudControl>(cloudKeys.control(id)) }));
    return;
  }
  printState(state);
}

/** Every cloud job this bucket knows about, newest first (bounded by jobs run). */
async function listJobs(store: R2BlobStore): Promise<void> {
  const objects = (await store.list("cloud/jobs/")).filter((entry) => entry.key.endsWith("/state.json"));
  const jobs: { state: CloudJobState; control: CloudControl | null }[] = [];
  for (const object of objects) {
    const parsed = await store.getJson<CloudJobState>(object.key);
    if (!parsed) continue;
    jobs.push({ state: parsed, control: await store.getJson<CloudControl>(cloudKeys.control(parsed.version)) });
  }
  jobs.sort((a, b) => (b.state.updatedAt ?? "").localeCompare(a.state.updatedAt ?? ""));
  if (flag("json")) {
    console.log(JSON.stringify({ jobs }));
    return;
  }
  if (!jobs.length) {
    console.log("No cloud indexing jobs in this bucket.");
    return;
  }
  for (const job of jobs) {
    console.log(`${job.state.version.padEnd(36)} ${job.state.stage.padEnd(15)} ${job.state.totals.rowsRead.toLocaleString()} rows`);
  }
}

function printState(state: CloudJobState): void {
  console.log(`  version                ${state.version}`);
  console.log(`  stage                  ${state.stage}${state.note ? ` — ${state.note}` : ""}`);
  console.log(`  rows read              ${state.totals.rowsRead.toLocaleString()}`);
  console.log(`  rows indexed           ${state.totals.rowsIndexed.toLocaleString()}`);
  console.log(`  rejected               ${state.totals.rowsRejected.toLocaleString()}`);
  console.log(`  segments               ${state.totals.segments.toLocaleString()} (${gb(state.totals.segmentBytes)})`);
  console.log(`  source read            ${gb(state.totals.sourceBytesRead)}`);
  console.log(`  rate                   ${state.rate.rowsPerSecond?.toFixed(0) ?? "?"} rows/s · ETA ${state.rate.etaSeconds === null ? "?" : hhmm(state.rate.etaSeconds)}`);
  console.log(`  R2 requests            ${state.accounting.classA.toLocaleString()} A / ${state.accounting.classB.toLocaleString()} B`);
  console.log(`  estimated R2 cost      $${state.accounting.estimatedUsd.toFixed(4)}`);
  console.log(`  container time         ${state.accounting.containerSeconds.toFixed(0)} s (~$${state.accounting.containerUsd.toFixed(4)})`);
  for (const source of state.sources) {
    console.log(`  ${source.id.padEnd(22)} ${source.rows.toLocaleString()} rows · ${source.chunks} chunks · ${source.complete ? "complete" : `${gb(source.sourceBytes)} read`}`);
  }
  if (state.checkpoint) console.log(`  last checkpoint        ${state.checkpoint.at}`);
  for (const error of state.errors.slice(-3)) console.log(`  error                  ${error.message}`);
}

async function control(store: R2BlobStore, action: "pause" | "resume" | "abort" | "approve"): Promise<void> {
  const id = version();
  const existing = (await store.getJson<CloudControl>(cloudKeys.control(id))) ?? {
    version: CLOUD_CONTROL_VERSION,
    pause: false,
    abort: false,
    approvedFullRun: false,
    updatedAt: new Date().toISOString(),
  };
  const next: CloudControl = { ...existing, updatedAt: new Date().toISOString() };
  if (action === "pause") next.pause = true;
  if (action === "resume") {
    next.pause = false;
    next.abort = false;
  }
  if (action === "abort") next.abort = true;
  if (action === "approve") next.approvedFullRun = true;
  await store.putJson(cloudKeys.control(id), next);
  console.log(`control.json for ${id}: pause=${next.pause} abort=${next.abort} approvedFullRun=${next.approvedFullRun}`);
}

async function assemble(store: R2BlobStore): Promise<void> {
  const id = version();
  const { config } = loadConfig();
  const workDir = typeof flag("work-dir") === "string" ? String(flag("work-dir")) : `.indexer-work-cloud-${id}`;
  const partitions = num("partitions") ?? config.partitions;
  const result = await assembleRun({
    store,
    version: id,
    config: { ...config, datasetVersion: id, partitions },
    workDir,
    onLog: (line) => console.log(`  ${line}`),
  });
  console.log(`\nAssembled ${result.partitions} partition(s), ${result.rows.toLocaleString()} rows, ${gb(result.bytes)} into ${result.workDir}`);
  console.log("The existing verified Pass 2 can now merge it with:\n");
  console.log(
    `  bun tools/indexer/src/cli.ts run --config <cfg with partitions=${result.partitions}> --work-dir ${result.workDir} --version ${id}`,
  );
}

/**
 * Cloud Pass 2: merge the verified Pass 1 segments without a full local spool.
 *
 * Only a job whose Pass 1 reached `pass1-complete` and whose version has no
 * manifest yet is accepted. Bounded benchmarks must pass the same `--partitions`
 * they were built with; partition count is part of the spool identity.
 */
async function pass2(store: R2BlobStore): Promise<void> {
  const id = version();
  const { config } = loadConfig();
  const partitions = num("partitions") ?? config.partitions;
  // The container's writable layer is small; scratch lives in its temp volume and
  // holds only the partition currently being merged.
  const workDir =
    typeof flag("work-dir") === "string" ? resolve(root, String(flag("work-dir"))) : join(tmpdir(), `companyintel-pass2-${id}`);
  console.log(`\nCloud Pass 2 — ${id}`);
  console.log(`  partitions             ${partitions}`);
  console.log(`  scratch                ${workDir} (one partition at a time)`);
  const before = store.countersSnapshot();
  const started = Date.now();
  const result = await runCloudPass2({
    store,
    version: id,
    config: { ...config, partitions, datasetVersion: id },
    workDir,
    allowBounded: Boolean(flag("allow-bounded")),
    onLog: (line) => console.log(`  ${line}`),
    onProgress: (event) => {
      if (event.stage === "pass2-merge" || event.stage === "validating") console.log(`  [${event.stage}] ${event.message}`);
    },
  });
  const after = store.countersSnapshot();
  const seconds = (Date.now() - started) / 1000;
  console.log("\nCloud Pass 2 result");
  console.log(`  stage                  ${result.stopped}`);
  console.log(`  partitions             ${result.partitions}`);
  console.log(`  rows                   ${result.rows.toLocaleString()}`);
  console.log(`  companies / contacts   ${result.companies.toLocaleString()} / ${result.contacts.toLocaleString()}`);
  console.log(`  index objects          ${result.indexObjects.toLocaleString()} (${gb(result.indexBytes)})`);
  console.log(`  shard objects          ${result.shardParts.toLocaleString()}`);
  console.log(`  time                   ${seconds.toFixed(1)} s`);
  console.log(`  R2 Class A / Class B   ${(after.classA - before.classA).toLocaleString()} / ${(after.classB - before.classB).toLocaleString()}`);
  console.log(`  R2 bytes read / wrote  ${gb(after.bytesRead - before.bytesRead)} / ${gb(after.bytesWritten - before.bytesWritten)}`);
  if (result.stopped !== "complete") process.exitCode = 2;
}

async function verify(store: R2BlobStore): Promise<void> {
  const id = version();
  const { config } = loadConfig();
  const report = await verifyRun({ store, version: id, sources: cloudSourcesFromConfig(config) });
  console.log(`\nCloud verification — ${id}`);
  console.log(`  chunks                 ${report.chunks.toLocaleString()}`);
  console.log(`  rows                   ${report.rows.toLocaleString()} (${report.rejected.toLocaleString()} rejected)`);
  console.log(`  segments               ${report.segments.toLocaleString()} (${gb(report.segmentBytes)})`);
  console.log(`  verdict                ${report.ok ? "PASS" : "FAIL"}`);
  for (const problem of report.problems.slice(0, 25)) console.log(`    - ${problem}`);
  process.exitCode = report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    console.log(
      [
        "CompanyIntel cloud indexer",
        "",
        "  preflight --config <cfg>",
        "  benchmark --version <id> [--max-source-mb 64] [--chunk-mb 32] [--report <path>]",
        "  run       --version <id> (--max-source-mb <n> | --approve-full) [--chunk-mb 128]",
        "  status    --version <id> [--json]",
        "  jobs      [--json]",
        "  pause | resume | abort | approve --version <id>",
        "  verify    --version <id> --config <cfg>",
        "  pass2     --version <id> --config <cfg> [--partitions <n>] [--work-dir <dir>] [--allow-bounded]",
        "  assemble  --version <id> [--work-dir <dir>] [--partitions <n>]",
        "",
        "Sources must be r2://<bucket>/<key>; the bucket comes from the credentials.",
      ].join("\n"),
    );
    return;
  }
  const store = storeFor();
  if (command === "preflight") return preflight(store);
  if (command === "benchmark") return benchmark(store);
  if (command === "run") return runCommand(store);
  if (command === "status") return status(store);
  if (command === "jobs") return listJobs(store);
  if (command === "verify") return verify(store);
  if (command === "assemble") return assemble(store);
  if (command === "pass2") return pass2(store);
  if (command === "pause" || command === "resume" || command === "abort" || command === "approve") return control(store, command);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
