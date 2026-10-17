/**
 * Experimental Pass 2 rebuild from an existing, verified Pass 1 spool.
 *
 * WHY THIS EXISTS
 * ---------------
 * A run identity answers one question: "is this spool mine?". It is deliberately
 * strict — dataset version, sample limit, partition count and every source's
 * path/delimiter/override count — because resuming a spool written by a different
 * run would mix two inputs into one index with nothing failing.
 *
 * That strictness is right for an ordinary resume, and wrong for one specific,
 * explicit operation: "keep the source run exactly as it is, and merge its finished
 * Pass 1 spool into a NEW output version". The rows in the spool do not depend on
 * the output version — they depend on the sources, the sample limit, the partition
 * scheme and the mapping — so an operator who wants to measure a new Pass 2
 * (association rules, for example) should not have to re-read 64 GB to change a
 * label on the output.
 *
 * So the two concepts are separated HERE and only here:
 *
 *   - the SOURCE RUN IDENTITY (`workDir/checkpoint.json` + `spool-manifest.json`)
 *     is validated as recorded and never rewritten or renamed;
 *   - the OUTPUT INDEX VERSION is a new value supplied by the operator.
 *
 * `identityFor`/`identityDiff` in build.ts are unchanged, so an ordinary `run` (and
 * `--no-resume`) still refuses a version difference. Only this module — reached
 * through the `pass2-from-spool` command — is allowed to accept one, and it does so
 * by proving that everything except the version matches.
 *
 * WHAT IS VALIDATED, IN ORDER (all read-only)
 * -------------------------------------------
 *   1. isolation: the experimental work/output directories are not the source's,
 *      and neither contains the other — otherwise `resetPass2Output` could delete
 *      the source's `objects.jsonl` or a checkpoint write could replace the source
 *      checkpoint;
 *   2. the source checkpoint exists, parses, records stage `pass2-merge` and carries
 *      a run identity (a checkpoint from an older build has unknown provenance and
 *      is refused);
 *   3. the spool manifest exists, parses from the SAME bytes that are hashed, is
 *      marked complete, and describes exactly the run the checkpoint records;
 *   4. the operator's configuration matches the source identity except for the
 *      version: partition count, sample limit (carried from the checkpoint, and
 *      assertable with `--expect-sample`) and every source's id, path, delimiter and
 *      column-override count;
 *   5. the partition files on disk are exactly the manifest's list — none missing,
 *      none extra — with unique partition numbers inside the recorded partition
 *      count, and totals that add up;
 *   6. every partition's byte length matches, and on a first import every SHA-256
 *      matches. (A restart re-checks lengths up front and relies on the merge, which
 *      re-hashes each partition as it reads it.)
 *
 * WHAT IT WRITES (isolated only)
 * ------------------------------
 * Inside the experimental work directory, and nowhere else:
 *
 *   experimental-import.json   what source was imported, with the sha256 of the
 *                              source checkpoint and manifest it validated;
 *   spool-manifest.json        a DERIVED manifest: same partition entries and
 *                              totals, identity = the output run's identity;
 *   checkpoint.json            stage `pass2-merge`, output identity, the source
 *                              run's Pass 1 counters.
 *
 * These are new files in a new directory. The source `checkpoint.json`,
 * `spool-manifest.json`, `spool/part-*.jsonl` and the source output directory are
 * opened for reading only. `runIndex` is then told to merge from
 * `plan.sourceSpoolDir` with pass 1 and profiling skipped, so no source file or R2
 * object is read at all.
 *
 * RESTART SAFETY
 * --------------
 * The derived checkpoint is written LAST, so a crash during setup leaves either no
 * checkpoint (setup simply runs again) or a complete one. On a restart the import
 * record must still match — same source directory, same source checkpoint/manifest
 * checksums, same output version and output directory — or the run refuses rather
 * than merging different bytes into an artifact that already exists. `runIndex`
 * itself resets this version's shards and generated objects before replaying, so a
 * second attempt cannot append a duplicate posting or leave a stale object.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { identityDiff, identityFor, runIndex, type CheckpointIdentity, type IndexerConfig, type ProgressEvent, type RunResult } from "./build";
import { checkpointPathFor, hashFile, spoolDirFor, spoolManifestPathFor, writeJsonAtomic, type SpoolManifest, type SpoolManifestEntry } from "./spool";

/** Bookkeeping file that makes an experimental work directory restartable. */
export const EXPERIMENTAL_IMPORT_FILE = "experimental-import.json";

