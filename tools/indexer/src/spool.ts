/**
 * Spool integrity: the manifest that proves pass 1 finished, and the read-only
 * inspection that tells an operator what a failed run actually left behind.
 *
 * WHY A MANIFEST
 * --------------
 * Pass 1 appends canonical rows to `workDir/spool/part-####.jsonl`. Pass 2 merges
 * those files. Nothing used to record which partitions pass 1 had *finished*, so
 * a checkpoint saying `pass2-merge` was treated as proof that every partition was
 * complete. It is not: a truncated partition (a lost write, a full disk, a killed
 * process) reads back as a *shorter but perfectly valid* file, and pass 2 would
 * merge it as if those rows had never existed — silent, unaccounted data loss.
 *
 * So pass 1 now records, for every partition it wrote:
 *
 *   - the file name and the partition number,
 *   - the exact byte length and record count,
 *   - a SHA-256 of the bytes,
 *
 * and writes that manifest ATOMICALLY (`<file>.tmp` + rename) only after every
 * stream has been closed and flushed. Its presence therefore means "pass 1
 * finished"; its absence means "do not trust this spool".
 *
 * INSPECTION IS READ ONLY
 * ----------------------
 * `inspectSpool` opens files for reading and nothing else. It reports positions
 * (file, partition, line, byte offset, record length, file size) and never the
 * content of a record, so its output is safe to paste into a report: no company
 * names, no emails, no phone numbers, no credentials.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { scanJsonlFile, type JsonlProblem } from "./jsonl";

export const SPOOL_DIR_NAME = "spool";
export const SPOOL_MANIFEST_FILE = "spool-manifest.json";
export const CHECKPOINT_FILE = "checkpoint.json";

/** Provenance shared with `CheckpointIdentity` in build.ts (structural, no cycle). */
export interface SpoolIdentity {
  version: string;
  sampleLimit: number | null;
  partitions: number;
  sources: { id: string; path: string; delimiter: string; columns: number }[];
}

export interface SpoolManifestEntry {
  /** File name inside the spool directory (`part-0007.jsonl`). */
  file: string;
  /** Partition number parsed out of the file name. */
  partition: number;
  bytes: number;
  lines: number;
  sha256: string;
}

export interface SpoolManifest {
  identity: SpoolIdentity;
  /** Only ever written as `true`, and only after every stream has been flushed. */
  complete: true;
  createdAt: string;
  partitions: SpoolManifestEntry[];
  totals: { files: number; lines: number; bytes: number };
}

export function spoolDirFor(workDir: string): string {
  return join(workDir, SPOOL_DIR_NAME);
}

export function spoolManifestPathFor(workDir: string): string {
  return join(workDir, SPOOL_MANIFEST_FILE);
}

export function checkpointPathFor(workDir: string): string {
  return join(workDir, CHECKPOINT_FILE);
}

/**
 * Write JSON through a temporary file and rename it into place.
 *
 * A rename is atomic on the same volume on every platform this indexer runs on,
 * so a reader either sees the previous file or the complete new one — never a
 * half-written manifest, and never "no manifest" for a spool that is complete.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

/**
 * Read the spool manifest, or `null` when there is none.
 *
 * A manifest that exists but does not parse is an ERROR rather than "no
 * manifest": it was written by this code, so an unreadable one means the work
 * directory is damaged, and silently rebuilding over it would hide that.
 */
