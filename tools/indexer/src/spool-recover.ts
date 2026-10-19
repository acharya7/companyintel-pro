/**
 * Recovery of a legacy (format 1) Pass 1 spool that has no checkpoint or manifest.
 *
 * THE SITUATION THIS EXISTS FOR
 * -----------------------------
 * A full run was interrupted by ENOSPC after writing 66,333,763 rows into
 * `spool/part-####.jsonl`. The build that wrote it recorded no checkpoint and no
 * spool manifest, so the ordinary resume path refuses it — correctly, because
 * "the records parse" is not evidence that the rows are complete, unique, or
 * attributable to a source range.
 *
 * This module does not assume. It builds the evidence from the rows themselves:
 * every format-1 row carries `source: {source, row}`, where `row` is the line
 * number in the source file. That pair is a unique identity for a source record,
 * so a bounded-memory scan can prove exactly which source rows were written:
 *
 *   - each source's rows form a contiguous prefix (header line 1, data 2..N);
 *   - no row is recorded twice;
 *   - every partition file holds only rows whose hash partition is its own;
 *   - no partition ends mid-record.
 *
 * If — and only if — those properties hold, Pass 1 can continue at row N+1 for
 * each source without losing or duplicating a record. The evidence is printed and
 * the conversion refuses anything else.
 *
 * WHAT `apply` WRITES
 * -------------------
 * A SEPARATE target work directory (never the source): a format-2 spool (compact
 * rows, framed gzip), the schema derived from the legacy rows, and a progress
 * ledger positioned at the proven continuation point. The source spool is opened
 * for reading only and is never modified, truncated or deleted.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readJsonlLines } from "./jsonl";
import { existsSync as fileExists } from "node:fs";
import { buildColumnMap, partitionFor } from "./mapping";
import {
  SPOOL_FORMAT_VERSION,
  SPOOL_V1_FILE_RE,
  SPOOL_V2_FILE_RE,
  SpoolV2Writer,
  assertSchema,
  encodeSpoolV2Row,
  normalizeValues,
  progressPathFor,
  readSchema,
  writeProgress,
  writeSchema,
  type SpoolProgress,
  type SpoolSchema,
  type SpoolSourceSchema,
} from "./spool-v2";

/** Growable bitset over 1-based source row numbers. */
export class RowSet {
  private bits = new Uint8Array(1024);
  count = 0;
  max = 0;

  private ensure(row: number): void {
    const bytes = (row >>> 3) + 1;
    if (bytes <= this.bits.length) return;
    let size = this.bits.length;
    while (size < bytes) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bits);
    this.bits = grown;
  }

  /** Returns false when the row was already present. */
  add(row: number): boolean {
    this.ensure(row);
    const byte = row >>> 3;
    const mask = 1 << (row & 7);
    if (this.bits[byte] & mask) return false;
    this.bits[byte] |= mask;
    this.count += 1;
    if (row > this.max) this.max = row;
    return true;
  }

  has(row: number): boolean {
    const byte = row >>> 3;
    if (byte >= this.bits.length) return false;
    return (this.bits[byte] & (1 << (row & 7))) !== 0;
  }

  /** Largest k such that every row 1..k is present (row 1 is the header). */
  prefix(): number {
    if (this.count === 0) return 0;
    // Row 1 (the header) was never spooled; a spool row at line 2 is the first
    // data record, so the prefix starts at 1 by definition.
    let row = 2;
    while (row <= this.max && this.has(row)) row += 1;
    return row - 1;
  }

  /** First missing row in 2..max, or null when the set is a contiguous prefix. */
  firstGap(): number | null {
    for (let row = 2; row <= this.max; row += 1) if (!this.has(row)) return row;
    return null;
  }
}

export interface RecoveryFileReport {
  file: string;
  partition: number | null;
  bytes: number;
  records: number;
  /** Records whose partition did not match the file they were written to. */
  partitionMismatches: number;
  /** Records that could not be parsed — the file is treated as damaged. */
  parseErrors: number;
  truncated: boolean;
}