const PARTITION_FILE = /^part-(\d{4})\.jsonl$/;

/**
 * What `runIndex` needs to know about an import.
 *
 * `sourceWorkDir`/`sourceOutputDir` are carried so the engine itself can refuse the
 * two paths that would damage the source artifact, even if a caller ever builds
 * this object by hand: it must never clear the source spool, and it must never
 * write over the source output directory.
 */
export interface SpoolImportSource {
  spoolDir: string;
  /** Spooled rows, for the preflight estimate (no source is probed). */
  rows: number;
  sourceWorkDir: string;
  sourceOutputDir: string;
}

export interface SpoolImportRequest {
  /** The verified Pass 1 work directory. Read only. */
  sourceWorkDir: string;
  /** A new, isolated directory for this experiment's bookkeeping and shards. */
  workDir: string;
  /** A new, isolated directory for this experiment's generated index. */
  outputDir: string;
  /** The ordinary config's outputDir; must be isolated from `outputDir`. */
  sourceOutputDir: string;
  /** The version id to write. MUST differ from the source run's version. */
  outputVersion: string;
  /**
   * Everything in a run identity except the version, taken from the operator's
   * config. Must match the source checkpoint exactly.
   */
  expectation: { partitions: number; sources: CheckpointIdentity["sources"]; sampleLimit?: number | null };
}

interface SpoolImportBase extends SpoolImportSource {
  sourceSpoolDir: string;
  /** The experimental (new) work directory this run writes to. */
  workDir: string;
  /** The experimental (new, isolated) output directory. */
  outputDir: string;
  sourceIdentity: CheckpointIdentity;
  /** The source run's dataset version — kept intact, never used as the output. */
  sourceVersion: string;
  outputVersion: string;
  /** Records per source of the source run, carried into the output identity. */
  sampleLimit: number | null;
  partitions: number;
  spoolPartitions: number;
  totals: { files: number; lines: number; bytes: number };
  sourceCheckpointSha256: string;
  sourceManifestSha256: string;
  /** The verified manifest entries, sorted by partition. */
  entries: SpoolManifestEntry[];
}

export interface SpoolImportPlan extends SpoolImportBase {
  /** True when this call adopted an experimental work directory from an earlier attempt. */
  restarted: boolean;
  /** Facts proven by validation, for the operator-facing report. */
  checks: string[];
}

export interface ExperimentalPass2Request {
  sourceWorkDir: string;
  workDir: string;
  outputDir: string;
  outputVersion: string;
  /**
   * Optional assertion about the source run: its records-per-source limit. Omit to
   * accept the verified value as recorded (including `null` for a full run).
   */
  expectSampleLimit?: number | null;
}

interface CheckpointLike {
  stage?: string;
  identity?: CheckpointIdentity;
  counters?: Record<string, unknown>;
}

interface ImportRecord {
  format: 1;
  createdAt: string;
  sourceWorkDir: string;
  sourceSpoolDir: string;
  sourceIdentity: CheckpointIdentity;
  sourceCheckpointSha256: string;
  sourceManifestSha256: string;
  outputVersion: string;
  workDir: string;
  outputDir: string;
  spool: { files: number; lines: number; bytes: number };
}

/* -------------------------------------------------------------------------- */
/* Path isolation                                                             */
/* -------------------------------------------------------------------------- */

