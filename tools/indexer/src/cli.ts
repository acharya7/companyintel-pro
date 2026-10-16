#!/usr/bin/env node
/**
 * CompanyIntel indexer CLI (Windows-compatible).
 *
 *   bun tools/indexer/src/cli.ts profile   --config tools/indexer/indexer.config.json
 *   bun tools/indexer/src/cli.ts run       --config <cfg> [--sample 100000] [--version v1] [--upload]
 *   bun tools/indexer/src/cli.ts run --preflight-only   # checks auth, keys, TSV mapping,
 *                                                      # disk and RAM, then stops
 *   bun tools/indexer/src/cli.ts run --no-resume         # ignore the checkpoint and rebuild;
 *                                                      # clears the stale spool in workDir
 *   bun tools/indexer/src/cli.ts validate  --config <cfg> --version v1
 *   bun tools/indexer/src/cli.ts publish   --config <cfg> --version v1 --yes
 *
 * Nothing here touches Cloudflare unless `--upload` is passed, and publishing
 * requires `--yes` because it flips what the application serves.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { ALL_CANONICAL_FIELDS, buildColumnMap } from "./mapping";
import { preflight, publishVersion, runIndex, uploadOutput, type IndexerConfig, type ProgressEvent } from "./build";
import { credentialsFromEnv } from "./r2";
import { createSourceContext, credentialsHelp, missingCredentialBuckets, parseR2Source, sourceProfile, type SourceContext } from "./source";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=");
    if (inline !== undefined) flags[name] = inline;
    else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
      flags[name] = rest[i + 1];
      i += 1;
    } else flags[name] = true;
  }
  return { command, flags };
}

async function loadConfig(path: string): Promise<IndexerConfig> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as IndexerConfig;
  if (!parsed.sources?.length) throw new Error("Config has no sources. Add the two CSV paths under `sources`.");
  for (const source of parsed.sources) {
    // MODE B (`r2://bucket/key`) is not a local file: nothing to resolve or check
    // locally. A malformed r2 URL fails here, before any run starts.
    if (parseR2Source(source.path)) continue;
    source.path = resolve(source.path);
    if (!existsSync(source.path)) {
      console.warn(`! source ${source.id} was not found at ${source.path} — that file will be skipped by preflight checks.`);
    }
  }
  parsed.workDir = resolve(parsed.workDir);
  parsed.outputDir = resolve(parsed.outputDir);
  return parsed;
}

function printPreflight(report: Awaited<ReturnType<typeof preflight>>): void {
  const gb = (bytes: number | null) => (bytes === null ? "unknown" : `${(bytes / 1e9).toFixed(2)} GB`);
  console.log("\nPreflight");
  for (const source of report.sources) {
    console.log(`  ${source.exists ? "ok  " : "MISS"} ${source.id}  ${gb(source.bytes)}  ${source.path}`);
  }
  console.log(`  input total          ${gb(report.totalInputBytes)}`);
  console.log(`  free disk            ${gb(report.freeDiskBytes)}`);
  console.log(`  temporary space need ${gb(report.estimatedWorkBytes)}`);
  console.log(`  estimated output     ${gb(report.estimatedOutputBytes)}`);
  console.log(`  memory free / total  ${gb(report.memoryBytes.free)} / ${gb(report.memoryBytes.total)}`);
  console.log(`  cpu cores            ${report.cpuCount}`);
  for (const warning of report.warnings) console.log(`  ! ${warning}`);
  if (report.sampleLimit !== null) {
    console.log(`  sample               ${report.sampleLimit.toLocaleString()} records per source (temporary space estimated from this, not from the full input)`);
  }
  // A sample run knows its row count; a full run only knows bytes, so the row
  // count is approximated from the average spool row size.
  const estimatedRows = report.estimatedRows ?? (report.totalInputBytes > 0 ? report.totalInputBytes / 900 : null);
  if (estimatedRows !== null) {
    const seconds = estimatedRows / ROWS_PER_SECOND_HINT;
    // Seconds below a minute and a half: `~0 min` reads as "no idea" and hides
    // exactly the sample runs whose whole point is a measurable duration.
    const duration = seconds < 90 ? `~${Math.round(seconds)} s` : `~${(seconds / 60).toFixed(0)} min`;
    console.log(`  rough duration hint  ${duration} at ${ROWS_PER_SECOND_HINT.toLocaleString()} rows/s (measure with a sample run)`);
  }
  console.log("");
}

/**
 * Measure the two numbers a benchmark cannot get from its own output: peak RSS
 * and peak temporary disk.
 *
 * Sampling is deliberately coarse (every 5 s) and cheap: the spool is a few
 * hundred files and the raw cache at most two, so a stat sweep cannot perturb a
 * run on one core. Returning peaks rather than an average is the point — a
 * multi-hour run's planning number is its worst moment, not its mean.
 */