export interface RecoverySourceReport {
  id: string;
  records: number;
  unique: number;
  duplicates: number;
  /**
   * Source rows recorded in `rejected.jsonl` — rows the run READ but could not
   * index (no company name). They are accounted for, not missing.
   */
  rejected: number;
  /**
   * First source row that is in NEITHER the spool nor rejected.jsonl, i.e.
   * genuinely unaccounted (null when every row is accounted for).
   */
  firstGap: number | null;
  /**
   * Largest contiguous prefix of ACCOUNTED source rows (spooled + rejected),
   * starting at the header. This is the line Pass 1 may resume after.
   */
  prefixRows: number;
  maxRow: number;
}

export type RecoveryVerdict = "empty" | "already-v2" | "recoverable" | "unusable";

export interface RecoveryAssessment {
  workDir: string;
  spoolDir: string;
  format: 1 | 2;
  partitions: number;
  files: RecoveryFileReport[];
  totals: { files: number; bytes: number; records: number; duplicates: number; partitionMismatches: number };
  sources: RecoverySourceReport[];
  /** The schema derived from the legacy rows (null when the spool is unusable). */
  schema: SpoolSchema | null;
  verdict: RecoveryVerdict;
  /** Proven source rows that can be adopted (per source id). */
  continuation: Record<string, number>;
  findings: string[];
}

export interface AssessOptions {
  /** Partition count the spool was built with (default 256, the production config). */
  partitions?: number;
  /** Rows inspected before the report stops reading (diagnostic only; default all). */
  maxRecords?: number;
}

interface FieldCandidates {
  /** Candidate columns still consistent with every observed canonical value. */
  candidates: Set<number>;
  /** True until the first observed value has narrowed the candidate set. */
  sealed: boolean;
}

/** Canonical fields whose value should equal a source column verbatim. */
const COMPANY_FIELDS = ["name", "domain", "website", "linkedinUrl", "sourceId", "industry", "subIndustry", "country", "state", "city", "companySize", "revenue"];
const CONTACT_FIELDS = ["name", "firstName", "lastName", "title", "designation", "seniority", "department", "email", "phone", "linkedinUrl", "country", "state", "city"];

type LegacyRow = {
  keys?: string[];
  partitionKey?: string;
  normalizedName?: string;
  company?: Record<string, unknown> & { attributes?: Record<string, string> };
  contact?: (Record<string, unknown> & { attributes?: Record<string, string> }) | null;
  source?: { source?: string; row?: number };
};

interface SourceAccumulator {
  rows: RowSet;
  records: number;
  duplicates: number;
  /** labels in file order, from the first row that carried attributes. */
  labels: string[] | null;
  /** Per canonical field candidate columns, discovered from the first rows. */
  candidates: Map<string, FieldCandidates>;
  discoveryRows: number;
  /** Source rows the run rejected (no company name); accounted for, not spooled. */
  rejected: RowSet;
  /** Rejected rows inside the proven prefix, for the restored counters. */
  rejectedInPrefix: number;
}

function newAccumulator(): SourceAccumulator {
  return { rows: new RowSet(), records: 0, duplicates: 0, labels: null, candidates: new Map(), discoveryRows: 0, rejected: new RowSet(), rejectedInPrefix: 0 };
}

const DISCOVERY_ROWS = 5_000;

/**
 * Narrow the canonical field → column candidates using one row.
 *
 * The first few thousand rows discover candidates (every column whose value
 * equals the field's); after that only the surviving candidates are checked, so
 * this stays O(1) per field per row instead of O(columns).
 */