export async function readSpoolManifest(workDir: string): Promise<SpoolManifest | null> {
  const path = spoolManifestPathFor(workDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} exists but could not be read (${error instanceof Error ? error.message : String(error)}). ` +
        "It records which spool partitions pass 1 finished, so the spool cannot be trusted without it. " +
        "Re-run with --no-resume to rebuild from the sources.",
    );
  }
  const manifest = parsed as SpoolManifest;
  if (!manifest || manifest.complete !== true || !Array.isArray(manifest.partitions)) {
    throw new Error(`${path} is not a complete spool manifest. Re-run with --no-resume to rebuild from the sources.`);
  }
  return manifest;
}

/** SHA-256 of a file, streamed (never loads the file into memory). */
export async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Read-only inspection                                                       */
/* -------------------------------------------------------------------------- */

export interface SpoolPartitionReport {
  file: string;
  partition: number | null;
  bytes: number;
  /** Records the reader could delimit. */
  records: number;
  /** Records that parsed as JSON. */
  parsed: number;
  /** False when the last record was not terminated — a truncated write. */
  terminated: boolean;
  sha256: string | null;
  problems: JsonlProblem[];
}

export interface SpoolCheckpointReport {
  path: string;
  present: boolean;
  stage: string | null;
  /** True when the recorded run identity is present (older builds wrote none). */
  hasIdentity: boolean;
  identity: SpoolIdentity | null;
  rowsRead: number | null;
}

export interface SpoolManifestReport {
  path: string;
  present: boolean;
  complete: boolean;
  files: number;
  lines: number;
  bytes: number;
  /** True when every recorded entry matches the file on disk right now. */
  matches: boolean;
  mismatches: string[];
}

export type SpoolVerdict = "clean" | "damaged" | "incomplete" | "empty";

export interface SpoolInspection {
  workDir: string;
  spoolDir: string;
  partitions: SpoolPartitionReport[];
  totals: { files: number; bytes: number; records: number; parsed: number };
  checkpoint: SpoolCheckpointReport;
  manifest: SpoolManifestReport | null;
  verdict: SpoolVerdict;
  /** Human-readable, sanitized findings — positions only, never record content. */
  findings: string[];
}

export interface InspectSpoolOptions {
  /** Problems reported per file before the scan moves on (default 10). */
  maxProblemsPerFile?: number;
  /**
   * Verify SHA-256 of every partition against the manifest. Off by default: it
   * re-reads the whole spool, which for a 64 GB dataset is minutes of disk. Size
   * and record count still have to match.
   */
  checkHashes?: boolean;
}

function partitionOfFile(file: string): number | null {
  const match = /^part-(\d{4})\.jsonl$/.exec(file);
  return match ? Number(match[1]) : null;
}

/**
 * Inspect an existing work directory: every partition, the checkpoint and the
 * manifest — without modifying anything.
 */
export async function inspectSpool(workDir: string, options: InspectSpoolOptions = {}): Promise<SpoolInspection> {
  const spoolDir = spoolDirFor(workDir);
  const maxProblemsPerFile = options.maxProblemsPerFile ?? 10;
  const findings: string[] = [];

  const files = (await readdir(spoolDir).catch(() => [] as string[]))
    .filter((name) => name.startsWith("part-") && name.endsWith(".jsonl"))
    .sort();

  const partitions: SpoolPartitionReport[] = [];
  const totals = { files: 0, bytes: 0, records: 0, parsed: 0 };

  for (const file of files) {
    const path = join(spoolDir, file);
    const hash = createHash("sha256");
    const scan = await scanJsonlFile(path, { maxProblems: maxProblemsPerFile, onChunk: (chunk) => hash.update(chunk) });
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    partitions.push({
      file,
      partition: partitionOfFile(file),
      bytes: size,
      records: scan.records,
      parsed: scan.parsed,
      terminated: scan.terminated,
      sha256: hash.digest("hex"),
      problems: scan.problems,
    });
    totals.files += 1;
    totals.bytes += size;
    totals.records += scan.records;
    totals.parsed += scan.parsed;
  }

  /* ------------------------------- checkpoint ------------------------------ */

  const checkpointPath = checkpointPathFor(workDir);
  const checkpoint: SpoolCheckpointReport = {
    path: checkpointPath,
    present: existsSync(checkpointPath),
    stage: null,
    hasIdentity: false,
    identity: null,
    rowsRead: null,
  };
  if (checkpoint.present) {
    try {
      const parsed = JSON.parse(await readFile(checkpointPath, "utf8")) as {
        stage?: string;
        identity?: SpoolIdentity;
        counters?: { rowsRead?: number };
      };
      checkpoint.stage = parsed.stage ?? null;
      checkpoint.identity = parsed.identity ?? null;
      checkpoint.hasIdentity = Boolean(parsed.identity);
      checkpoint.rowsRead = typeof parsed.counters?.rowsRead === "number" ? parsed.counters.rowsRead : null;
    } catch (error) {
      checkpoint.stage = "unreadable";
      findings.push(`checkpoint.json is present but unreadable (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  /* -------------------------------- manifest ------------------------------- */

  let manifestReport: SpoolManifestReport | null = null;
  const manifestPath = spoolManifestPathFor(workDir);
  if (existsSync(manifestPath)) {
    let manifest: SpoolManifest | null = null;
    const mismatches: string[] = [];
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SpoolManifest;
    } catch (error) {
      mismatches.push(`manifest is unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
    if (manifest) {
      const byFile = new Map(partitions.map((entry) => [entry.file, entry]));
      for (const entry of manifest.partitions ?? []) {
        const actual = byFile.get(entry.file);
        if (!actual) {
          mismatches.push(`${entry.file}: recorded in the manifest but missing on disk`);
          continue;
        }
        if (actual.bytes !== entry.bytes) mismatches.push(`${entry.file}: ${entry.bytes} B recorded, ${actual.bytes} B on disk`);
        if (actual.records !== entry.lines) mismatches.push(`${entry.file}: ${entry.lines} records recorded, ${actual.records} on disk`);
        if (options.checkHashes && actual.sha256 && actual.sha256 !== entry.sha256) mismatches.push(`${entry.file}: checksum differs`);
      }
      const recorded = new Set((manifest.partitions ?? []).map((entry) => entry.file));
      for (const actual of partitions) if (!recorded.has(actual.file)) mismatches.push(`${actual.file}: on disk but not in the manifest`);
    }
    manifestReport = {
      path: manifestPath,
      present: true,
      complete: manifest?.complete === true,
      files: manifest?.totals?.files ?? (manifest?.partitions?.length ?? 0),
      lines: manifest?.totals?.lines ?? 0,
      bytes: manifest?.totals?.bytes ?? 0,
      matches: mismatches.length === 0,
      mismatches,
    };
  }

  /* -------------------------------- findings ------------------------------- */

  const damaged = partitions.filter((entry) => entry.problems.length > 0 || !entry.terminated);
  for (const entry of damaged) {
    for (const problem of entry.problems) {
      findings.push(
        `${entry.file} (partition ${entry.partition ?? "?"}): ${problem.kind} record at line ${problem.line}, ` +
          `byte offset ${problem.byteOffset.toLocaleString()}, record ${problem.recordBytes?.toLocaleString() ?? "unknown"} B, ` +
          `file ${entry.bytes.toLocaleString()} B${problem.reason ? ` — ${problem.reason}` : ""}`,
      );
    }
    if (!entry.terminated && entry.problems.length === 0) {
      findings.push(`${entry.file} (partition ${entry.partition ?? "?"}): the last record is not terminated (truncated write)`);
    }
  }
  if (!checkpoint.present) findings.push(`no checkpoint.json in ${workDir}`);
  else if (!checkpoint.hasIdentity) findings.push("checkpoint.json has no run identity (written by an older build)");
  if (!manifestReport) {
    findings.push(`no ${SPOOL_MANIFEST_FILE} in ${workDir}: pass 1 never recorded which partitions it finished`);
  } else {
    if (!manifestReport.complete) findings.push(`${SPOOL_MANIFEST_FILE} is not marked complete`);
    for (const mismatch of manifestReport.mismatches.slice(0, 20)) findings.push(`${SPOOL_MANIFEST_FILE}: ${mismatch}`);
  }

  let verdict: SpoolVerdict;
  if (totals.files === 0) verdict = "empty";
  else if (damaged.length > 0 || (manifestReport && !manifestReport.matches)) verdict = "damaged";
  else if (!manifestReport || !manifestReport.complete) verdict = "incomplete";
  else verdict = "clean";

  return { workDir, spoolDir, partitions, totals, checkpoint, manifest: manifestReport, verdict, findings };
}

/**
 * Write the manifest for an existing spool that has none.
 *
 * This is the recovery path for a run that failed on a build which did not write
 * manifests: the partitions are re-verified (record count, JSON validity, a real
 * end-of-record terminator, SHA-256) and the manifest is only written when every
 * one of them is provably complete. If any partition is damaged, nothing is
 * written and the operator is told which one, rather than being handed a spool
 * that would silently lose rows.
 *
 * Callers must pass the identity the checkpoint already recorded, so adopting a
 * spool can never relabel it as a different run.
 */
export async function adoptSpool(workDir: string, identity: SpoolIdentity, inspection: SpoolInspection): Promise<SpoolManifest> {
  if (inspection.verdict === "empty") throw new Error(`No spool partitions found in ${inspection.spoolDir}.`);
  if (inspection.partitions.some((entry) => entry.problems.length > 0 || !entry.terminated || entry.sha256 === null)) {
    const first = inspection.partitions.find((entry) => entry.problems.length > 0 || !entry.terminated);
    throw new Error(
      `Refusing to record a spool manifest: ${first?.file ?? "a partition"} is not provably complete. ` +
        "Nothing was written. See the findings in this report for the exact position, then rebuild with --no-resume.",
    );
  }

  const manifest: SpoolManifest = {
    identity,
    complete: true,
    createdAt: new Date().toISOString(),
    partitions: inspection.partitions.map((entry) => ({
      file: entry.file,
      partition: entry.partition ?? 0,
      bytes: entry.bytes,
      lines: entry.records,
      sha256: entry.sha256 ?? "",
    })),
    totals: { files: inspection.totals.files, lines: inspection.totals.records, bytes: inspection.totals.bytes },
  };
  await writeJsonAtomic(spoolManifestPathFor(workDir), manifest);
  return manifest;
}

/** Remove a spool manifest so the next run rebuilds it (used by `--no-resume`). */
export async function clearSpoolManifest(workDir: string): Promise<void> {
  await unlink(spoolManifestPathFor(workDir)).catch(() => undefined);
}