function startResourceSampler(dirs: string[]) {
  let peakRssBytes = process.memoryUsage().rss;
  let peakDiskBytes = 0;
  let stopped = false;

  const directoryBytes = async (dir: string, depth = 3): Promise<number> => {
    if (depth < 0) return 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += await directoryBytes(path, depth - 1);
      else total += (await stat(path).catch(() => null))?.size ?? 0;
    }
    return total;
  };

  const sample = async () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    let total = 0;
    for (const dir of dirs) total += await directoryBytes(dir);
    peakDiskBytes = Math.max(peakDiskBytes, total);
  };

  const timer = setInterval(() => void sample(), 5_000);
  // `unref` keeps the sample timer from holding the process open after a run.
  timer.unref?.();

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        await sample();
      }
      return { peakRssBytes, peakDiskBytes };
    },
  };
}

const ROWS_PER_SECOND_HINT = 120_000;

function progressLogger() {
  let last = 0;
  return (event: ProgressEvent) => {
    const now = Date.now();
    if (now - last < 1500 && event.stage !== "completed" && event.stage !== "failed") return;
    last = now;
    const rate = event.rowsPerSecond ? ` (${Math.round(event.rowsPerSecond).toLocaleString()} rows/s)` : "";
    const progress = event.progress !== null ? ` [${(event.progress * 100).toFixed(0)}%]` : "";
    console.log(`[${event.stage}]${progress} ${event.message}${rate}`);
  };
}

/**
 * Mode B sources need R2 credentials in this process; Wrangler's login is not
 * usable by a local script. Fail early with the least-privilege recipe instead of
 * failing in the middle of a multi-hour run.
 */