function observeCanonicalValues(
  accumulator: SourceAccumulator,
  values: string[],
  input: Record<string, unknown>,
  fields: string[],
): void {
  const index = new Map<string, number[]>();
  for (let column = 0; column < values.length; column += 1) {
    const value = values[column];
    if (!value) continue;
    const list = index.get(value);
    if (list) list.push(column);
    else index.set(value, [column]);
  }
  const discovering = accumulator.discoveryRows < DISCOVERY_ROWS;
  for (const field of fields) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const text = String(raw).trim();
    if (!text) continue;
    const matches = index.get(text) ?? [];
    let state = accumulator.candidates.get(field);
    if (!state) {
      state = { candidates: new Set(discovering ? matches : []), sealed: false };
      accumulator.candidates.set(field, state);
      continue;
    }
    if (discovering && !state.sealed) {
      for (const column of matches) state.candidates.add(column);
      for (const column of [...state.candidates]) if (!matches.includes(column)) state.candidates.delete(column);
      continue;
    }
    // After discovery only the surviving candidates are validated.
    for (const column of [...state.candidates]) {
      if (!matches.includes(column)) state.candidates.delete(column);
    }
    state.sealed = true;
  }
  if (discovering) accumulator.discoveryRows += 1;
}

function chooseColumn(candidates: Set<number>): number | null {
  if (!candidates.size) return null;
  return [...candidates].sort((a, b) => a - b)[0];
}

function attributesToValues(labels: string[], attributes: Record<string, string> | undefined): string[] {
  return labels.map((label) => (attributes && label in attributes ? attributes[label] : ""));
}

/**
 * Read the whole legacy spool and prove (or refuse) resumability.
 *
 * Bounded memory: two bitsets (rows + duplicates) at 1 bit per source row, plus
 * one column-label list per source. Nothing is written.
 */