/** Case-insensitive on Windows, where `C:\a` and `c:\a` are the same directory. */
function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** True when `child` is strictly inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(comparable(parent), comparable(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertIsolation(params: { sourceWorkDir: string; workDir: string; outputDir: string; sourceOutputDir: string }): void {
  const { sourceWorkDir, workDir, outputDir, sourceOutputDir } = params;
  const refuse = (what: string, detail: string): never => {
    throw new Error(
      `Refusing the experimental import: ${what}.\n` +
        `  ${detail}\n` +
        "  Both locations must be separate directories. Nothing was read, written or deleted.",
    );
  };

  if (samePath(workDir, sourceWorkDir)) {
    refuse(
      `--work-dir is the source Pass 1 work directory (${sourceWorkDir})`,
      "The experimental bookkeeping (checkpoint.json, spool-manifest.json) is written into --work-dir, so writing it there would replace the original run's checkpoint.",
    );
  }
  if (isInside(sourceWorkDir, workDir) || isInside(workDir, sourceWorkDir)) {
    refuse(
      `--work-dir (${workDir}) and the source work directory (${sourceWorkDir}) contain one another`,
      "An experimental run must not share a directory tree with the spool it is reading.",
    );
  }
  if (samePath(outputDir, sourceOutputDir)) {
    refuse(
      `--output-dir is the ordinary output directory (${sourceOutputDir})`,
      "Pass 2 rewrites the version's objects AND the shared <outputDir>/objects.jsonl, so the original index (including v1-bench-1m) would be modified.",
    );
  }
  if (isInside(sourceOutputDir, outputDir) || isInside(outputDir, sourceOutputDir)) {
    refuse(
      `--output-dir (${outputDir}) and the ordinary output directory (${sourceOutputDir}) contain one another`,
      "The experimental index must be written outside the directory tree that holds the validated index.",
    );
  }
}

/** Version ids become path segments, so anything that could escape is refused. */
function assertVersionId(version: string): void {
  if (!version.trim()) throw new Error("Refusing the experimental import: --version is empty. Give the output dataset version, e.g. v1-bench-1m-assoc.");
  if (version.includes("/") || version.includes("\\") || version.includes("..") || version === "." ) {
    throw new Error(
      `Refusing the experimental import: version "${version}" is not a plain identifier.\n` +
        "  It becomes a directory name under the output directory, so path separators and `..` are refused.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A recorded identity is data from disk, so its shape is checked before it is
 * compared: a hand-edited or older checkpoint must produce a refusal with the
 * reason, not a TypeError halfway through validation.
 */
function assertIdentityShape(identity: unknown, where: string): asserts identity is CheckpointIdentity {
  const candidate = identity as Partial<CheckpointIdentity> | null;
  const problems: string[] = [];
  if (!candidate || typeof candidate !== "object") problems.push("it is missing");
  else {
    if (typeof candidate.version !== "string" || !candidate.version.trim()) problems.push("version is not a string");
    if (typeof candidate.partitions !== "number" || !Number.isInteger(candidate.partitions) || candidate.partitions <= 0) {
      problems.push("partitions is not a positive whole number");
    }
    if (!(candidate.sampleLimit === null || (typeof candidate.sampleLimit === "number" && Number.isInteger(candidate.sampleLimit) && candidate.sampleLimit > 0))) {
      problems.push("sampleLimit is neither null nor a positive whole number");
    }
    if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) problems.push("sources is empty");
    else {
      for (const source of candidate.sources) {
        if (!source || typeof source.id !== "string" || typeof source.path !== "string" || typeof source.delimiter !== "string" || typeof source.columns !== "number") {
          problems.push("a source entry is malformed");
          break;
        }
      }
    }
  }
  if (problems.length) {
    throw new Error(`Refusing the experimental import: the run identity in ${where} is invalid (${problems.join("; ")}).`);
  }
}

/**
 * The checkpoint's Pass 1 counters must be usable before the merge starts.
 *
 * A resumed/imported run restores `rowsRead`, `rowsRejected` and every source's
 * `rowsRead` from the checkpoint, and the final validation fails with
 * `source_missing_rows` if a source has none. Discovering that AFTER hours of
 * merging would waste the run, so the same fact is checked up front. Nothing is
 * written before this point.
 */
function assertPassOneCounters(counters: unknown, identity: CheckpointIdentity): void {
  const candidate = counters as { rowsRead?: unknown; perSource?: Record<string, { rowsRead?: unknown } | undefined> } | null | undefined;
  const problems: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    problems.push("it records no counters at all");
  } else if (typeof candidate.rowsRead !== "number" || !Number.isFinite(candidate.rowsRead) || candidate.rowsRead <= 0) {
    problems.push("rowsRead is not a positive number");
  } else {
    for (const source of identity.sources) {
      const entry = candidate.perSource?.[source.id];
      if (!entry || typeof entry.rowsRead !== "number" || !Number.isFinite(entry.rowsRead) || entry.rowsRead <= 0) {
        problems.push(`source ${source.id} has no positive rowsRead`);
      }
    }
  }
  if (problems.length) {
    throw new Error(
      `Refusing the experimental import: the source checkpoint's Pass 1 counters are not usable (${problems.join("; ")}).\n` +
        "  The imported run restores them so its validation can prove every source contributed; without them the merge would\n" +
        "  only fail at the very end. Nothing was written. Re-run the source Pass 1 if its checkpoint is damaged.",
    );
  }
}

async function readCheckpointSource(sourceWorkDir: string, outputVersion: string) {
  const path = checkpointPathFor(sourceWorkDir);
  if (!existsSync(path)) {
    throw new Error(
      `Refusing the experimental import: no ${path}.\n` +
        "  A Pass 2 rebuild needs a finished Pass 1 run to import. Run the source experiment first, or point --source-work-dir at its work directory.",
    );
  }
  const bytes = await readFile(path);
  let parsed: CheckpointLike;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as CheckpointLike;
  } catch (error) {
    throw new Error(
      `Refusing the experimental import: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (parsed.stage !== "pass2-merge") {
    throw new Error(
      `Refusing the experimental import: ${path} records stage "${parsed.stage ?? "none"}", not "pass2-merge".\n` +
        "  Only a checkpoint written AFTER Pass 1 finished proves the spool can be merged.",
    );
  }
  if (!parsed.identity || !Array.isArray(parsed.identity.sources)) {
    throw new Error(
      `Refusing the experimental import: ${path} carries no run identity (it was written by an older build), so the spool's provenance is unknown.`,
    );
  }
  assertIdentityShape(parsed.identity, path);
  const identity = parsed.identity;
  if (identity.version === outputVersion) {
    throw new Error(
      `Refusing the experimental import: the output version "${outputVersion}" is the source run's own version.\n` +
        "  That is an ordinary resume, not an experimental rebuild — run `bun tools/indexer/src/cli.ts run --config <cfg> --version " +
        `${outputVersion}\` against ${sourceWorkDir} instead.`,
    );
  }
  return { identity, counters: parsed.counters ?? {}, sha256: sha256(bytes), path };
}

function parseManifestBytes(bytes: Buffer, path: string): SpoolManifest {
  let parsed: SpoolManifest;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as SpoolManifest;
  } catch (error) {
    throw new Error(
      `Refusing the experimental import: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!parsed || parsed.complete !== true || !Array.isArray(parsed.partitions)) {
    throw new Error(
      `Refusing the experimental import: ${path} is not a complete spool manifest, so Pass 1 cannot be shown to have finished every partition.`,
    );
  }
  return parsed;
}

function assertManifestSelfConsistent(manifest: SpoolManifest, path: string, partitions: number): void {
  const entries = manifest.partitions;
  if (!entries.length) throw new Error(`Refusing the experimental import: ${path} records no partitions, so the spool is empty.`);
  const seenFiles = new Set<string>();
  const seenPartitions = new Set<number>();
  let lines = 0;
  let bytes = 0;
  for (const entry of entries) {
    const match = PARTITION_FILE.exec(entry.file);
    if (!match) throw new Error(`Refusing the experimental import: ${path} lists "${entry.file}", which is not a spool partition file name.`);
    if (seenFiles.has(entry.file)) throw new Error(`Refusing the experimental import: ${path} lists ${entry.file} twice.`);
    seenFiles.add(entry.file);
    if (!Number.isInteger(entry.partition) || entry.partition !== Number(match[1])) {
      throw new Error(`Refusing the experimental import: ${path} records partition ${entry.partition} for ${entry.file}, which disagrees with its name.`);
    }
    if (seenPartitions.has(entry.partition)) throw new Error(`Refusing the experimental import: ${path} records partition ${entry.partition} twice.`);
    seenPartitions.add(entry.partition);
    if (entry.partition >= partitions) {
      throw new Error(`Refusing the experimental import: partition ${entry.partition} is outside the run's ${partitions} partitions.`);
    }
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0 || !Number.isFinite(entry.lines) || entry.lines < 0) {
      throw new Error(`Refusing the experimental import: ${entry.file} has an invalid length or record count in ${path}.`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Refusing the experimental import: ${entry.file} has no valid SHA-256 in ${path}.`);
    }
    lines += entry.lines;
    bytes += entry.bytes;
  }
  if (manifest.totals?.files !== entries.length || manifest.totals?.lines !== lines || manifest.totals?.bytes !== bytes) {
    throw new Error(
      `Refusing the experimental import: ${path} totals (${manifest.totals?.files ?? "?"} files, ${manifest.totals?.lines ?? "?"} rows, ` +
        `${manifest.totals?.bytes ?? "?"} bytes) do not match its own partition list (${entries.length} files, ${lines} rows, ${bytes} bytes).`,
    );
  }
}

async function assertPartitionsOnDisk(sourceSpoolDir: string, manifest: SpoolManifest, verifyHashes: boolean): Promise<number> {
  if (!existsSync(sourceSpoolDir)) {
    throw new Error(`Refusing the experimental import: ${sourceSpoolDir} does not exist, so there is no spool to merge.`);
  }
  const onDisk = (await readdir(sourceSpoolDir)).filter((name) => PARTITION_FILE.test(name)).sort();
  const recorded = new Set(manifest.partitions.map((entry) => entry.file));
  const missing = [...recorded].filter((file) => !onDisk.includes(file));
  const extra = onDisk.filter((file) => !recorded.has(file));
  if (missing.length || extra.length) {
    throw new Error(
      "Refusing the experimental import: the spool directory does not contain exactly the partitions the manifest records.\n" +
        (missing.length ? `  missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ""}\n` : "") +
        (extra.length ? `  not in the manifest: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ` (+${extra.length - 8} more)` : ""}\n` : "") +
        "  A run must not merge files Pass 1 did not record.",
    );
  }
  for (const entry of [...manifest.partitions].sort((a, b) => a.partition - b.partition)) {
    const path = join(sourceSpoolDir, entry.file);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error(`Refusing the experimental import: spool partition ${entry.file} disappeared while it was being validated.`);
    if (info.size !== entry.bytes) {
      throw new Error(
        `Refusing the experimental import: spool partition ${entry.file} is ${info.size.toLocaleString()} B on disk but ` +
          `${entry.bytes.toLocaleString()} B in the manifest.\n` +
          "  A shorter partition is still valid JSONL, so merging it would silently drop the missing rows. Nothing was written.",
      );
    }
    if (verifyHashes) {
      const digest = await hashFile(path);
      if (digest !== entry.sha256) {
        throw new Error(
          `Refusing the experimental import: spool partition ${entry.file} does not match the SHA-256 recorded by Pass 1.\n` +
            "  The file changed after Pass 1 wrote it, so it will not be merged. Nothing was written.",
        );
      }
    }
  }
  return onDisk.length;
}

function assertSameSourceRun(identity: CheckpointIdentity, expected: SpoolImportRequest["expectation"], outputVersion: string): void {
  const expectedIdentity: CheckpointIdentity = {
    version: identity.version,
    // `undefined` means "accept what the checkpoint recorded"; an explicit value is asserted.
    sampleLimit: expected.sampleLimit === undefined ? identity.sampleLimit : expected.sampleLimit,
    partitions: expected.partitions,
    sources: expected.sources,
  };
  const differences = identityDiff(identity, expectedIdentity);
  if (differences.length) {
    throw new Error(
      `Refusing the experimental import: the configuration does not describe the run that wrote this spool (${differences.join("; ")}).\n` +
        "  Only the output version may differ. A different source, sample limit, partition count or mapping would mean merging rows the spool does not contain.\n" +
        `  The spool's own identity is version ${identity.version}; the requested output version (${outputVersion}) is not compared here.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Experimental workspace                                                     */
/* -------------------------------------------------------------------------- */

type ImportedCheckpoint = { stage: string; identity: CheckpointIdentity; counters: Record<string, unknown> };

async function readJsonFile(path: string, what: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(
      `Refusing the experimental import: ${what} at ${path} could not be read (${error instanceof Error ? error.message : String(error)}).\n` +
        "  Nothing was written. Use a new --work-dir if this directory is damaged.",
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Refusing the experimental import: ${what} at ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).\n` +
        "  Nothing was written. Use a new --work-dir if this directory is damaged.",
    );
  }
}

/**
 * Adopt or create the experimental work directory.
 *
 * Returns `true` when an earlier attempt's workspace was adopted (restart). The
 * import record is the identity of this experiment: if it describes a different
 * source, version or output directory the run stops. The derived manifest and
 * checkpoint are disposable (rebuilt from the validated source on every attempt),
 * so a crash part-way through setup is recovered instead of blocking the restart.
 */
async function prepareWorkspace(planBase: SpoolImportBase, counters: Record<string, unknown>): Promise<boolean> {
  const { workDir, outputDir, outputVersion, sourceWorkDir, sourceSpoolDir, sourceIdentity, sourceCheckpointSha256, sourceManifestSha256, totals } = planBase;
  const recordPath = join(workDir, EXPERIMENTAL_IMPORT_FILE);
  const experimentalCheckpoint = checkpointPathFor(workDir);
  const outputIdentity: CheckpointIdentity = {
    version: outputVersion,
    sampleLimit: sourceIdentity.sampleLimit,
    partitions: sourceIdentity.partitions,
    sources: sourceIdentity.sources,
  };
  /**
   * The experimental run's own manifest and checkpoint. Both are DERIVED from the
   * validated source and are rewritten on every attempt, so a crash between the
   * record and the checkpoint (or a damaged derived file) is repaired rather than
   * blocking the restart. They are never the source of truth: the source manifest
   * is re-read and re-hashed on every attempt.
   */
  const derivedManifest: SpoolManifest = {
    identity: outputIdentity,
    complete: true,
    createdAt: new Date().toISOString(),
    partitions: planBase.entries,
    totals,
  };
  const importedCheckpoint: ImportedCheckpoint = { stage: "pass2-merge", identity: outputIdentity, counters };

  if (!existsSync(recordPath)) {
    if (existsSync(experimentalCheckpoint)) {
      throw new Error(
        `Refusing the experimental import: ${experimentalCheckpoint} exists but ${recordPath} does not.\n` +
          "  This work directory belongs to a run this command did not create, and overwriting its checkpoint is not allowed. Use a new, empty --work-dir.",
      );
    }
    const stale = (await readdir(spoolDirFor(workDir)).catch(() => [] as string[])).filter((name) => PARTITION_FILE.test(name));
    if (stale.length) {
      throw new Error(
        `Refusing the experimental import: ${spoolDirFor(workDir)} already holds ${stale.length} spool partition file(s).\n` +
          "  This command never writes spool partitions, so that directory is another run's. Use a new, empty --work-dir.",
      );
    }

    const record: ImportRecord = {
      format: 1,
      createdAt: new Date().toISOString(),
      sourceWorkDir,
      sourceSpoolDir,
      sourceIdentity,
      sourceCheckpointSha256,
      sourceManifestSha256,
      outputVersion,
      workDir,
      outputDir,
      spool: totals,
    };
    await mkdir(workDir, { recursive: true });
    // Order: record first (so a partial setup is self-describing), manifest second,
    // checkpoint LAST — the checkpoint is what `runIndex` treats as "Pass 1 is done".
    await writeJsonAtomic(recordPath, record);
    await writeJsonAtomic(spoolManifestPathFor(workDir), derivedManifest);
    await writeJsonAtomic(experimentalCheckpoint, importedCheckpoint);
    return false;
  }

  const record = (await readJsonFile(recordPath, "the experimental import record")) as ImportRecord;
  assertIdentityShape(record?.sourceIdentity, recordPath);
  const problems: string[] = [];
  if (record?.format !== 1) problems.push("its format is not 1");
  if (record?.sourceWorkDir !== sourceWorkDir) problems.push(`it imports from ${record?.sourceWorkDir ?? "unknown"}`);
  if (record?.sourceSpoolDir !== sourceSpoolDir) problems.push(`its spool is ${record?.sourceSpoolDir ?? "unknown"}`);
  if (record?.outputVersion !== outputVersion) problems.push(`it was created for version ${record?.outputVersion ?? "unknown"}`);
  if (record?.workDir !== workDir) problems.push(`it was created for work directory ${record?.workDir ?? "unknown"}`);
  if (record?.outputDir !== outputDir) problems.push(`it wrote to ${record?.outputDir ?? "unknown"}`);
  if (record?.sourceCheckpointSha256 !== sourceCheckpointSha256) problems.push("the source checkpoint has changed since this experiment started");
  if (record?.sourceManifestSha256 !== sourceManifestSha256) problems.push("the source spool manifest has changed since this experiment started");
  if (identityDiff(record.sourceIdentity, sourceIdentity).length) {
    problems.push("the source run identity it recorded is different");
  }
  if (problems.length) {
    throw new Error(
      `Refusing to reuse ${workDir}: ${problems.join("; ")}.\n` +
        "  Merging this spool now would write different rows into an artifact that already exists.\n" +
        "  Use a new, empty --work-dir (and --output-dir) for a separate experiment; nothing was changed.",
    );
  }

  /*
   * The record matches, so this is a restart of the same experiment. The derived
   * manifest and checkpoint are rewritten from the validated source (atomic writes,
   * checkpoint last) rather than trusted: after a crash between the record and the
   * checkpoint, or after a partial cleanup, the derived state may be missing, and
   * it is never the proof of anything — the source manifest is.
   */
  await mkdir(workDir, { recursive: true });
  await writeJsonAtomic(spoolManifestPathFor(workDir), derivedManifest);
  await writeJsonAtomic(experimentalCheckpoint, importedCheckpoint);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate a source Pass 1 spool and prepare the isolated experimental workspace.
 * Reads the source; writes only inside `request.workDir`.
 */
export async function prepareSpoolImport(request: SpoolImportRequest): Promise<SpoolImportPlan> {
  const outputVersion = request.outputVersion.trim();
  assertVersionId(outputVersion);

  const sourceWorkDir = resolve(request.sourceWorkDir);
  const workDir = resolve(request.workDir);
  const outputDir = resolve(request.outputDir);
  assertIsolation({ sourceWorkDir, workDir, outputDir, sourceOutputDir: resolve(request.sourceOutputDir) });

  const checks: string[] = [];

  /* 1. Source checkpoint: exists, finished Pass 1, has provenance, different version. */
  const source = await readCheckpointSource(sourceWorkDir, outputVersion);
  const sourceIdentity = source.identity;
  assertPassOneCounters(source.counters, sourceIdentity);
  checks.push(`source checkpoint: stage pass2-merge, version ${sourceIdentity.version}, sha256 ${source.sha256.slice(0, 12)}…`);

  /* 2. Manifest: complete, same run as the checkpoint, self-consistent. */
  const manifestPath = spoolManifestPathFor(sourceWorkDir);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Refusing the experimental import: ${manifestPath} is missing.\n` +
        "  Without it Pass 1 cannot be shown to have finished every partition. Run `bun run index:spool-doctor`; if every partition reads ok, " +
        "`--repair-manifest` records it, otherwise the spool has to be rebuilt.",
    );
  }
  const manifestBytes = await readFile(manifestPath);
  const sourceManifestSha256 = sha256(manifestBytes);
  const manifest = parseManifestBytes(manifestBytes, manifestPath);
  assertIdentityShape(manifest.identity, manifestPath);
  const manifestDiff = identityDiff(manifest.identity, sourceIdentity);
  if (manifestDiff.length) {
    throw new Error(
      `Refusing the experimental import: the spool manifest and the checkpoint describe different runs (${manifestDiff.join("; ")}).\n` +
        "  One of them was replaced; nothing was read in bulk and nothing was written.",
    );
  }
  assertManifestSelfConsistent(manifest, manifestPath, sourceIdentity.partitions);
  checks.push(`source manifest: complete, ${manifest.partitions.length} partitions, ${manifest.totals.lines.toLocaleString()} rows, ${manifest.totals.bytes.toLocaleString()} bytes`);

  /* 3. Configuration: same run, except the output version. */
  assertSameSourceRun(sourceIdentity, request.expectation, outputVersion);
  const sampleLimit = sourceIdentity.sampleLimit;
  checks.push(
    `source configuration: ${sourceIdentity.sources.length} sources, ${sourceIdentity.partitions} partitions, ` +
      `${sampleLimit === null ? "no sample limit" : `${sampleLimit.toLocaleString()} records per source`}`,
  );

  /* 4. Restart detection decides how much hashing is needed. */
  const recordPath = join(workDir, EXPERIMENTAL_IMPORT_FILE);
  const restarted = existsSync(recordPath);
  const sourceSpoolDir = spoolDirFor(sourceWorkDir);
  const spoolPartitions = await assertPartitionsOnDisk(sourceSpoolDir, manifest, !restarted);
  checks.push(
    restarted
      ? `source partitions: ${spoolPartitions} files, lengths verified (the merge re-hashes each one as it reads it)`
      : `source partitions: ${spoolPartitions} files, lengths and SHA-256 verified`,
  );

  /* 5. Experimental workspace: created once, adopted only when unchanged. */
  const planBase: SpoolImportBase = {
    sourceWorkDir,
    sourceSpoolDir,
    spoolDir: sourceSpoolDir,
    sourceOutputDir: resolve(request.sourceOutputDir),
    workDir,
    outputDir,
    sourceIdentity,
    sourceVersion: sourceIdentity.version,
    outputVersion,
    sampleLimit,
    partitions: sourceIdentity.partitions,
    spoolPartitions,
    entries: [...manifest.partitions].sort((a, b) => a.partition - b.partition),
    totals: { files: manifest.totals.files, lines: manifest.totals.lines, bytes: manifest.totals.bytes },
    rows: manifest.totals.lines,
    sourceCheckpointSha256: source.sha256,
    sourceManifestSha256,
  };

  const adopted = await prepareWorkspace(planBase, source.counters);
  if (adopted) checks.push(`experimental workspace: ${workDir} adopted from an earlier attempt (same source, same output version)`);

  return { ...planBase, restarted: adopted, checks };
}

