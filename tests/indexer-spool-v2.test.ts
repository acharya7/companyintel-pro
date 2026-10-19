/**
 * Format-v2 Pass 1: the disk fix and its crash-safety contract.
 *
 * Every case runs the REAL indexer and the REAL merge. The properties asserted
 * here are the ones the failed 66-million-row run violated:
 *
 *   1. a spool row is compact (one copy of the source values, no repeated header
 *      text) instead of 3.27 KB per record;
 *   2. Pass 1 writes a durable ledger as it goes, so an interruption resumes at
 *      the last committed source row instead of re-reading or re-appending;
 *   3. only the UNCOMMITTED tail is truncated on resume — never a committed row;
 *   4. a spool whose ledger and files disagree is refused, not "repaired" into a
 *      shorter dataset;
 *   5. an unclaimed spool is never deleted by a fresh run;
 *   6. a hard spool cap stops the run cleanly, with every committed row intact.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIndex, type IndexerConfig } from "../tools/indexer/src/build";
import { readProgress, SpoolDiskFullError } from "../tools/indexer/src/spool-v2";
import { readSpoolManifest } from "../tools/indexer/src/spool";

const HEADERS = [
  "Company Name",
  "Website",
  "Industry",
  "Country",
  "City",
  "Company Size",
  "Contact Name",
  "Job Title",
  "Email",
  "Phone",
  "Company Description",
  "Organization Notes",
];

/** A realistic wide row: long values and repeated header text are what v1 blew up on. */
function corpus(rows: number): string {
  const lines = [HEADERS.join(",")];
  for (let index = 0; index < rows; index += 1) {
    const description = `Company ${index} builds platforms, tools and services for developers, enterprises and consumers across many markets. `.repeat(6);
    lines.push(
      [
        `"Company ${index} Limited"`,
        `"https://company-${index}.example"`,
        `"Software"`,
        `"United States"`,
        `"Austin"`,
        `"501-1000"`,
        `"Person ${index}"`,
        `"VP Engineering"`,
        `"person.${index}@company-${index}.example"`,
        `"+1 555 010${index % 10}"`,
        `"${description}"`,
        `"note ${index}"`,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function configFor(dir: string, name: string, overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  const source = join(dir, `${name}.csv`);
  if (!existsSync(source)) writeFileSync(source, corpus(120), "utf8");
  return {
    datasetVersion: "spool-v2-test",
    sources: [{ id: "csv1", path: source, encoding: "utf8", delimiter: "," }],
    workDir: join(dir, `${name}-work`),
    outputDir: join(dir, `${name}-out`),
    partitions: 8,
    shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
    ...overrides,
  };
}

/**
 * key → sha256 of every DATA object, so two builds can be compared exactly.
 *
 * Manifests and `directory.json` are excluded: they record timestamps and the
 * build's own stage counters, which legitimately differ between a resumed and a
 * clean run even when every company, contact and posting is byte-identical.
 */
function objectDigests(outputDir: string): Map<string, string> {
  const path = join(outputDir, "objects.jsonl");
  const digests = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { key: string; sha256: string };
    if (entry.key.startsWith("manifests/") || entry.key.endsWith("/directory.json")) continue;
    digests.set(entry.key, entry.sha256);
  }
  return digests;
}

const TEST_FLOOR = { diskFloorBytes: 16 * 1024 * 1024 };

describe("format v2 spool", () => {
  test("stores one compact copy of a row and is far smaller than the legacy encoding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-size-"));
    try {
      const v2 = configFor(dir, "v2", { spoolFormat: "v2" });
      const legacy = configFor(dir, "legacy", { spoolFormat: "jsonl", workDir: join(dir, "legacy-work"), outputDir: join(dir, "legacy-out") });

      const modern = await runIndex(v2, TEST_FLOOR);
      const old = await runIndex(legacy, TEST_FLOOR);
      const legacyManifest = (await readSpoolManifest(legacy.workDir))!;

      const progress = await readProgress(v2.workDir);
      expect(progress).not.toBeNull();
      expect(progress!.status).toBe("pass1-complete");
      expect(progress!.format).toBe(2);
      expect(progress!.totals.rows).toBe(120);
      expect(progress!.schema.sources[0].captured.length).toBe(HEADERS.length);

      const files = readdirSync(join(v2.workDir, "spool")).filter((name) => name.endsWith(".jsonl.gz"));
      expect(files.length).toBeGreaterThan(0);
      const v2Bytes = progress!.totals.bytes;
      const v1Bytes = legacyManifest.partitions.reduce((total, entry) => total + entry.bytes, 0);

      // The same records, stored once: v1 repeated every header on every row and
      // wrote the source row twice on contact rows.
      expect(v2Bytes).toBeLessThan(v1Bytes / 2);
      expect(v2Bytes / 120).toBeLessThan(1_000);
      expect(v1Bytes / 120).toBeGreaterThan(v2Bytes / 120);

      // The merge is the same pipeline, so the generated index is identical.
      expect(objectDigests(v2.outputDir)).toEqual(objectDigests(legacy.outputDir));
      expect(modern.counters.uniqueCompanies).toBe(old.counters.uniqueCompanies);
      expect(modern.counters.uniqueContacts).toBe(old.counters.uniqueContacts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an interrupted Pass 1 resumes at the last committed row and builds the same index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-resume-"));
    try {
      // No cap: the reference build.
      const cleanConfig = configFor(dir, "clean");
      await runIndex(cleanConfig, TEST_FLOOR);

      // A cap that trips after a few committed rows. The checkpoint path runs,
      // the ledger records what is durable, and the run stops cleanly.
      const interruptedConfig = configFor(dir, "interrupted", {
        workDir: join(dir, "interrupted-work"),
        outputDir: join(dir, "interrupted-out"),
        spool: { checkpointRows: 1 },
        spoolMaxBytes: 2_000,
      });
      await expect(runIndex(interruptedConfig, TEST_FLOOR)).rejects.toThrow(/spool has reached/);
      const ledger = await readProgress(interruptedConfig.workDir);
      expect(ledger).not.toBeNull();
      expect(ledger!.status).toBe("pass1");
      expect(ledger!.totals.rows).toBeGreaterThan(0);
      expect(ledger!.totals.rows).toBeLessThan(120);
      const committedRows = ledger!.totals.rows;
      const committedBytes = Object.fromEntries(Object.entries(ledger!.partitions).map(([key, entry]) => [key, entry.bytes]));

      // Re-run without the cap: Pass 1 continues after the committed rows and the
      // merge produces the SAME bytes as an uninterrupted build.
      const resumed = await runIndex({ ...interruptedConfig, spoolMaxBytes: undefined }, TEST_FLOOR);
      expect(resumed.counters.rowsRead).toBe(120);
      expect(resumed.manifest.validationPassed).toBe(true);
      const after = await readProgress(interruptedConfig.workDir);
      expect(after!.totals.rows).toBe(120);
      // Nothing was counted twice: the merge saw exactly the source rows.
      expect(after!.sources.csv1.rowsRead).toBe(120);
      expect(after!.totals.rows).toBe(committedRows + (120 - committedRows));
      expect(Object.values(committedBytes).every((bytes) => bytes > 0)).toBe(true);
      expect(objectDigests(interruptedConfig.outputDir)).toEqual(objectDigests(cleanConfig.outputDir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ENOSPC mid-frame rolls back to the frame boundary and the resume loses nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-enospc-"));
    try {
      const cleanConfig = configFor(dir, "clean-enospc");
      await runIndex(cleanConfig, TEST_FLOOR);

      // Fault at 4 KB of committed spool: the frame being written is half-written
      // and then fails like a full volume. This is the failure that killed the
      // first full run (ENOSPC), exercised without filling a real disk.
      // The fault is per partition writer, and the corpus is spread over 8 of them,
      // so the threshold is small enough that one partition reaches it.
      const fault = { frameBytes: 512, checkpointRows: 1, faultAfterCommittedBytes: 1_200 };
      const config = configFor(dir, "enospc", {
        workDir: join(dir, "enospc-work"),
        outputDir: join(dir, "enospc-out"),
        spool: fault,
      });
      const failure = await runIndex(config, TEST_FLOOR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SpoolDiskFullError);
      expect((failure as Error).message).toMatch(/no space left/);

      const ledger = await readProgress(config.workDir);
      expect(ledger).not.toBeNull();
      expect(ledger!.status).toBe("pass1");
      const committedRows = ledger!.totals.rows;
      expect(committedRows).toBeGreaterThan(0);
      expect(committedRows).toBeLessThan(120);
      // Every partition ends exactly at a committed frame boundary: the partial
      // frame was truncated, not left for a reader to mis-parse.
      for (const entry of Object.values(ledger!.partitions)) {
        expect(statSync(join(config.workDir, "spool", entry.file)).size).toBe(entry.bytes);
      }

      // Re-running the same work directory continues after the committed rows and
      // produces the same objects as an uninterrupted build.
      const resumed = await runIndex(
        { ...config, spool: { frameBytes: 512, checkpointRows: 1 } },
        TEST_FLOOR,
      );
      expect(resumed.counters.rowsRead).toBe(120);
      expect(resumed.manifest.validationPassed).toBe(true);
      const after = await readProgress(config.workDir);
      expect(after!.totals.rows).toBe(120);
      expect(after!.sources.csv1.rowsRead).toBe(120);
      expect(objectDigests(config.outputDir)).toEqual(objectDigests(cleanConfig.outputDir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resume drops only the uncommitted tail (a crash mid-frame cannot duplicate a row)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-tail-"));
    try {
      const cleanConfig = configFor(dir, "clean");
      await runIndex(cleanConfig, TEST_FLOOR);
      const config = configFor(dir, "tail", {
        workDir: join(dir, "tail-work"),
        outputDir: join(dir, "tail-out"),
        spool: { checkpointRows: 1 },
        spoolMaxBytes: 2_000,
      });
      await expect(runIndex(config, TEST_FLOOR)).rejects.toThrow(/spool has reached/);

      const ledger = await readProgress(config.workDir);
      const first = Object.values(ledger!.partitions)[0];
      const partitionPath = join(config.workDir, "spool", first.file);
      // Simulate a process killed in the middle of appending a frame: bytes that
      // the ledger never recorded.
      const before = statSync(partitionPath).size;
      appendFileSync(partitionPath, Buffer.alloc(97, 0x7f));

      const resumed = await runIndex({ ...config, spoolMaxBytes: undefined }, TEST_FLOOR);
      expect(resumed.counters.rowsRead).toBe(120);
      expect(statSync(partitionPath).size).toBeGreaterThanOrEqual(before);
      expect(objectDigests(config.outputDir)).toEqual(objectDigests(cleanConfig.outputDir));
      const after = await readProgress(config.workDir);
      expect(after!.totals.rows).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a ledger that is missing a partition is refused, not rebuilt into a shorter dataset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-missing-"));
    try {
      const config = configFor(dir, "missing", { spool: { checkpointRows: 1 }, spoolMaxBytes: 2_000 });
      await expect(runIndex(config, TEST_FLOOR)).rejects.toThrow(/spool has reached/);
      const ledger = await readProgress(config.workDir);
      const entry = Object.values(ledger!.partitions)[0];
      rmSync(join(config.workDir, "spool", entry.file));

      await expect(runIndex({ ...config, spoolMaxBytes: undefined }, TEST_FLOOR)).rejects.toThrow(/missing from/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a frame whose bytes changed after Pass 1 is refused by the merge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-frame-"));
    try {
      const config = configFor(dir, "frame");
      await runIndex(config, TEST_FLOOR);
      const files = readdirSync(join(config.workDir, "spool")).filter((name) => name.endsWith(".jsonl.gz")).sort();
      const path = join(config.workDir, "spool", files[0]);
      const bytes = Buffer.from(readFileSync(path));
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      writeFileSync(path, bytes);

      await expect(
        runIndex({ ...config, outputDir: join(dir, "frame-out-2") }, TEST_FLOOR),
      ).rejects.toThrow(/SHA-256|checksum/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh run refuses an unclaimed spool and never deletes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-spool-v2-guard-"));
    try {
      const config = configFor(dir, "guard");
      const spoolDir = join(config.workDir, "spool");
      // The exact shape the failed full run left: plain JSONL partitions, no
      // checkpoint, no progress ledger.
      rmSync(config.workDir, { recursive: true, force: true });
      const { mkdirSync } = await import("node:fs");
      mkdirSync(spoolDir, { recursive: true });
      const unclaimed = join(spoolDir, "part-0000.jsonl");
      const content = `${JSON.stringify({ keys: ["n:x"], bucket: "n:x", partitionKey: "n:x", strong: false, normalizedName: "x", company: { name: "X" }, contact: null, source: { source: "csv1", row: 2 } })}\n`;
      writeFileSync(unclaimed, content, "utf8");

      await expect(runIndex(config, TEST_FLOOR)).rejects.toThrow(/already holds .* spool partition/);
      expect(readFileSync(unclaimed, "utf8")).toBe(content);

      // Only an explicit discard removes it.
      await runIndex({ ...config, outputDir: join(dir, "guard-out-2") }, { ...TEST_FLOOR, resume: false, discardSpool: true });
      expect(existsSync(unclaimed)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