export async function assessLegacySpool(workDir: string, options: AssessOptions = {}): Promise<RecoveryAssessment> {
  const root = resolve(workDir);
  const spoolDir = join(root, "spool");
  const partitionsCount = options.partitions ?? 256;
  const names = (await readdir(spoolDir).catch(() => [] as string[])).sort();
  const legacy = names.filter((name) => SPOOL_V1_FILE_RE.test(name));
  const modern = names.filter((name) => SPOOL_V2_FILE_RE.test(name));

  if (modern.length) {
    const schema = await readSchema(root).catch(() => null);
    return {
      workDir: root,
      spoolDir,
      format: 2,
      partitions: partitionsCount,
      files: [],
      totals: { files: modern.length, bytes: 0, records: 0, duplicates: 0, partitionMismatches: 0 },
      sources: [],
      schema,
      verdict: "already-v2",
      continuation: {},
      findings: [
        `${modern.length} v2 partition file(s) are present — this is not a legacy spool.`,
        `Resume it with the ordinary command; its ledger is ${progressPathFor(root)}.`,
      ],
    };
  }
  if (!legacy.length) {
    return {
      workDir: root,
      spoolDir,
      format: 1,
      partitions: partitionsCount,
      files: [],
      totals: { files: 0, bytes: 0, records: 0, duplicates: 0, partitionMismatches: 0 },
      sources: [],
      schema: null,
      verdict: "empty",
      continuation: {},
      findings: [`no spool partition files in ${spoolDir}`],
    };
  }

  const files: RecoveryFileReport[] = [];
  const accumulators = new Map<string, SourceAccumulator>();
  const findings: string[] = [];
  let records = 0;
  let duplicates = 0;
  let partitionMismatches = 0;
  let bytes = 0;
  let stopped = false;

  for (const file of legacy) {
    if (stopped) break;
    const path = join(spoolDir, file);
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    bytes += size;
    const partition = Number(SPOOL_V1_FILE_RE.exec(file)?.[1] ?? -1);
    const report: RecoveryFileReport = { file, partition, bytes: size, records: 0, partitionMismatches: 0, parseErrors: 0, truncated: false };

    try {
      for await (const entry of readJsonlLines(path)) {
        if (!entry.text.trim()) continue;
        report.records += 1;
        records += 1;
        if (options.maxRecords !== undefined && records > options.maxRecords) {
          stopped = true;
          break;
        }
        if (entry.missingTerminator) {
          report.truncated = true;
          findings.push(`${file}: the last record is not terminated (a write was cut short at byte ${entry.byteOffset.toLocaleString()})`);
          break;
        }
        let row: LegacyRow;
        try {
          row = JSON.parse(entry.text) as LegacyRow;
        } catch {
          report.parseErrors += 1;
          findings.push(`${file}: unparseable record at line ${entry.line} (byte ${entry.byteOffset.toLocaleString()})`);
          continue;
        }
        const sourceId = row.source?.source;
        const sourceRow = row.source?.row;
        if (!sourceId || !Number.isInteger(sourceRow) || (sourceRow as number) < 2) {
          report.parseErrors += 1;
          findings.push(`${file}: record at line ${entry.line} has no usable source provenance`);
          continue;
        }
        let accumulator = accumulators.get(sourceId);
        if (!accumulator) {
          accumulator = newAccumulator();
          accumulators.set(sourceId, accumulator);
        }
        accumulator.records += 1;
        if (!accumulator.rows.add(sourceRow as number)) {
          accumulator.duplicates += 1;
          duplicates += 1;
        }

        const attributes = row.contact?.attributes ?? row.company?.attributes;
        if (attributes && !accumulator.labels) accumulator.labels = Object.keys(attributes);
        if (row.partitionKey) {
          const expected = partitionFor(row.partitionKey, partitionsCount);
          if (expected !== partition) {
            report.partitionMismatches += 1;
            partitionMismatches += 1;
          }
        }

        /* Derive the schema mapping from the canonical values actually stored. */
        if (accumulator.labels && attributes) {
          const values = attributesToValues(accumulator.labels, attributes);
          if (row.company) observeCanonicalValues(accumulator, values, row.company, COMPANY_FIELDS);
          if (row.contact) observeCanonicalValues(accumulator, values, row.contact, CONTACT_FIELDS);
        }
      }
    } catch (error) {
      findings.push(`${file}: could not be read (${error instanceof Error ? error.message : String(error)})`);
      report.parseErrors += 1;
    }
    if (report.truncated) stopped = true;
    files.push(report);
  }

  /*
   * Rejected rows are part of the coverage evidence, not missing rows.
   *
   * A source row with no company name is counted as read and written to
   * `rejected.jsonl`; it never reaches a spool partition. Ignoring that file would
   * make every legitimate rejection look like a lost record and refuse a spool
   * that is in fact complete. Only rows found in NEITHER file are unaccounted.
   */
  const rejectedPath = join(root, "rejected.jsonl");
  if (fileExists(rejectedPath)) {
    for await (const entry of readJsonlLines(rejectedPath)) {
      if (!entry.text.trim() || entry.missingTerminator) continue;
      let rejectedRow: { source?: string; line?: number };
      try {
        rejectedRow = JSON.parse(entry.text) as { source?: string; line?: number };
      } catch {
        continue;
      }
      const sourceId = rejectedRow.source;
      const line = rejectedRow.line;
      if (!sourceId || !Number.isInteger(line) || (line as number) < 2) continue;
      let accumulator = accumulators.get(sourceId);
      if (!accumulator) {
        accumulator = newAccumulator();
        accumulators.set(sourceId, accumulator);
      }
      accumulator.rejected.add(line as number);
    }
  } else if (legacy.length) {
    findings.push("no rejected.jsonl next to the spool: a row missing from a partition can only be treated as unaccounted");
  }

  /** Largest prefix every row of which is in the spool OR in rejected.jsonl. */
  const coverage = (accumulator: SourceAccumulator): { prefix: number; firstGap: number | null } => {
    const max = Math.max(accumulator.rows.max, accumulator.rejected.max);
    for (let row = 2; row <= max; row += 1) {
      if (!accumulator.rows.has(row) && !accumulator.rejected.has(row)) return { prefix: row - 1, firstGap: row };
    }
    return { prefix: max, firstGap: null };
  };

  const sources: RecoverySourceReport[] = [];
  const continuation: Record<string, number> = {};
  const schemaSources: SpoolSourceSchema[] = [];
  let verdict: RecoveryVerdict = "recoverable";

  for (const [id, accumulator] of accumulators) {
    const { prefix: prefixRows, firstGap } = coverage(accumulator);
    let rejectedInPrefix = 0;
    for (let row = 2; row <= prefixRows; row += 1) if (accumulator.rejected.has(row)) rejectedInPrefix += 1;
    accumulator.rejectedInPrefix = rejectedInPrefix;
    sources.push({
      id,
      records: accumulator.records,
      unique: accumulator.rows.count,
      duplicates: accumulator.duplicates,
      rejected: accumulator.rejected.count,
      firstGap,
      prefixRows,
      maxRow: Math.max(accumulator.rows.max, accumulator.rejected.max),
    });
    continuation[id] = prefixRows;
    if (firstGap !== null) {
      verdict = "unusable";
      findings.push(
        `${id}: source row ${firstGap.toLocaleString()} is in neither the spool nor rejected.jsonl — it is genuinely unaccounted, so continuing from any point could silently lose it`,
      );
    }

    const labels = accumulator.labels ?? [];
    const map = buildColumnMap(labels);
    // The derived mapping wins where the stored canonical value proved which
    // column it came from; the automatic mapping only fills fields that were
    // never observed with a value.
    for (const field of [...COMPANY_FIELDS, ...CONTACT_FIELDS]) {
      const state = accumulator.candidates.get(field);
      if (!state) continue;
      const column = chooseColumn(state.candidates);
      if (column !== null) map[field] = column;
    }
    schemaSources.push({
      id,
      delimiter: "\t",
      columns: labels.length,
      map,
      captured: labels.map((label, index) => ({ index, label })),
    });
  }

  const damaged = files.filter((file) => file.parseErrors > 0 || file.truncated);
  if (damaged.length) {
    verdict = "unusable";
    for (const file of damaged) {
      findings.push(`${file.file}: ${file.truncated ? "truncated final record" : `${file.parseErrors} unparseable record(s)`} — its rows cannot be proven complete`);
    }
  }
  if (partitionMismatches > 0) {
    verdict = "unusable";
    findings.push(`${partitionMismatches.toLocaleString()} row(s) sit in a partition file that is not their hash partition — the spool was assembled incorrectly`);
  }

  // Duplicates are a known, provable condition: two copies of the SAME source
  // row are one record, so the import de-duplicates by provenance. They do not
  // make the spool unusable, but they are always reported.
  if (duplicates > 0 && verdict === "recoverable") {
    findings.push(`${duplicates.toLocaleString()} repeated source row(s) found; the import writes each source row once (they are identical by construction)`);
  }
  if (!sources.length) {
    verdict = "unusable";
    findings.push("no row carried a usable source provenance");
  }

  const schema = verdict === "recoverable" ? assertSchema({ format: SPOOL_FORMAT_VERSION, sources: schemaSources }, "derived schema") : null;

  return {
    workDir: root,
    spoolDir,
    format: 1,
    partitions: partitionsCount,
    files,
    totals: { files: files.length, bytes, records, duplicates, partitionMismatches },
    sources,
    schema,
    verdict,
    continuation,
    findings,
  };
}