/**
 * Run Pass 2 from an already-validated plan.
 *
 * Separate from `runExperimentalPass2` so the CLI can print what validation proved
 * BEFORE the merge starts without validating (and re-hashing every partition) a
 * second time.
 *
 * Nothing is uploaded and `manifests/active.json` is never written — there is no
 * code path from here to `uploadOutput` or `publishVersion`.
 */
export async function executeSpoolImport(
  config: IndexerConfig,
  plan: SpoolImportPlan,
  options: { onProgress?: (event: ProgressEvent) => void } = {},
): Promise<RunResult> {
  const effective: IndexerConfig = {
    ...config,
    datasetVersion: plan.outputVersion,
    workDir: plan.workDir,
    outputDir: plan.outputDir,
  };

  return runIndex(effective, {
    // The source run's limit, carried through so the output identity matches the
    // derived checkpoint without ever re-reading a source.
    sampleLimit: plan.sampleLimit ?? undefined,
    spoolImport: {
      spoolDir: plan.sourceSpoolDir,
      rows: plan.totals.lines,
      sourceWorkDir: plan.sourceWorkDir,
      sourceOutputDir: plan.sourceOutputDir,
    },
    resume: true,
    onProgress: options.onProgress,
  });
}

/** Validate the source spool and run Pass 2 into an isolated output directory. */
export async function runExperimentalPass2(
  config: IndexerConfig,
  request: ExperimentalPass2Request,
  options: { onProgress?: (event: ProgressEvent) => void } = {},
): Promise<{ plan: SpoolImportPlan; result: RunResult }> {
  const plan = await prepareSpoolImport({
    sourceWorkDir: request.sourceWorkDir,
    workDir: request.workDir,
    outputDir: request.outputDir,
    sourceOutputDir: config.outputDir,
    outputVersion: request.outputVersion,
    expectation: {
      partitions: config.partitions,
      sources: identityFor(config, undefined).sources,
      sampleLimit: request.expectSampleLimit,
    },
  });
  const result = await executeSpoolImport(config, plan, options);
  return { plan, result };
}

/** Directory this command defaults to for its bookkeeping, next to the source run. */
export function defaultExperimentalWorkDir(sourceWorkDir: string, outputVersion: string): string {
  return join(dirname(resolve(sourceWorkDir)), `${basename(resolve(sourceWorkDir))}-${outputVersion}`);
}

/** Default isolated output directory, next to the ordinary one. */
export function defaultExperimentalOutputDir(outputDir: string, outputVersion: string): string {
  return join(dirname(resolve(outputDir)), `${basename(resolve(outputDir))}-${outputVersion}`);
}

