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
 *   bun tools/indexer/src/cli.ts pass2-from-spool --config <cfg> --version v1-assoc
 *                                                      # experimental: merge a VERIFIED Pass 1
 *                                                      # spool into a new version, no source read
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
import {
  ROWS_PER_SECOND_MEASURED,
  STORAGE,
  identityFor,
  preflight,
  publishVersion,
  runIndex,
  uploadOutput,
  verifyRemoteObjects,
  verifyRemoteVersion,
  type IndexerConfig,
  type ProgressEvent,
} from "./build";
import { R2Client, credentialsFromEnv } from "./r2";
import { adoptSpool, inspectSpool, spoolManifestPathFor, type SpoolInspection } from "./spool";
import {
  defaultExperimentalOutputDir,
  defaultExperimentalWorkDir,
  executeSpoolImport,
  prepareSpoolImport,
  type SpoolImportPlan,
} from "./spool-import";
import { createSourceContext, credentialsHelp, missingCredentialBuckets, parseR2Source, sourceProfile, type SourceContext } from "./source";
import { assessLegacySpool, recoverLegacySpool, type RecoveryAssessment } from "./spool-recover";

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
  console.log(`  temporary space need ${gb(report.estimatedWorkBytes)}  (upper bound)`);
  // Every term, because "free some space" is useless advice when one term (the
  // Mode B staging file) dominates and can be removed by a config change. The
  // spool shows both bounds: the decision uses the upper one, and an operator who
  // sees only the expected number would think the check is stricter than it is.
  const estimate = report.estimate;
  console.log(`    spool               ${gb(estimate.spoolBytes)} expected / ${gb(estimate.spoolBytesUpper)} upper  (v2 segments written by pass 1)`);
  console.log(`    raw cache staging   ${gb(estimate.rawCachePeakBytes)}  (largest Mode B .part alive at once)`);
  console.log(`    index output        ${gb(estimate.outputBytes)}  (written during pass 2, same volume by default)`);
  console.log(`    run bookkeeping     ${gb(estimate.overheadBytes)}  (checkpoint, spool manifest, rejected/objects lists)`);
  console.log(`    safety margin       x${estimate.safetyMargin} applied to the four terms above, using the spool UPPER bound`);
  const expectedTotal = Math.ceil(
    (estimate.spoolBytes + estimate.rawCachePeakBytes + estimate.outputBytes + estimate.overheadBytes) * estimate.safetyMargin,
  );
  console.log(`  expected total       ${gb(expectedTotal)}  (same terms with the expected spool)`);
  console.log(`  estimated output     ${gb(report.estimatedOutputBytes)}`);
  console.log(`  memory free / total  ${gb(report.memoryBytes.free)} / ${gb(report.memoryBytes.total)}`);
  console.log(`  cpu cores            ${report.cpuCount}`);
  for (const warning of report.warnings) console.log(`  ! ${warning}`);
  if (report.sampleLimit !== null) {
    console.log(`  sample               ${report.sampleLimit.toLocaleString()} records per source (temporary space estimated from this, not from the full input)`);
  }
  // A sample run knows its row count; a full run only knows bytes, so the row
  // count is approximated from the average spool row size.
  const estimatedRows = report.estimatedRows ?? (report.totalInputBytes > 0 ? report.totalInputBytes / STORAGE.averageSourceBytesPerRow : null);
  if (estimatedRows !== null) {
    const seconds = estimatedRows / ROWS_PER_SECOND_MEASURED;
    // Seconds below a minute and a half: `~0 min` reads as "no idea" and hides
    // exactly the sample runs whose whole point is a measurable duration.
    const duration = seconds < 90 ? `~${Math.round(seconds)} s` : `~${(seconds / 60).toFixed(0)} min`;
    console.log(
      `  duration estimate    ${duration} at ${ROWS_PER_SECOND_MEASURED.toLocaleString()} rows/s — the MEASURED end-to-end rate\n` +
        "                       of the 1 M benchmark (R2 read + parse + spool). The run prints its own per-stage\n" +
        "                       timings afterwards; use those, not this hint.",
    );
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

function progressLogger() {
  let last = 0;
  return (event: ProgressEvent) => {
    const now = Date.now();
    if (now - last < 1500 && event.stage !== "completed" && event.stage !== "failed") return;
    last = now;
    const rate = event.rowsPerSecond ? ` (${Math.round(event.rowsPerSecond).toLocaleString()} rows/s)` : "";
    // One decimal below 10%: pass 2 has 256 partitions, so the first completed one
    // is 0.39% — rounding that to "0%" is exactly what made a working merge look
    // stuck. Above 10% the whole number is what an operator wants.
    const percent = event.progress === null ? null : event.progress * 100;
    const progress = percent === null ? "" : ` [${percent > 0 && percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%]`;
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
  /*
   * Deleting an existing spool is its own, explicit decision. `--no-resume`
   * alone no longer removes anything: a work directory holding 217 GB of parsed
   * rows must be inspected or recovered, not cleared by a resume command.
   */
  const discardSpool = Boolean(flags["discard-spool"]);
  const spoolMaxGb = Number(flags["spool-max-gb"]);
  if (Number.isFinite(spoolMaxGb) && spoolMaxGb > 0) {
    config = { ...config, spoolMaxBytes: Math.round(spoolMaxGb * 1e9) };
  }
  /*
   * `--work-dir <path>` overrides the config's workDir for THIS run.
   *
   * `recover-spool --apply` deliberately writes into a NEW directory rather than
   * the legacy spool's, so the converted ledgers live in e.g. `.indexer-work-v2`.
   * Without this flag the next `run` would look at the config's `.indexer-work`
   * (the untouched legacy spool) and refuse — or worse, if that spool were ever
   * cleared, rebuild Pass 1 from zero. Resuming therefore has to be expressible on
   * the command line without editing the shared config.
   */
  if (typeof flags["work-dir"] === "string") {
    config = { ...config, workDir: resolve(String(flags["work-dir"])) };
  }
  /*
   * `--disk-floor <mb>` lowers the free-space floor pass 2 stops at.
   *
   * The default (512 MB) is a comfortable margin for a full 60 GB run, but it is a
   * constant: on a small machine — or a bounded sandbox — a run whose output is
   * 30 MB can be refused because the disk has 400 MB free instead of 520 MB. The
   * floor is a safety margin, not a correctness rule, so it is an explicit operator
   * choice rather than a value edited in source. An unparseable or non-positive
   * value is ignored (the default applies), because silently lowering the guard is
   * exactly the failure mode it exists to prevent.
   */
  const diskFloorMb = Number(flags["disk-floor"]);
  const diskFloorBytes = Number.isFinite(diskFloorMb) && diskFloorMb > 0 ? Math.round(diskFloorMb * 1024 * 1024) : undefined;

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
        { sampleLimit: sample, resume: !noResume, discardSpool, onProgress: progressLogger(), diskFloorBytes },
      ),
  );

  console.log(`\nBuilt version ${result.version}`);
  console.log(`  files read        ${result.counters.rowsRead.toLocaleString()}`);
  console.log(`  rows rejected     ${result.counters.rowsRejected.toLocaleString()}`);
  console.log(`  unique companies  ${result.counters.uniqueCompanies.toLocaleString()}`);
  console.log(`  unique contacts   ${result.counters.uniqueContacts.toLocaleString()}`);
  console.log(`  ambiguous kept apart ${result.counters.ambiguousCompanies.toLocaleString()}  (name collisions with conflicting strong evidence)`);
  console.log(`  missing company id   ${result.counters.recordsMissingCompanyId.toLocaleString()}`);
  // Stage B's outcome, printed by the run itself so an operator sees the
  // association split without opening the audit. A run resumed from an older
  // checkpoint has no association counters, and then prints nothing rather than
  // a row of zeros that would read like a real result.
  const association = result.counters;
  if (association.contactsHighConfidence !== undefined || association.contactsUnresolved !== undefined || association.contactsMoved !== undefined) {
    console.log(
      `  association       ${(association.contactsHighConfidence ?? 0).toLocaleString()} high confidence, ` +
        `${(association.contactsPlausible ?? 0).toLocaleString()} plausible, ` +
        `${(association.contactsConflicting ?? 0).toLocaleString()} conflicting, ` +
        `${(association.contactsUnresolved ?? 0).toLocaleString()} preserved without an employer`,
    );
    console.log(
      `  association moves ${(association.contactsMoved ?? 0).toLocaleString()} contact(s) attached to a different company of the same name than their row claimed`,
    );
    console.log(
      `  claims refused    ${(association.identifierConflicts ?? 0).toLocaleString()}  (a later row tried to take an identifier another company already owns)`,
    );
  }
  console.log(`  objects written   ${result.objects.length.toLocaleString()}`);
  console.log(`  elapsed           ${(result.elapsedMs / 1000).toFixed(1)} s${result.resumed ? " (resumed: pass 1 skipped, spool reused)" : ""}`);
  // Measured, per stage. Pass 1 is one streaming loop (network read + CSV parse +
  // JSONL serialize + partition write) so its cost is reported as a whole; the
  // point of the breakdown is that the next duration estimate uses these numbers
  // instead of a synthetic rows/s figure.
  const stages = result.stages;
  const pass1RowsPerSecond = stages.pass1Ms > 0 ? Math.round(result.counters.rowsRead / (stages.pass1Ms / 1000)) : null;
  console.log(`  stage timings`);
  console.log(`    profiling       ${(stages.profilingMs / 1000).toFixed(1)} s`);
  console.log(
    `    pass 1          ${(stages.pass1Ms / 1000).toFixed(1)} s` +
      (pass1RowsPerSecond === null ? "  (skipped: resumed)" : `  (${pass1RowsPerSecond.toLocaleString()} rows/s: R2/file read + parse + spool)`),
  );
  console.log(`    pass 2 merge    ${(stages.pass2Ms / 1000).toFixed(1)} s`);
  if (result.pass2Reset.shardFiles || result.pass2Reset.outputFiles) {
    // Restart safety, in the summary an operator actually reads: pass 2 replayed
    // from partition 1 after a previous attempt's output was reset.
    console.log(
      `      restart reset ${result.pass2Reset.shardFiles.toLocaleString()} shard file(s), ` +
        `${result.pass2Reset.outputFiles.toLocaleString()} generated object(s) (${formatBytes(result.pass2Reset.outputBytes)})`,
    );
  }
  console.log(
    `      shard writer  ${result.shardWrite.appends.toLocaleString()} posting line(s), ${result.shardWrite.fileOpens.toLocaleString()} shard append(s) ` +
      `(${(result.shardWrite.appends / Math.max(1, result.shardWrite.fileOpens)).toFixed(1)} lines per append), peak buffer ${formatBytes(result.shardWrite.peakBufferedBytes)}`,
  );
  console.log(`    finalize+index  ${(stages.finalizeMs / 1000).toFixed(1)} s`);
  console.log(`    validate        ${(stages.validateMs / 1000).toFixed(1)} s`);
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

function printImportPlan(plan: SpoolImportPlan): void {
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
  console.log("\nExperimental Pass 2 import — validated read-only");
  for (const check of plan.checks) console.log(`  ok   ${check}`);
  console.log(`  source run version   ${plan.sourceVersion}  (kept intact; never used as the output)`);
  console.log(`  output version       ${plan.outputVersion}`);
  console.log(`  spool                ${plan.totals.files} files · ${plan.totals.lines.toLocaleString()} rows · ${gb(plan.totals.bytes)}`);
  console.log(`  experimental work    ${plan.workDir}`);
  console.log(`  experimental output  ${plan.outputDir}`);
  console.log("  the source checkpoint, manifest, partitions and generated index are opened for READING only");
  console.log("");
}

/**
 * `pass2-from-spool` — the one explicit workflow that separates the source run's
 * identity from the output index version.
 *
 * Ordinary `run` still refuses a version difference (the spool belongs to the run
 * that wrote it). This command exists because "merge this finished Pass 1 spool
 * into a NEW version" is a legitimate, and separately verifiable, operation: the
 * source run identity is validated as recorded and left untouched, while Pass 2
 * writes only into the isolated directories the operator names.
 *
 * It deliberately has no upload or publish path, and it refuses `--sample`
 * (the limit is a property of the spool, not of the merge).
 */
async function cmdPass2FromSpool(config: IndexerConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (flags.upload) {
    console.error("Refusing --upload: pass2-from-spool never uploads. The experimental index stays on this machine until you upload it deliberately.");
    process.exitCode = 1;
    return;
  }
  if (flags.sample !== undefined) {
    console.error(
      "Refusing --sample: the sample limit belongs to the Pass 1 spool that is being imported and cannot be changed now.\n" +
        "  Use --expect-sample <n> to ASSERT the recorded limit instead.",
    );
    process.exitCode = 1;
    return;
  }
  if (flags["no-resume"]) {
    // `--no-resume` means "clear the spool and rebuild from the sources" to the
    // ordinary command. Here it could only mean that, and this command must never
    // touch the source spool — refusing it prevents the one flag that reads like a
    // harmless retry from being copied over from the old procedure.
    console.error(
      "Refusing --no-resume: pass2-from-spool never rebuilds Pass 1 and never clears a spool.\n" +
        "  To restart an interrupted experimental merge, re-run the same command without --no-resume: it replays safely.",
    );
    process.exitCode = 1;
    return;
  }
  // A flag that was typed without its value becomes `true`; that would silently
  // fall back to a default (or assert sample 1), so it is refused explicitly.
  const textFlag = (name: string): string | undefined | null => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) return null;
    return value;
  };
  const badFlag = ["version", "source-work-dir", "work-dir", "output-dir", "expect-sample"].find((name) => textFlag(name) === null);
  if (badFlag) {
    console.error(`--${badFlag} needs a value (for example --${badFlag} <value>).`);
    process.exitCode = 1;
    return;
  }

  const versionFlag = textFlag("version");
  if (!versionFlag) {
    console.error(
      "pass2-from-spool needs --version <new-output-version>, e.g. v1-bench-1m-assoc.\n" +
        "  The source run keeps its own version; only the generated index uses the new one.",
    );
    process.exitCode = 1;
    return;
  }
  const version = versionFlag;
  const sourceFlag = textFlag("source-work-dir");
  const workFlag = textFlag("work-dir");
  const outputFlag = textFlag("output-dir");
  const sourceWorkDir = sourceFlag ? resolve(sourceFlag) : config.workDir;
  const workDir = workFlag ? resolve(workFlag) : defaultExperimentalWorkDir(sourceWorkDir, version);
  const outputDir = outputFlag ? resolve(outputFlag) : defaultExperimentalOutputDir(config.outputDir, version);

  const sampleAssertion = textFlag("expect-sample");
  let expectSampleLimit: number | null | undefined;
  if (sampleAssertion !== undefined) {
    const value = Number(sampleAssertion);
    if (!Number.isInteger(value) || value <= 0) {
      console.error("--expect-sample must be a positive whole number of records per source (omit it to accept the recorded limit).");
      process.exitCode = 1;
      return;
    }
    expectSampleLimit = value;
  }

  // Validation touches no source. `requireSourceAccess` is deliberately NOT called:
  // this command must work on a machine whose R2 objects are unreachable.
  const plan = await prepareSpoolImport({
    sourceWorkDir,
    workDir,
    outputDir,
    sourceOutputDir: config.outputDir,
    outputVersion: version,
    expectation: { partitions: config.partitions, sources: identityFor(config, undefined).sources, sampleLimit: expectSampleLimit },
  });
  printImportPlan(plan);

  if (flags["check-only"]) {
    console.log("Check only: the spool is valid and the isolated bookkeeping is prepared. Nothing was merged, uploaded or published.");
    return;
  }

  const { result, peaks } = await withResourcePeaks([workDir, outputDir], () =>
    executeSpoolImport(config, plan, { onProgress: progressLogger() }),
  );

  console.log(`\nRebuilt version ${result.version} from the imported Pass 1 spool`);
  console.log(`  rows merged       ${result.counters.rowsRead.toLocaleString()}`);
  console.log(`  rows rejected     ${result.counters.rowsRejected.toLocaleString()}`);
  console.log(`  unique companies  ${result.counters.uniqueCompanies.toLocaleString()}`);
  console.log(`  unique contacts   ${result.counters.uniqueContacts.toLocaleString()}`);
  console.log(
    `  association       ${(result.counters.contactsHighConfidence ?? 0).toLocaleString()} high confidence, ` +
      `${(result.counters.contactsPlausible ?? 0).toLocaleString()} plausible, ` +
      `${(result.counters.contactsConflicting ?? 0).toLocaleString()} conflicting, ` +
      `${(result.counters.contactsUnresolved ?? 0).toLocaleString()} preserved without an employer`,
  );
  console.log(`  association moves ${(result.counters.contactsMoved ?? 0).toLocaleString()}`);
  console.log(`  objects written   ${result.objects.length.toLocaleString()}`);
  console.log(`  index output      ${formatBytes(result.outputBytes)} in ${outputDir}`);
  console.log(`  elapsed           ${(result.elapsedMs / 1000).toFixed(1)} s (pass 1 and profiling skipped: imported spool)`);
  console.log(`  stage timings     profiling 0.0 s · pass 1 0.0 s (skipped) · pass 2 ${(result.stages.pass2Ms / 1000).toFixed(1)} s · finalize ${(result.stages.finalizeMs / 1000).toFixed(1)} s`);
  if (result.pass2Reset.shardFiles || result.pass2Reset.outputFiles) {
    console.log(
      `  restart reset     ${result.pass2Reset.shardFiles.toLocaleString()} shard file(s), ${result.pass2Reset.outputFiles.toLocaleString()} generated object(s) ` +
        `(${formatBytes(result.pass2Reset.outputBytes)}) — no duplicate postings or stale objects`,
    );
  }
  console.log(`  peak memory       ${formatBytes(peaks.peakRssBytes)} RSS`);
  console.log(`  peak temp disk    ${formatBytes(peaks.peakDiskBytes)} (${workDir} + ${outputDir})`);
  console.log(`  source reads      ${result.sourceStats.requests} request(s) — the sources were not read`);
  console.log(`  validation        ${result.manifest.validationPassed ? "passed" : `FAILED — inspect ${resolve(outputDir, "manifests", version, "validation.json")}`}`);
  console.log("\nNothing was uploaded, nothing was published, and manifests/active.json was not written.");
  console.log(`Audit it read-only with:\n  bun run index:audit -- --dir ${outputDir} --version ${version}`);
  if (!result.manifest.validationPassed) process.exitCode = 1;
}