/* -------------------------------------------------------------------------- */
/* Conversion                                                                 */
/* -------------------------------------------------------------------------- */

export interface RecoverOptions {
  /** The legacy work directory. Read only. */
  sourceWorkDir: string;
  /** A NEW, empty work directory for the v2 spool and ledger. */
  targetWorkDir: string;
  /**
   * Identity of the run that will resume from this spool. It MUST be the identity
   * the ordinary `run` computes for its config (version, sample limit, partitions,
   * source paths/delimiters/override counts) — otherwise resume would refuse the
   * recovered spool as belonging to a different run.
   */
  targetIdentity: SpoolProgress["identity"];
  /** Partition count (must match the source spool). */
  partitions?: number;
  /**
   * Sources the caller has independent evidence were read to the end (the failed
   * run's own log, for example). Only those are marked complete; the others are
   * resumed from their proven prefix.
   */
  completeSources?: string[];
  /** Assessment to convert (re-assessed when omitted). */
  assessment?: RecoveryAssessment;
  /** Called after each partition is converted (progress reporting). */
  onProgress?: (message: string) => void;
}

export interface RecoverResult {
  assessment: RecoveryAssessment;
  targetWorkDir: string;
  progress: SpoolProgress;
  converted: { files: number; rows: number; bytes: number; duplicatesSkipped: number };
}

