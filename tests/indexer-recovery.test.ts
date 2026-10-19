/**
 * Recovery of a legacy Pass 1 spool that has NO checkpoint and NO manifest.
 *
 * The real spool has 66,333,763 rows in it; these tests build the same condition
 * with small real corpora: a format-1 spool written by the real indexer, then the
 * checkpoint and manifest removed. Recovery must be decided from the rows alone.
 *
 * Asserted properties:
 *   - assessment is READ-ONLY and proves the per-source contiguous prefix;
 *   - a gap (row in neither the spool nor rejected.jsonl) refuses recovery;
 *   - duplicate source rows are provable and written once;
 *   - a truncated tail refuses recovery;
 *   - a row filed under the wrong hash partition refuses recovery;
 *   - an accepted recovery resumes Pass 1 and builds the SAME index bytes as a
 *     clean run of the same sources.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identityFor, runIndex, type IndexerConfig } from "../tools/indexer/src/build";
import { assessLegacySpool, recoverLegacySpool } from "../tools/indexer/src/spool-recover";
import { checkpointPathFor, spoolManifestPathFor } from "../tools/indexer/src/spool";

const HEADERS = ["Company Name", "Website", "Industry", "Country", "City", "Contact Name", "Job Title", "Email", "Phone", "Notes"];

/**
 * Seven data rows: six valid and one with no company name (written to
 * `rejected.jsonl`, never to a partition). That rejected row is the case that
 * makes a naive contiguous-prefix test refuse a complete spool.
 */
function corpus(): string {
  const rows = [
    ["Alpha Analytics", "https://alpha.example", "Analytics", "United States", "Austin", "Ada Lovelace", "CTO", "ada@alpha.example", "", "first"],
    ["Beta Systems", "https://beta.example", "Software", "Germany", "Berlin", "Lukas Weber", "Director", "lukas@beta.example", "", "second"],
    ["Gamma Holdings", "https://gamma.example", "Manufacturing", "India", "Pune", "Asha Rao", "VP", "asha@gamma.example", "", "third"],
    ["", "https://rejected.example", "Consulting", "India", "Pune", "No Employer", "Analyst", "anon@rejected.example", "", "rejected on purpose"],
    ["Delta Logistics", "https://delta.example", "Logistics", "United Kingdom", "London", "Erin Boyle", "Head of Buying", "erin@delta.example", "", "fifth"],
    ["Epsilon Labs", "https://epsilon.example", "Research", "France", "Paris", "Camille Martin", "Researcher", "camille@epsilon.example", "", "sixth"],
    ["Zeta Retail", "https://zeta.example", "Retail", "Japan", "Tokyo", "Kenji Sato", "Manager", "kenji@zeta.example", "", "seventh"],
  ];
  return `${[HEADERS.join(","), ...rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(","))].join("\n")}\n`;
}

interface Setup {
  root: string;
  config: IndexerConfig;
  source: string;
}

function baseConfig(root: string, version = "recovery-v1"): IndexerConfig {
  const source = join(root, "source.csv");
  return {
    datasetVersion: version,
    sources: [{ id: "csv1", path: source, encoding: "utf8", delimiter: "," }],
    workDir: join(root, "legacy-work"),
    outputDir: join(root, "legacy-out"),
    partitions: 8,
    shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
    spoolFormat: "jsonl",
  };
}

/** Build a legacy spool, then strip the checkpoint and manifest like the failed run. */
async function legacySetup(dir: string): Promise<Setup> {
  writeFileSync(join(dir, "source.csv"), corpus(), "utf8");
  const config = baseConfig(dir);
  await runIndex(config, { diskFloorBytes: 16 * 1024 * 1024 });
  rmSync(checkpointPathFor(config.workDir), { force: true });
  rmSync(spoolManifestPathFor(config.workDir), { force: true });
  return { root: dir, config, source: join(dir, "source.csv") };
}

function digestTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, `${statSync(path).size}:${statSync(path).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

const TEST_FLOOR = { diskFloorBytes: 16 * 1024 * 1024 };

describe("legacy spool recovery", () => {
  test("assessment is read-only and proves the prefix including rejected rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-assess-"));
    try {
      const { config } = await legacySetup(dir);
      const before = digestTree(config.workDir);
      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });

      expect(assessment.verdict).toBe("recoverable");
      expect(assessment.totals.records).toBe(6);
      expect(assessment.sources).toHaveLength(1);
      const source = assessment.sources[0];
      expect(source.id).toBe("csv1");
      expect(source.records).toBe(6);
      expect(source.rejected).toBe(1);
      // Lines 2..8 are accounted for: 6 spooled + 1 rejected.
      expect(source.prefixRows).toBe(8);
      expect(source.firstGap).toBeNull();
      expect(assessment.schema!.sources[0].map.companyname).toBe(0);
      expect(JSON.stringify(assessment)).not.toContain("ada@alpha.example");
      expect(digestTree(config.workDir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a proven prefix is converted into an isolated v2 spool and resumed to the same index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-apply-"));
    try {
      const { config } = await legacySetup(dir);
      const targetWorkDir = join(dir, "recovered-work");
      const targetOutputDir = join(dir, "recovered-out");
      const before = digestTree(config.workDir);

      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      const result = await recoverLegacySpool({
        sourceWorkDir: config.workDir,
        targetWorkDir,
        targetIdentity: identityFor(config, undefined),
        partitions: 8,
        assessment,
        completeSources: ["csv1"],
      });
      expect(result.converted.rows).toBe(6);
      expect(result.progress.sources.csv1.rowsRead).toBe(7);
      expect(result.progress.sources.csv1.rowsRejected).toBe(1);
      expect(result.progress.recoveredFrom?.records).toBe(6);

      // The legacy spool is untouched.
      expect(digestTree(config.workDir)).toEqual(before);

      // Resume: Pass 1 already has every source row, so this is a merge only.
      const resumed = await runIndex(
        { ...config, spoolFormat: "v2", workDir: targetWorkDir, outputDir: targetOutputDir },
        TEST_FLOOR,
      );
      expect(resumed.manifest.validationPassed).toBe(true);
      expect(resumed.counters.rowsRead).toBe(7);
      expect(resumed.counters.uniqueCompanies).toBe(6);

      // And a clean v2 build of the same source produces the identical index.
      const cleanConfig = { ...config, spoolFormat: "v2" as const, workDir: join(dir, "clean-work"), outputDir: join(dir, "clean-out") };
      const clean = await runIndex(cleanConfig, TEST_FLOOR);
      expect(clean.manifest.validationPassed).toBe(true);
      const digests = (outputDir: string) =>
        new Map(
          readFileSync(join(outputDir, "objects.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const entry = JSON.parse(line) as { key: string; sha256: string };
              if (entry.key.startsWith("manifests/") || entry.key.endsWith("/directory.json")) return [entry.key, "metadata"] as const;
              return [entry.key, entry.sha256] as const;
            }),
        );
      expect(digests(targetOutputDir)).toEqual(digests(cleanConfig.outputDir));
      expect(resumed.counters.uniqueContacts).toBe(clean.counters.uniqueContacts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a gap in the spool refuses recovery and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-gap-"));
    try {
      const { config } = await legacySetup(dir);
      // Drop a valid row: the source line it came from is then in neither the
      // spool nor rejected.jsonl.
      const spoolDir = join(config.workDir, "spool");
      const file = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort()[0];
      const path = join(spoolDir, file);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeFileSync(path, `${lines.slice(1).join("\n")}\n`, "utf8");

      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      expect(assessment.verdict).toBe("unusable");
      expect(assessment.sources[0].firstGap).not.toBeNull();
      expect(assessment.sources[0].prefixRows).toBeLessThan(8);

      const target = join(dir, "gap-target");
      await expect(
        recoverLegacySpool({
          sourceWorkDir: config.workDir,
          targetWorkDir: target,
          targetIdentity: identityFor(config, undefined),
          partitions: 8,
          assessment,
        }),
      ).rejects.toThrow(/not provably resumable/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a duplicated source row is reported and written exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-dup-"));
    try {
      const { config } = await legacySetup(dir);
      const spoolDir = join(config.workDir, "spool");
      const file = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort()[0];
      const path = join(spoolDir, file);
      const content = readFileSync(path, "utf8");
      const firstLine = content.split("\n")[0];
      writeFileSync(path, `${content}${firstLine}\n`, "utf8");

      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      expect(assessment.verdict).toBe("recoverable");
      expect(assessment.totals.duplicates).toBe(1);

      const result = await recoverLegacySpool({
        sourceWorkDir: config.workDir,
        targetWorkDir: join(dir, "dup-target"),
        targetIdentity: identityFor(config, undefined),
        partitions: 8,
        assessment,
        completeSources: ["csv1"],
      });
      expect(result.converted.rows).toBe(6);
      expect(result.converted.duplicatesSkipped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a truncated final record refuses recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-truncated-"));
    try {
      const { config } = await legacySetup(dir);
      const spoolDir = join(config.workDir, "spool");
      const file = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort()[0];
      const path = join(spoolDir, file);
      writeFileSync(path, `${readFileSync(path, "utf8")}{"keys":["n:half"`, "utf8");

      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      expect(assessment.verdict).toBe("unusable");
      expect(assessment.findings.join("\n")).toMatch(/not terminated|truncated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a row filed under the wrong hash partition refuses recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-partition-"));
    try {
      const { config } = await legacySetup(dir);
      const spoolDir = join(config.workDir, "spool");
      const files = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort();
      const from = join(spoolDir, files[0]);
      const lines = readFileSync(from, "utf8").split("\n").filter(Boolean);
      // Move one record into a different partition file: its partitionKey no
      // longer matches the file it lives in.
      const toIndex = files.findIndex((name) => name !== files[0]);
      const to = join(spoolDir, files[toIndex]);
      writeFileSync(from, `${lines.slice(1).join("\n")}\n`, "utf8");
      writeFileSync(to, `${readFileSync(to, "utf8")}${lines[0]}\n`, "utf8");

      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      expect(assessment.verdict).toBe("unusable");
      expect(assessment.totals.partitionMismatches).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovery refuses a target directory that already holds work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-recover-target-"));
    try {
      const { config } = await legacySetup(dir);
      const assessment = await assessLegacySpool(config.workDir, { partitions: 8 });
      const target = join(dir, "occupied-target");
      cpSync(join(config.workDir), target, { recursive: true });
      await expect(
        recoverLegacySpool({
          sourceWorkDir: config.workDir,
          targetWorkDir: target,
          targetIdentity: identityFor(config, undefined),
          partitions: 8,
          assessment,
        }),
      ).rejects.toThrow(/not empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