function requireSourceAccess(config: IndexerConfig): boolean {
  const context = createSourceContext({ cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir });
  const missing = missingCredentialBuckets(config.sources, context);
  if (missing.length) {
    console.error(credentialsHelp(missing));
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function cmdProfile(config: IndexerConfig): Promise<void> {
  if (!requireSourceAccess(config)) return;
  const report = await preflight(config);
  printPreflight(report);
  const context = createSourceContext({
    cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir,
    onNotice: (message) => console.log(`  ${message}`),
  });
  for (const source of config.sources) {
    const isR2 = Boolean(parseR2Source(source.path));
    // MODE B goes through the shared source reader: a bounded range read of the
    // real object, trimmed to a complete record. Calling the local-file profiler
    // here would fail on an `r2://` path — the mode is not a file.
    //
    // Cell values are kept out of a MODE B report (0 samples per column): the
    // profile is for the schema, and the objects hold real contact records.
    const profile = await sourceProfile(
      source,
      {
        encoding: source.encoding,
        delimiter: source.delimiter,
        sampleRows: 500,
        knownFields: [...ALL_CANONICAL_FIELDS],
        maxSamplesPerColumn: isR2 ? 0 : 3,
      },
      context,
    );
    const map = buildColumnMap(profile.headers);
    const mode = isR2 ? "R2 object (bounded sample read, no cell values in this report)" : "local file";
    console.log(`\n${source.id} — ${source.path}`);
    console.log(`  input mode       ${mode}`);
    console.log(`  sampled rows     ${profile.sampledRows.toLocaleString()}`);
    console.log(`  header line      ${profile.headerLine}`);
    console.log(`  detected delim   ${JSON.stringify(profile.delimiter)}   encoding ${profile.encoding}`);
    console.log("  columns:");
    for (const column of profile.columns) {
      console.log(
        `    ${String(column.index).padStart(3)}  ${column.header.slice(0, 34).padEnd(34)} ${column.looksLike.padEnd(6)} fill=${
          column.nonEmptyCount
        }/${column.nonEmptyCount + column.emptyCount} max=${column.maxLength} e.g. ${column.samples[0]?.slice(0, 40) ?? "—"}`,
      );
    }
    console.log("  canonical mapping:");
    for (const field of ALL_CANONICAL_FIELDS) {
      const index = map[field];
      const status = index === undefined ? "— not mapped" : `→ column ${index} (${profile.headers[index]})`;
      console.log(`    ${field.padEnd(18)} ${status}`);
    }
    if (profile.unmappedHeaders.length) console.log(`  unmapped headers: ${profile.unmappedHeaders.join(", ")}`);
    console.log(`  canonical fields absent from this file: ${profile.missingCanonicalFields.join(", ") || "none"}`);
  }
  console.log("\nSet `columns` overrides in the config for anything the profiler mapped incorrectly.");
  // The automatic view above sees the raw headers; a run additionally applies the
  // config's `columns` overrides. Print the effective result too, so this command
  // answers "is the mapping right?" rather than only "what did the profiler guess?".
  console.log("\nEffective mapping (config overrides applied — this is what a run uses)");
  await verifyEffectiveMapping(config, context);
}

/**
 * Confirm the schema mapping a run will actually use — bounded sample read per
 * source (500 rows, no cell values), the automatic header mapping *plus* every
 * `columns` override from the config.
 *
 * This is the check that catches the expensive mistake: a typo in an override
 * name or a delimiter that is not really a TAB would otherwise only surface
 * after the run had streamed gigabytes. Returns false if anything is wrong.
 */
async function verifyEffectiveMapping(config: IndexerConfig, context: SourceContext): Promise<boolean> {
  let ok = true;
  for (const source of config.sources) {
    const profile = await sourceProfile(
      source,
      { encoding: source.encoding, delimiter: source.delimiter, sampleRows: 500, knownFields: [...ALL_CANONICAL_FIELDS], maxSamplesPerColumn: 0 },
      context,
    );
    const map = buildColumnMap(profile.headers);
    let overrides = 0;
    for (const [field, header] of Object.entries(source.columns ?? {})) {
      const index = profile.headers.findIndex((value) => value.trim().toLowerCase() === header.trim().toLowerCase());
      if (index === -1) {
        ok = false;
        console.error(`  FAIL ${source.id}: configured column "${header}" for "${field}" is not present in this file`);
        continue;
      }
      map[field] = index;
      overrides += 1;
    }
    const name = (field: string) => (map[field] === undefined ? "—" : `"${profile.headers[map[field]]}"`);
    const absent = ALL_CANONICAL_FIELDS.filter((field) => map[field] === undefined);
    const mappedIndexes = new Set(Object.values(map));
    const unmapped = profile.headers.filter((_, index) => !mappedIndexes.has(index));
    console.log(
      `  ok   ${source.id}  ${profile.headers.length} columns · delimiter ${JSON.stringify(profile.delimiter)} · encoding ${profile.encoding} · ${overrides} override(s)`,
    );
    console.log(`       company id ← ${name("companyid")} · name ← ${name("companyname")} · domain ← ${name("companydomain")}`);
    console.log(`       contact email ← ${name("email")} · phone ← ${name("phone")} · linkedin ← ${name("linkedin")}`);
    if (absent.length) console.log(`       not present in this file: ${absent.join(", ")}`);
    if (unmapped.length) console.log(`       unmapped headers (${unmapped.length}): ${unmapped.slice(0, 8).join(", ")}`);
  }
  return ok;
}

/**
 * Run the indexer while sampling peak memory and peak temporary disk, so the
 * benchmark's two hard-to-measure numbers come from the run itself.
 *
 * The sampler is stopped on the failure path too: a run that dies at hour two is
 * exactly the one whose peak usage the operator needs.
 */
/**
 * Human-readable size for the run summary.
 *
 * Two decimals of GB shows a 1.5 MB index as "0.00 GB", which is worse than
 * useless in the number an operator writes down. Below 0.1 GB the summary
 * switches to MB.
 */
function formatBytes(bytes: number): string {
  if (bytes < 0.1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

async function withResourcePeaks<T>(
  dirs: string[],
  run: () => Promise<T>,
): Promise<{ result: T; peaks: { peakRssBytes: number; peakDiskBytes: number } }> {
  const sampler = startResourceSampler(dirs);
  try {
    const result = await run();
    return { result, peaks: await sampler.stop() };
  } catch (error) {
    const peaks = await sampler.stop();
    console.error(
      `  peak memory       ${formatBytes(peaks.peakRssBytes)} RSS\n` +
        `  peak temp disk    ${formatBytes(peaks.peakDiskBytes)} (measured before the failure)`,
    );
    throw error;
  }
}

async function cmdRun(config: IndexerConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (!requireSourceAccess(config)) return;
  const sample = flags.sample ? Number(flags.sample) : undefined;
  const version = typeof flags.version === "string" ? flags.version : config.datasetVersion;
  const upload = Boolean(flags.upload);
  // `run --preflight-only` answers "is this machine and this config ready?"
  // without reading the corpus: R2 auth + object keys, TSV schema mapping, free
  // disk, memory, and the sample-based space estimate. Nothing is written.
  const preflightOnly = Boolean(flags["preflight-only"]);
  // `--no-resume` is the operator's "rebuild from the sources" switch: it
  // ignores any checkpoint, clears the stale spool and re-reads. It is also the
  // documented answer to a checkpoint that belongs to a different run — the
  // indexer stops rather than merging two inputs (see CheckpointIdentity in
  // build.ts).
  const noResume = Boolean(flags["no-resume"]);

  // `sample` must reach preflight: a sample run's temporary-space estimate is based
  // on the sampled row count, so a machine that cannot hold the 60 GB job can still
  // run the dry run the specification requires before it.
  const report = await preflight(config, undefined, { sampleLimit: sample });
  printPreflight(report);
  const spaceProblem = report.warnings.some((warning) => warning.includes("insufficient"));

  if (preflightOnly) {
    // The mapping check is the cheapest and most valuable part of a preflight —
    // two bounded sample reads — so it runs even on a machine that cannot hold
    // the job, where the answer is still "this config is right, free space".
    console.log("\nSchema mapping actually in use (automatic mapping + config overrides)");
    const context = createSourceContext({ cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir });
    const mappingOk = await verifyEffectiveMapping(config, context);
    const problems = [
      ...(mappingOk ? [] : ["the schema mapping does not match the real files"]),
      ...(spaceProblem ? ["free disk space is below the estimate above"] : []),
    ];
    console.log(
      problems.length
        ? `\nPreflight only: NOT ready — ${problems.join("; ")}. Nothing was read in bulk, no index was built, nothing was uploaded.`
        : "\nPreflight only: ready. Authentication, source keys, TSV mapping, disk and memory all check out; nothing was built or uploaded.",
    );
    if (problems.length) process.exitCode = 1;
    return;
  }

  if (spaceProblem) {
    console.error("Refusing to start: temporary space is insufficient for this run.");
    process.exitCode = 1;
    return;
  }

  const { result, peaks } = await withResourcePeaks(
    [config.workDir, ...(config.rawCacheDir ? [config.rawCacheDir] : [])],
    () =>
      runIndex(
        { ...config, datasetVersion: version, upload: { enabled: upload, bucket: config.upload?.bucket ?? "company-intel-data" } },
        { sampleLimit: sample, resume: !noResume, onProgress: progressLogger() },
      ),
  );

  console.log(`\nBuilt version ${result.version}`);
  console.log(`  files read        ${result.counters.rowsRead.toLocaleString()}`);
  console.log(`  rows rejected     ${result.counters.rowsRejected.toLocaleString()}`);
  console.log(`  unique companies  ${result.counters.uniqueCompanies.toLocaleString()}`);
  console.log(`  unique contacts   ${result.counters.uniqueContacts.toLocaleString()}`);
  console.log(`  ambiguous kept apart ${result.counters.ambiguousCompanies.toLocaleString()}  (name collisions with conflicting strong evidence)`);
  console.log(`  missing company id   ${result.counters.recordsMissingCompanyId.toLocaleString()}`);
  console.log(`  objects written   ${result.objects.length.toLocaleString()}`);
  console.log(`  elapsed           ${(result.elapsedMs / 1000).toFixed(1)} s`);
  console.log(`  peak memory       ${formatBytes(peaks.peakRssBytes)} RSS`);
  console.log(`  peak temp disk    ${formatBytes(peaks.peakDiskBytes)} (${config.workDir}${config.rawCacheDir ? " + raw cache" : ""})`);
  console.log(`  index output      ${formatBytes(result.outputBytes)} in ${config.outputDir}`);
  if (result.sourceStats.requests > 0) {
    console.log(
      `  r2 requests       ${result.sourceStats.requests.toLocaleString()} (${result.sourceStats.retries.toLocaleString()} retried, ` +
        `${formatBytes(result.sourceStats.bytesRead)} read, ${result.sourceStats.objectsOpened} object(s) streamed)`,
    );
  }
  if (result.sourceStats.cachedBytes > 0) {
    console.log(`  served from cache ${formatBytes(result.sourceStats.cachedBytes)} (no R2 requests for those bytes)`);
  }
  for (const [id, perSource] of Object.entries(result.counters.perSource)) {
    console.log(`  ${id}: ${perSource.rowsRead.toLocaleString()} rows, ${perSource.rowsRejected.toLocaleString()} rejected`);
  }
  console.log(`  output directory  ${config.outputDir}`);
  console.log(`  validation        ${result.manifest.validationPassed ? "passed" : "FAILED — inspect manifests/" + version + "/validation.json"}`);

  if (upload) {
    if (!result.manifest.validationPassed) {
      console.error("Refusing to upload a version that did not pass validation.");
      process.exitCode = 1;
      return;
    }
    const uploaded = await uploadOutput(config, result, (message) => console.log(`  ${message}`));
    console.log(`  uploaded          ${uploaded.uploaded} objects (${(uploaded.bytes / 1e6).toFixed(1)} MB), ${uploaded.skipped} already present`);
    console.log(`\nNext: activate the version with\n  bun tools/indexer/src/cli.ts publish --config <cfg> --version ${version} --yes`);
  } else {
    console.log(`\nUpload with:\n  bun tools/indexer/src/cli.ts run --config <cfg> --version ${version} --upload`);
  }
}

async function cmdValidate(config: IndexerConfig, flags: Record<string, string | boolean>): Promise<void> {
  const version = typeof flags.version === "string" ? flags.version : config.datasetVersion;
  const objectsPath = resolve(config.outputDir, "objects.jsonl");
  if (!existsSync(objectsPath)) {
    console.error(`No objects.jsonl in ${config.outputDir}. Run the indexer first.`);
    process.exitCode = 1;
    return;
  }
  const lines = (await readFile(objectsPath, "utf8")).split("\n").filter(Boolean);
  let checked = 0;
  const failures: string[] = [];
  for (const line of lines) {
    const object = JSON.parse(line) as { key: string; bytes: number; sha256: string };
    const path = resolve(config.outputDir, object.key);
    if (!existsSync(path)) {
      failures.push(`${object.key}: missing`);
      continue;
    }
    const body = await readFile(path);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== object.sha256) failures.push(`${object.key}: checksum mismatch`);
    checked += 1;
  }
  const validation = existsSync(resolve(config.outputDir, `manifests/${version}/validation.json`))
    ? JSON.parse(await readFile(resolve(config.outputDir, `manifests/${version}/validation.json`), "utf8"))
    : null;

  console.log(`\nValidation for ${version}`);
  console.log(`  objects verified  ${checked}/${lines.length}`);
  console.log(`  recorded verdict  ${validation ? (validation.passed ? "passed" : "FAILED") : "not recorded"}`);
  for (const failure of failures.slice(0, 25)) console.log(`  ! ${failure}`);
  if (failures.length) process.exitCode = 1;
}

async function cmdPublish(config: IndexerConfig, flags: Record<string, string | boolean>): Promise<void> {
  const version = typeof flags.version === "string" ? flags.version : config.datasetVersion;
  if (!flags.yes) {
    console.error("Refusing to publish without --yes. Publishing changes what the application serves.");
    process.exitCode = 1;
    return;
  }
  const validationPath = resolve(config.outputDir, `manifests/${version}/validation.json`);
  if (!existsSync(validationPath)) {
    console.error(`No validation report for ${version}. Run the indexer (and validate) first.`);
    process.exitCode = 1;
    return;
  }
  const validation = JSON.parse(await readFile(validationPath, "utf8")) as { passed: boolean };
  if (!validation.passed) {
    console.error(`Version ${version} did not pass validation and will not be published.`);
    process.exitCode = 1;
    return;
  }
  const credentials = credentialsFromEnv(config.upload?.bucket);
  if (!credentials) {
    console.error(
      "R2 credentials are not set. Export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or upload the output directory with rclone and then create manifests/active.json manually.",
    );
    process.exitCode = 1;
    return;
  }
  await publishVersion(version, config.upload?.bucket);
  console.log(`Published ${version}. The previous version remains in R2 and can be reactivated from the Dataset page.`);
}

function usage(): void {
  console.log(`CompanyIntel indexer

  profile    Inspect both CSV files: headers, fill rates, mapping suggestions
  run        Stream, resolve, index, validate and optionally upload
  validate   Re-check the generated objects against their checksums
  publish    Flip the active-version pointer to a validated version

Sources (sources[].path in the config) accept either mode:
  local file   D:/data/companies_part1.csv
  R2 object    r2://company-intel-data/raw/companies_part1.csv
               (streamed in bounded ranged reads; needs R2_* credentials in this
                shell because Wrangler's login cannot be used by a local script)

Flags
  --config <path>     indexer configuration (required for every command)
  --sample <n>        limit each source to n records (sample runs)
  --version <id>      dataset version id (default from the config)
  --preflight-only    run: check auth, keys, TSV mapping, disk and RAM, then stop
                      (nothing is read in bulk, built or uploaded)
  --no-resume         ignore the checkpoint and rebuild from the sources; clears
                      the stale spool in workDir
  --upload            upload generated objects to R2
  --yes               confirm a publish operation

Example (Windows PowerShell)
  bun tools/indexer/src/cli.ts profile  --config tools/indexer/indexer.config.json
  bun tools/indexer/src/cli.ts run      --config tools/indexer/indexer.config.json --sample 100000 --version v1-sample
`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "help" || !flags.config) {
    usage();
    return;
  }
  const config = await loadConfig(String(flags.config));
  switch (command) {
    case "profile":
      await cmdProfile(config);
      break;
    case "run":
      await cmdRun(config, flags);
      break;
    case "validate":
      await cmdValidate(config, flags);
      break;
    case "publish":
      await cmdPublish(config, flags);
      break;
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