/** Refuse a target that already holds anything: recovery never overwrites work. */
async function assertEmptyTarget(targetWorkDir: string): Promise<void> {
  if (!existsSync(targetWorkDir)) return;
  const entries = await readdir(targetWorkDir).catch(() => [] as string[]);
  const meaningful = entries.filter((name) => name !== "." && name !== "..");
  if (meaningful.length) {
    throw new Error(
      `Refusing to recover into ${targetWorkDir}: it is not empty (${meaningful.slice(0, 5).join(", ")}${meaningful.length > 5 ? ", …" : ""}).\n` +
        "  Recovery writes a new spool and a new ledger; it never overwrites an existing work directory. Choose a new --target-work-dir.",
    );
  }
}

/**
 * Convert a proven legacy spool into an isolated format-2 work directory.
 *
 * The source is read once more, rows are written exactly once (duplicates are
 * dropped by source provenance), and the ledger records the proven continuation
 * point so the normal `run` resumes Pass 1 there.
 */
export async function recoverLegacySpool(options: RecoverOptions): Promise<RecoverResult> {
  const sourceWorkDir = resolve(options.sourceWorkDir);
  const targetWorkDir = resolve(options.targetWorkDir);
  if (sourceWorkDir === targetWorkDir) {
    throw new Error("Refusing to recover: --target-work-dir must differ from the legacy work directory. Nothing was written.");
  }
  const partitions = options.partitions ?? 256;
  const assessment = options.assessment ?? (await assessLegacySpool(sourceWorkDir, { partitions }));
  if (assessment.verdict !== "recoverable" || !assessment.schema) {
    throw new Error(
      `Refusing to recover: the legacy spool is ${assessment.verdict}, not provably resumable.\n` +
        (assessment.findings.length ? `  ${assessment.findings.join("\n  ")}\n` : "") +
        "  Nothing was written and the original spool is untouched.",
    );
  }
  await assertEmptyTarget(targetWorkDir);
  const spoolDir = join(targetWorkDir, "spool");
  await mkdir(spoolDir, { recursive: true });
  writeSchema(targetWorkDir, assessment.schema);

  const completeSources = new Set(options.completeSources ?? []);
  for (const source of completeSources) {
    if (!assessment.continuation[source]) {
      throw new Error(`Refusing to recover: --complete-source ${source} names a source the spool does not contain. Nothing was written.`);
    }
  }

  if (options.targetIdentity.partitions !== partitions) {
    throw new Error(
      `Refusing to recover: the target identity has ${options.targetIdentity.partitions} partitions but the assessment used ${partitions}.\n` +
        "  Both must be the count the source spool was built with (256 in the production config). Nothing was written.",
    );
  }
  const progress: SpoolProgress = {
    format: SPOOL_FORMAT_VERSION,
    identity: options.targetIdentity,
    schema: assessment.schema,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "pass1",
    sources: Object.fromEntries(
      assessment.schema.sources.map((source) => [
        source.id,
        {
          // `rowsRead` counts EVERY data row consumed, rejected ones included, so
          // the resumed run skips exactly the rows it already accounted for.
          rowsRead: assessment.continuation[source.id] - 1,
          rowsRejected: assessment.sources.find((entry) => entry.id === source.id)?.rejected ?? 0,
          complete: completeSources.has(source.id),
        },
      ]),
    ),
    partitions: {},
    totals: { files: 0, rows: 0, bytes: 0 },
    recoveredFrom: {
      workDir: sourceWorkDir,
      format: 1,
      files: assessment.totals.files,
      bytes: assessment.totals.bytes,
      records: assessment.totals.records,
      duplicates: assessment.totals.duplicates,
      sources: assessment.sources.map((source) => ({ id: source.id, prefixRows: source.prefixRows })),
      recoveredAt: new Date().toISOString(),
    },
  };
  writeProgress(targetWorkDir, progress);

  const writer = new SpoolV2Writer(spoolDir, assessment.schema);
  const seen = new Map<string, RowSet>();
  for (const source of assessment.schema.sources) seen.set(source.id, new RowSet());
  const sourceIndexById = new Map(assessment.schema.sources.map((source, index) => [source.id, index]));
  let rows = 0;
  let duplicatesSkipped = 0;

  for (const file of assessment.files) {
    if (file.truncated || file.parseErrors > 0) continue;
    const path = join(sourceWorkDir, "spool", file.file);
    options.onProgress?.(`recovering ${file.file} (${file.records.toLocaleString()} records)`);
    for await (const entry of readJsonlLines(path)) {
      if (!entry.text.trim() || entry.missingTerminator) continue;
      let row: LegacyRow;
      try {
        row = JSON.parse(entry.text) as LegacyRow;
      } catch {
        continue;
      }
      const sourceId = row.source?.source;
      const sourceRow = row.source?.row;
      if (!sourceId || !Number.isInteger(sourceRow)) continue;
      const index = sourceIndexById.get(sourceId);
      if (index === undefined) continue;
      const seenRows = seen.get(sourceId)!;
      if (!seenRows.add(sourceRow as number)) {
        duplicatesSkipped += 1;
        continue;
      }
      if (file.partition === null) continue;
      const attributes = row.contact?.attributes ?? row.company?.attributes;
      const source = assessment.schema.sources[index];
      const values = normalizeValues(attributesToValues(source.captured.map((column) => column.label), attributes), source.columns);
      writer.add(file.partition ?? 0, encodeSpoolV2Row(index, sourceRow as number, values));
      rows += 1;
    }
    writer.flush();
    const snapshot = writer.progress();
    progress.partitions = Object.fromEntries(snapshot.map((entry) => [String(entry.partition), entry]));
    progress.totals = {
      files: snapshot.length,
      rows: snapshot.reduce((total, entry) => total + entry.rows, 0),
      bytes: snapshot.reduce((total, entry) => total + entry.bytes, 0),
    };
    writeProgress(targetWorkDir, progress);
  }

  await writer.close();
  const final = writer.progress();
  progress.partitions = Object.fromEntries(final.map((entry) => [String(entry.partition), entry]));
  progress.totals = {
    files: final.length,
    rows: final.reduce((total, entry) => total + entry.rows, 0),
    bytes: final.reduce((total, entry) => total + entry.bytes, 0),
  };
  writeProgress(targetWorkDir, progress);

  return { assessment, targetWorkDir, progress, converted: { files: final.length, rows, bytes: progress.totals.bytes, duplicatesSkipped } };
}

/** SHA-256 of a file, used by the report to identify the preserved source. */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Bytes on disk of a spool directory (read-only; for the report). */
export async function spoolBytes(workDir: string): Promise<number> {
  const dir = join(workDir, "spool");
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    total += (await stat(join(dir, name)).catch(() => null))?.size ?? 0;
  }
  return total;
}