/**
 * `spool` — read-only inspection of an existing work directory.
 *
 * Added in response to a real failure: the benchmark died in pass 2 and the only
 * way to find out what the spool actually contained was to eyeball multi-gigabyte
 * partition files by hand. This command answers "is this spool usable, and if not,
 * exactly where is the damage" while printing positions instead of records, so its
 * output can be pasted into a report without leaking company or contact data.
 *
 * It modifies nothing unless `--repair-manifest` is passed explicitly, and that
 * only ever writes `spool-manifest.json`, and only when every partition verifies.
 */
/**
 * `recover-spool` — assess (and, with --apply, convert) a legacy Pass 1 spool
 * that has no checkpoint and no manifest.
 *
 * Assessment is read-only and can be run on a machine whose sources are
 * unreachable. `--apply` writes ONLY into a new, empty target work directory and
 * positions its ledger at the proven continuation row; the legacy spool is never
 * modified.
 */
async function cmdRecoverSpool(flags: Record<string, string | boolean>): Promise<void> {
  const workDir = resolve(String(flags["work-dir"] ?? ".indexer-work"));
  const partitions = Number(flags.partitions ?? 256);
  if (!Number.isInteger(partitions) || partitions <= 0) throw new Error("--partitions must be a positive whole number.");
  const assessment = await assessLegacySpool(workDir, { partitions });
  printRecoveryAssessment(assessment);

  if (!flags.apply) {
    process.exitCode = assessment.verdict === "recoverable" ? 0 : 1;
    return;
  }
  if (assessment.verdict !== "recoverable" || !assessment.schema) {
    console.error("\nRefusing to apply: the spool is not provably resumable (see the verdict and findings above). Nothing was written.");
    process.exitCode = 1;
    return;
  }
  if (!flags["target-work-dir"]) {
    console.error("\n--apply needs --target-work-dir <new empty directory>, e.g. .indexer-work-v2. Nothing was written.");
    process.exitCode = 1;
    return;
  }
  if (!flags.config) {
    console.error(
      "\n--apply needs --config <the same indexer config the interrupted run used>: the recovered ledger must carry that\n" +
        "  run's identity (source paths, delimiters, override counts), or the resumed run would refuse it. Nothing was written.",
    );
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(String(flags.config));
  const version = typeof flags.version === "string" ? flags.version : config.datasetVersion;
  const sample = flags.sample ? Number(flags.sample) : undefined;
  const targetIdentity = identityFor({ ...config, datasetVersion: version }, sample);
  const completeSources = typeof flags["complete-sources"] === "string" ? String(flags["complete-sources"]).split(",").map((id) => id.trim()).filter(Boolean) : [];

  const result = await recoverLegacySpool({
    sourceWorkDir: workDir,
    targetWorkDir: String(flags["target-work-dir"]),
    targetIdentity,
    partitions,
    assessment,
    completeSources,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log(`\nRecovered into ${result.targetWorkDir}`);
  console.log(`  rows written        ${result.converted.rows.toLocaleString()} (${result.converted.duplicatesSkipped.toLocaleString()} duplicate source row(s) skipped)`);
  console.log(`  v2 spool            ${(result.progress.totals.bytes / 1e9).toFixed(2)} GB in ${result.progress.totals.files} partition(s), ${result.progress.totals.rows.toLocaleString()} rows`);
  for (const entry of Object.entries(result.progress.sources)) {
    console.log(`  ${entry[0]}                 ${entry[1].rowsRead.toLocaleString()} proven row(s)${entry[1].complete ? " (source complete)" : " — Pass 1 resumes after them"}`);
  }
  console.log("\nThe original spool was opened for reading only and was not modified.\n");
  console.log("Next (same config, same version — Pass 1 resumes from the proven row and reads only the remainder):");
  console.log(`  bun tools/indexer/src/cli.ts run --config ${String(flags.config)} --version ${version} --work-dir ${result.targetWorkDir}`);
  console.log("\nThe --work-dir flag is required: the recovered ledger belongs to the NEW directory, not the legacy spool's.");
}

function printRecoveryAssessment(assessment: RecoveryAssessment): void {
  console.log(`\nLegacy spool recovery assessment (read-only) — ${assessment.workDir}`);
  console.log(`  format               ${assessment.format}`);
  console.log(`  partition files      ${assessment.totals.files}`);
  console.log(`  spool size           ${(assessment.totals.bytes / 1e9).toFixed(2)} GB`);
  console.log(`  records              ${assessment.totals.records.toLocaleString()}`);
  console.log(`  duplicates           ${assessment.totals.duplicates.toLocaleString()}`);
  console.log(`  partition mismatches ${assessment.totals.partitionMismatches.toLocaleString()}`);
  for (const source of assessment.sources) {
    console.log(
      `  ${source.id}                  ${source.records.toLocaleString()} records · ${source.unique.toLocaleString()} unique · ` +
        `${source.duplicates.toLocaleString()} duplicate(s) · prefix ${source.prefixRows.toLocaleString()} · ` +
        `first gap ${source.firstGap === null ? "none" : source.firstGap.toLocaleString()}`,
    );
  }
  console.log(`  verdict              ${assessment.verdict.toUpperCase()}`);
  if (assessment.findings.length) {
    console.log("  findings");
    for (const finding of assessment.findings.slice(0, 30)) console.log(`    - ${finding}`);
    if (assessment.findings.length > 30) console.log(`    … ${assessment.findings.length - 30} more`);
  }
  if (assessment.verdict === "recoverable") {
    console.log("\n  Every source row present forms ONE contiguous prefix, with no gap, in the correct partition.");
    console.log("  That is the evidence required to continue Pass 1 at the next row without losing or repeating a record.");
    console.log("\n  Convert it into a new, isolated v2 work directory (the legacy spool stays untouched):");
    console.log("    bun tools/indexer/src/cli.ts recover-spool --apply --config <cfg> --work-dir <legacy-work-dir> \\");
    console.log("      --target-work-dir <new-work-dir> [--complete-sources csv1]");
  } else if (assessment.verdict === "already-v2") {
    console.log("\n  Nothing to recover: resume it with the ordinary run command.");
  } else {
    console.log("\n  This spool cannot be proven resumable. Recovery is refused; a clean restart is the safe answer.");
  }
  console.log("\nNo record content is included in this report, and nothing was modified.");
}

async function cmdSpool(workDir: string, flags: Record<string, string | boolean>): Promise<void> {
  const inspection = await inspectSpool(workDir, { checkHashes: Boolean(flags.hashes) });
  printSpoolInspection(inspection);

  if (flags["repair-manifest"]) {
    const identity = inspection.checkpoint.identity;
    if (!inspection.checkpoint.present) throw new Error(`No checkpoint in ${workDir}, so the spool has no provenance to record.`);
    if (!identity) {
      throw new Error(
        `The checkpoint in ${workDir} carries no run identity (it was written by an older build), so the spool cannot\n` +
          "  be adopted. Re-run the indexer with --no-resume to rebuild it.",
      );
    }
    const manifest = await adoptSpool(workDir, identity, inspection);
    console.log(`\nRecorded ${spoolManifestPathFor(workDir)}: ${manifest.totals.files} partition(s), ${manifest.totals.lines.toLocaleString()} rows.`);
    console.log("Nothing else was modified. Re-run the same command to merge it (pass 1 will be skipped).");
    process.exitCode = 0;
    return;
  }

  process.exitCode = inspection.verdict === "clean" ? 0 : 1;
}

function printSpoolInspection(inspection: SpoolInspection): void {
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
  console.log(`\nSpool inspection (read-only) — ${inspection.workDir}`);
  console.log(`  verdict              ${inspection.verdict}`);
  console.log(`  spool format         ${inspection.format}${inspection.format === 2 ? " (compact rows, framed gzip, resumable)" : " (legacy jsonl)"}`);
  console.log(`  partition files      ${inspection.totals.files}`);
  console.log(`  spool size           ${gb(inspection.totals.bytes)}`);
  if (inspection.progress) {
    console.log(`  progress ledger      ${inspection.progress.status} — ${inspection.progress.rows.toLocaleString()} rows, ${gb(inspection.progress.bytes)} committed`);
    for (const source of inspection.progress.sources) {
      console.log(`    ${source.id}               ${source.rowsRead.toLocaleString()} rows read${source.complete ? " (complete)" : ""}`);
    }
  }
  console.log(`  records              ${inspection.totals.records.toLocaleString()} (${inspection.totals.parsed.toLocaleString()} parsed)`);
  console.log(`  checkpoint           ${inspection.checkpoint.present ? `${inspection.checkpoint.stage}${inspection.checkpoint.hasIdentity ? "" : " (no run identity)"}` : "absent"}`);
  console.log(`  spool manifest       ${inspection.manifest ? (inspection.manifest.complete && inspection.manifest.matches ? `complete (${inspection.manifest.files} files)` : "present but not matching") : "absent"}`);
  console.log("  per-partition detail (file, records, bytes, checksum, first problem):");
  const shown = inspection.partitions.slice(0, 40);
  for (const entry of shown) {
    const problem = entry.problems[0];
    const detail = problem
      ? `problem at line ${problem.line}, byte offset ${problem.byteOffset.toLocaleString()} (${problem.kind}${problem.reason ? `: ${problem.reason}` : ""})`
      : entry.terminated
        ? "ok"
        : "last record not terminated";
    console.log(
      `    ${entry.file}  n=${entry.partition ?? "?"}  records=${entry.records}  bytes=${entry.bytes}  sha256=${entry.sha256?.slice(0, 12) ?? "-"}  ${detail}`,
    );
  }
  if (inspection.partitions.length > shown.length) console.log(`    … ${inspection.partitions.length - shown.length} more partition file(s)`);
  if (inspection.findings.length) {
    console.log("  findings");
    for (const finding of inspection.findings.slice(0, 40)) console.log(`    - ${finding}`);
    if (inspection.findings.length > 40) console.log(`    … ${inspection.findings.length - 40} more finding(s)`);
  } else {
    console.log("  findings             none — the spool is complete and matches its manifest");
  }
  console.log("\nNo record content is included in this report, and nothing was modified.");
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

  /*
   * `--remote` additionally reads every object back FROM R2 and compares content.
   * A local re-hash proves the files still match their own record; it says nothing
   * about the bucket. This is the check that makes "uploaded" mean "uploaded
   * intact", and it is what the full-index pipeline runs before activating.
   */
  if (flags.remote) {
    const credentials = credentialsFromEnv(config.upload?.bucket);
    if (!credentials) {
      console.error("\n--remote needs R2 credentials (R2_* variables or .r2-credentials.json).");
      process.exitCode = 1;
      return;
    }
    const client = new R2Client(credentials);
    const objects = lines.map((line) => JSON.parse(line) as { key: string; bytes: number });
    const offset = Number(typeof flags.offset === "string" ? flags.offset : 0) || 0;
    const limit = Number(typeof flags.limit === "string" ? flags.limit : objects.length) || objects.length;
    console.log(`\nRemote verification of ${version} (R2)…`);
    const remote = await verifyRemoteObjects(client, objects, {
      outputDir: resolve(config.outputDir),
      offset,
      limit,
      onProgress: (done, total) => {
        if (done % 50 === 0) console.log(`  verified ${done}/${total} from R2`);
      },
    });
    console.log(`  read back         ${remote.checked} object(s), ${(remote.bytes / 1e6).toFixed(1)} MB`);
    for (const problem of remote.problems.slice(0, 25)) console.log(`  ! ${problem.key} — ${problem.problem}`);
    if (remote.problems.length) {
      console.log(`  ${remote.problems.length} remote problem(s) — do NOT activate this version.`);
      process.exitCode = 1;
      return;
    }
    // The pointer may only be flipped when R2 also holds the manifest and report.
    const { objectCount, bytes } = await verifyRemoteVersion(client, version);
    console.log(`  uploaded manifest  ${objectCount} object(s), ${(bytes / 1e6).toFixed(1)} MB recorded, validation passed`);
    console.log(`  remote verdict     intact`);
  }
}

async function cmdPublish(config: IndexerConfig, flags: Record<string, string | boolean>): Promise<void> {
  const version = typeof flags.version === "string" ? flags.version : config.datasetVersion;
  if (!flags.yes) {
    console.error("Refusing to publish without --yes. Publishing changes what the application serves.");
    process.exitCode = 1;
    return;
  }
  /*
   * A LOCAL validation report is a fast, early refusal — but it is not proof: the
   * version can be absent from R2, or half-uploaded, and the local directory can
   * have been deleted since. `publishVersion` therefore verifies the uploaded
   * manifest and validation report before it flips the pointer, so publishing from
   * another machine (or after cleaning up the output) is safe as well.
   */
  const validationPath = resolve(config.outputDir, `manifests/${version}/validation.json`);
  if (existsSync(validationPath)) {
    const validation = JSON.parse(await readFile(validationPath, "utf8")) as { passed: boolean };
    if (!validation.passed) {
      console.error(`Version ${version} did not pass local validation and will not be published.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Local validation report for ${version} passed; verifying the uploaded copy in R2…`);
  } else {
    console.log(`No local output for ${version}; relying on the validation report uploaded with it.`);
  }
  const credentials = credentialsFromEnv(config.upload?.bucket);
  if (!credentials) {
    console.error(
      "R2 credentials are not set. Export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or upload the output directory with rclone and then create manifests/active.json manually.",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const { previousVersion } = await publishVersion(version, config.upload?.bucket);
    console.log(
      `Published ${version}. ` +
        (previousVersion
          ? `The previous version ${previousVersion} remains in R2 and can be reactivated from the Dataset page.`
          : "There was no previous active version."),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function usage(): void {
  console.log(`CompanyIntel indexer

  profile    Inspect both CSV files: headers, fill rates, mapping suggestions
  run        Stream, resolve, index, validate and optionally upload
  pass2-from-spool
             EXPERIMENTAL: merge a VERIFIED Pass 1 spool into a NEW dataset version
             without re-reading any source. The source run identity is validated,
             never rewritten; output and bookkeeping go to isolated directories;
             nothing is uploaded or published.
  spool      Read-only: inspect an existing spool/checkpoint after a failed run
             (positions only — never record content; modifies nothing)
  recover-spool
             Read-only ASSESSMENT of a legacy spool that has no checkpoint or
             manifest (proves the per-source contiguous prefix), and with --apply
             converts it into a NEW v2 work directory. Never modifies the source.
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
  --version <id>      dataset version id (run: default from the config;
                      pass2-from-spool: REQUIRED, and must differ from the source)
  --preflight-only    run: check auth, keys, TSV mapping, disk and RAM, then stop
                      (nothing is read in bulk, built or uploaded)
  --no-resume         ignore the checkpoint and start Pass 1 again; refuses to
                      delete an existing spool (add --discard-spool for that)
  --discard-spool     explicitly delete this work directory's spool before a
                      rebuild. Only this flag removes partitions.
  --spool-max-gb <n>  stop Pass 1 cleanly when the local spool reaches n GB
                      (the ledger stays resumable; nothing is deleted)
  --disk-floor <mb>   run: free-space floor pass 2 stops at (default 512 MB). Lower
                      it only when the machine cannot hold that much free space and
                      the run's output is known to be small — it is a safety margin,
                      not a correctness rule
  --repair-manifest   spool: record spool-manifest.json for an EXISTING spool whose
                      partitions all verify (the recovery path for a failed run
                      from a build that did not write a manifest)
  --work-dir <path>   run: use this work directory instead of the config's workDir
                      (required after recover-spool --apply, whose ledger lives in
                      the NEW directory; the legacy spool is never the target)
                      spool: inspect this directory instead of the config's workDir
                      pass2-from-spool: the NEW experimental directory for this
                      run's bookkeeping/shards (default: <source-work-dir>-<version>)
  --hashes            spool: also re-verify every partition checksum (re-reads it)
  --source-work-dir   pass2-from-spool: the verified Pass 1 work directory to import
                      (default: the config's workDir; always read only)
  --output-dir        pass2-from-spool: the NEW isolated output directory for the
                      experimental index (default: <config outputDir>-<version>)
  --expect-sample     pass2-from-spool: assert the source run's records-per-source
                      limit (e.g. 1000000); the recorded value is used when omitted
  --check-only        pass2-from-spool: validate the spool and prepare the isolated
                      bookkeeping, then stop before merging anything
  --target-work-dir   recover-spool --apply: the NEW empty directory for the v2
                      spool (default: none; required)
  --complete-sources  recover-spool --apply: comma-separated source ids the run's
                      own log proves were read to the end (e.g. csv1)
  --upload            upload generated objects to R2
  --remote            validate: also read every object back FROM R2 and compare content
                      (with --offset/--limit to bound one call)
  --offset <n>        validate --remote: first object to verify
  --limit <n>         validate --remote: how many objects to verify in this call
  --yes               confirm a publish operation

Example (Windows PowerShell)
  bun tools/indexer/src/cli.ts profile  --config tools/indexer/indexer.config.json
  bun tools/indexer/src/cli.ts run      --config tools/indexer/indexer.config.json --sample 100000 --version v1-sample
  bun tools/indexer/src/cli.ts pass2-from-spool --config tools/indexer/indexer.config.json \`
    --source-work-dir .indexer-work --work-dir .indexer-work-assoc \`
    --output-dir .indexer-output-assoc --version v1-bench-1m-assoc --expect-sample 1000000
`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  /*
   * `spool` is the one command that must work on a machine where the sources are
   * unreachable or the config has been edited since the failure — it inspects what
   * is on local disk. It therefore needs no config (the workDir from the config is
   * used when one is given) and never touches R2.
   */
  if (command === "recover-spool") {
    if (flags.help) {
      usage();
      return;
    }
    await cmdRecoverSpool(flags);
    return;
  }
  if (command === "spool") {
    // `spool --help` must not fall through to inspecting the default workDir.
    if (flags.help && !flags["work-dir"] && !flags.config) {
      usage();
      return;
    }
    const workDir = flags["work-dir"]
      ? resolve(String(flags["work-dir"]))
      : flags.config
        ? (await loadConfig(String(flags.config))).workDir
        : resolve(".indexer-work");
    await cmdSpool(workDir, flags);
    return;
  }
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
    case "pass2-from-spool":
      await cmdPass2FromSpool(config, flags);
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
