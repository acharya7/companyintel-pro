/**
 * Cloud Pass 2: the production merge, fed from R2 segments one partition at a time.
 *
 * The properties asserted here are the ones the delivery depends on:
 *
 *   - the index produced from R2 segments is byte-identical to a local merge of the
 *     same segments (so company identity, contact association, every posting and
 *     every projection are unchanged);
 *   - the full spool is never on disk at once (each partition is deleted after it
 *     is merged);
 *   - a paused job resumes cleanly and cannot duplicate records;
 *   - a corrupted segment is refused, not silently merged;
 *   - a completed version is immutable.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleRun } from "../tools/cloud/assemble";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { runCloudPass2 } from "../tools/cloud/pass2";
import { MemoryBlobStore } from "../tools/cloud/store";
import type { IndexerConfig } from "../tools/indexer/src/build";
import { runIndex } from "../tools/indexer/src/build";
import { CLOUD_CONTROL_VERSION, cloudKeys, type CloudControl } from "../src/shared/cloud/types";

const COMPANY_HEADER = ["organization_id", "organization_name", "organization_domain", "description"];
const CONTACT_HEADER = ["person_name", "person_email", "sanitized_organization_name_unanalyzed"];

function companyRow(index: number): string {
  return [`c${index}`, `Company ${index} Ltd`, `company${index}.example`, `"company ${index} description"`].join("\t");
}

function contactRow(index: number): string {
  // Every third contact names an employer that is not in the company file. The
  // indexer creates a company record for it from the contact row itself, so the
  // interesting property here is that the cloud merge reproduces that local
  // behaviour exactly (including the contact-only company).
  const employer = index % 3 === 0 ? `Nowhere Holdings ${index}` : `Company ${index % 37} Ltd`;
  return [`Person ${index}`, `person${index}@example.com`, employer].join("\t");
}

function corpus() {
  const companies = [COMPANY_HEADER.join("\t")];
  for (let index = 0; index < 37; index += 1) companies.push(companyRow(index));
  // Two unrelated companies share a name and carry different strong evidence. A
  // contact naming only that employer cannot be attached to either, so it must be
  // preserved as an unassigned contact by the cloud merge (not dropped).
  companies.push(["c-acme-a", "Acme Ltd", "acme-a.example", "\"first acme\""].join("\t"));
  companies.push(["c-acme-b", "Acme Ltd", "acme-b.example", "\"second acme\""].join("\t"));
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 60; index += 1) contacts.push(contactRow(index));
  contacts.push(["Acme Person A", "", "Acme Ltd"].join("\t"));
  contacts.push(["Acme Person B", "", "Acme Ltd"].join("\t"));
  return {
    company: Buffer.from(`${companies.join("\n")}\n`, "utf8"),
    contact: Buffer.from(`${contacts.join("\n")}\n`, "utf8"),
    companyRows: 39,
    contactRows: 62,
  };
}

const SOURCES: Pass1SourceSpec[] = [
  {
    id: "csv1",
    key: "raw/file1.csv",
    delimiter: "\t",
    columns: { companyid: "organization_id", companyname: "organization_name", companydomain: "organization_domain" },
  },
  {
    id: "csv2",
    key: "raw/file2.csv",
    delimiter: "\t",
    columns: { companyname: "sanitized_organization_name_unanalyzed", personname: "person_name", email: "person_email" },
  },
];

function configFor(version: string, workDir: string): IndexerConfig {
  return {
    datasetVersion: version,
    sources: SOURCES.map((source) => ({
      id: source.id,
      path: `r2://company-intel-data/${source.key}`,
      encoding: "utf-8",
      delimiter: "\t",
      columns: source.columns,
    })),
    // Distinct from the scratch directory the cloud driver uses, as in production:
    // the configured Pass 1 work directory must never be treated as scratch.
    workDir: join(workDir, "cfg"),
    outputDir: join(workDir, "cfg-out"),
    partitions: 8,
    shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
  };
}

/**
 * A store that can be made to fail at a chosen instant, and that counts the
 * Pass 1 segment reads a run performs. Used to prove that a restart after a
 * completed merge rebuilds only the index — it must read zero segments.
 */
class FaultInjectingStore extends MemoryBlobStore {
  failIndexWrites = false;
  segmentReads = 0;

  override async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    if (this.failIndexWrites && key.startsWith("indexes/")) {
      throw new Error("simulated interruption while writing the index shards");
    }
    return super.put(key, body);
  }

  override async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    if (key.includes("/segments/")) this.segmentReads += 1;
    return super.getRange(key, offset, length);
  }
}

async function seedPass1(version = "cloud-p2", partitions = 8, store = new MemoryBlobStore()) {
  const data = corpus();
  if (!store.bytes("raw/file1.csv")) {
    await store.put("raw/file1.csv", data.company);
    await store.put("raw/file2.csv", data.contact);
  }
  const pass1 = await runPass1({
    store,
    version,
    sources: SOURCES,
    partitions,
    chunkBytes: 384,
    sliceBytes: 64,
    verifySegments: true,
  });
  expect(pass1.stopped).toBe("complete");
  return { store, data, pass1 };
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function outputKeys(store: MemoryBlobStore, version: string): string[] {
  return store
    .keys()
    .filter(
      (key) =>
        key.startsWith(`indexes/${version}/`) ||
        key.startsWith(`companies/${version}/`) ||
        key.startsWith(`contacts/${version}/`) ||
        key.startsWith(`companyDetails/${version}/`) ||
        key.startsWith(`contactDetails/${version}/`) ||
        key.startsWith(`unassigned/${version}/`),
    )
    .sort();
}

describe("cloud Pass 2", () => {
  test("a restart after the merge rebuilds only the index, without re-reading a segment", async () => {
    const store = new FaultInjectingStore();
    const { data } = await seedPass1("cloud-p2-resume", 8, store);
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-resume-"));
    try {
      const workDir = join(dir, "work");
      // Interrupt the FIRST run after the merge is finished: every write into
      // `indexes/` fails, which is exactly the finalize phase.
      store.failIndexWrites = true;
      await expect(
        runCloudPass2({ store, version: "cloud-p2-resume", config: configFor("cloud-p2-resume", workDir), workDir }),
      ).rejects.toThrow(/simulated interruption/);

      const checkpoint = await store.getJson<{ mergeComplete: boolean; partitionsDone: number; shardParts: number }>(
        cloudKeys.pass2Checkpoint("cloud-p2-resume"),
      );
      expect(checkpoint?.mergeComplete).toBe(true);
      expect(checkpoint?.partitionsDone).toBe(8);
      expect(checkpoint?.shardParts).toBeGreaterThan(0);
      // The merge survived: no manifest was written, so the version is not activatable.
      expect((await store.head("manifests/cloud-p2-resume/manifest.json")).exists).toBe(false);

      // Restart: the merge must NOT be repeated.
      store.failIndexWrites = false;
      store.segmentReads = 0;
      const resumed = await runCloudPass2({
        store,
        version: "cloud-p2-resume",
        config: configFor("cloud-p2-resume", workDir),
        workDir,
      });

      expect(resumed.stopped).toBe("complete");
      expect(store.segmentReads).toBe(0);
      expect(resumed.rows).toBe(data.companyRows + data.contactRows);
      const manifest = await store.getJson<{ validationPassed: boolean; counters: { uniqueCompanies: number } }>(
        "manifests/cloud-p2-resume/manifest.json",
      );
      expect(manifest?.validationPassed).toBe(true);
      expect(manifest?.counters.uniqueCompanies).toBe(resumed.companies);

      // And the index it produced is byte-identical to a single uninterrupted run.
      const clean = new FaultInjectingStore();
      await seedPass1("cloud-p2-resume-clean", 8, clean);
      const cleanDir = join(dir, "clean");
      const cleanResult = await runCloudPass2({
        store: clean,
        version: "cloud-p2-resume-clean",
        config: configFor("cloud-p2-resume-clean", cleanDir),
        workDir: cleanDir,
      });
      expect(cleanResult.stopped).toBe("complete");
      const resumedKeys = outputKeys(store, "cloud-p2-resume");
      const cleanKeys = outputKeys(clean, "cloud-p2-resume-clean");
      expect(resumedKeys.length).toBe(cleanKeys.length);
      // Two different version ids are written, so the comparison replaces each run's own
      // version with a placeholder and ignores the build timestamp. Every other byte of
      // every object must match, which is what proves the skipped merge changed nothing.
      const canon = (bytes: Buffer, version: string, key: string): string => {
        const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
        const text = body.toString("utf8");
        if (!key.endsWith("/directory.json")) return text.split(version).join("<version>");
        const parsed = JSON.parse(text) as Record<string, unknown>;
        delete parsed.createdAt;
        parsed.version = "<version>";
        return JSON.stringify(parsed);
      };
      const mismatched = resumedKeys.filter((key, index) => {
        const other = cleanKeys[index]!.replace("cloud-p2-resume-clean", "cloud-p2-resume");
        if (other !== key) return true;
        return canon(store.bytes(key)!, "cloud-p2-resume", key) !== canon(clean.bytes(cleanKeys[index]!)!, "cloud-p2-resume-clean", other);
      });
      expect(mismatched).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("the combined job budget pauses Pass 2 at a partition boundary", async () => {
    const { store } = await seedPass1("cloud-p2-budget");
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-budget-"));
    try {
      const workDir = join(dir, "work");
      process.env.CLOUD_JOB_BUDGET_USD = "0.000001";
      try {
        const paused = await runCloudPass2({
          store,
          version: "cloud-p2-budget",
          config: configFor("cloud-p2-budget", workDir),
          workDir,
        });
        expect(paused.stopped).toBe("paused");
        const current = await store.getJson<{
          stage: string;
          note?: string;
          accounting: { budgetUsd?: number; combinedUsd?: number; containerSeconds: number };
        }>(cloudKeys.state("cloud-p2-budget"));
        expect(current?.stage).toBe("paused");
        expect(current?.note).toContain("combined estimate");
        expect(current?.accounting.budgetUsd).toBe(0.000001);
        expect(current?.accounting.combinedUsd).toBeGreaterThanOrEqual(0.000001);
        // Container time counts toward the same budget, from the same stage.
        expect(current?.accounting.containerSeconds).toBeGreaterThanOrEqual(0);
        // The checkpoint is durable, so raising the limit resumes instead of restarting.
        const checkpoint = await store.getJson<{ partitionsDone: number }>(cloudKeys.pass2Checkpoint("cloud-p2-budget"));
        expect(checkpoint?.partitionsDone).toBeGreaterThan(0);
      } finally {
        delete process.env.CLOUD_JOB_BUDGET_USD;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("merges R2 segments into the same index bytes as a local merge, one partition on disk", async () => {
    const { store, data } = await seedPass1();
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-"));
    try {
      const workDir = join(dir, "cloud-work");
      let sawAllPartitions = 0;
      const result = await runCloudPass2({
        store,
        version: "cloud-p2",
        config: configFor("cloud-p2", workDir),
        workDir,
        onProgress: (event) => {
          if (event.stage === "pass2-merge" && /partitions ·/.test(event.message)) sawAllPartitions += 1;
        },
      });

      expect(result.stopped).toBe("complete");
      expect(result.rows).toBe(data.companyRows + data.contactRows);
      expect(result.companies).toBeGreaterThan(0);
      expect(result.contacts).toBeGreaterThan(0);
      // Peak local spool is bounded: only the current partition could remain.
      expect(existsSync(join(workDir, "spool", "part-0000.jsonl.gz"))).toBe(false);
      expect(statSync(join(workDir, "out")).isDirectory()).toBe(true);

      // --- equivalence: merge the same segments locally, then compare bytes ---
      const localWork = join(dir, "local-work");
      const localOut = join(dir, "local-out");
      const localBase = { ...configFor("cloud-p2", localWork), workDir: localWork };
      await assembleRun({ store, version: "cloud-p2", config: localBase, workDir: localWork });
      const localConfig = { ...localBase, outputDir: localOut };
      await runIndex(localConfig, { resume: true, diskFloorBytes: 0 });

      const cloudKeysOut = outputKeys(store, "cloud-p2");
      const compared: string[] = [];
      const mismatched: string[] = [];
      for (const key of cloudKeysOut) {
        const localPath = join(localOut, key);
        // Local output uses the same key shape (folder/version/file).
        expect(existsSync(localPath)).toBe(true);
        if (key.endsWith("/directory.json")) {
          // The only non-deterministic field is the build timestamp; every count and
          // shard layout must still match.
          const cloud = JSON.parse(store.bytes(key)!.toString("utf8")) as Record<string, unknown>;
          const local = JSON.parse(readFileSync(localPath, "utf8")) as Record<string, unknown>;
          delete cloud.createdAt;
          delete local.createdAt;
          if (JSON.stringify(cloud) !== JSON.stringify(local)) mismatched.push(key);
          continue;
        }
        if (hash(store.bytes(key)!) !== hash(readFileSync(localPath))) mismatched.push(key);
        compared.push(key);
      }
      expect(mismatched).toEqual([]);
      expect(compared.length).toBeGreaterThan(10);
      expect(sawAllPartitions).toBe(8);
      // The ambiguous Acme contacts are preserved, not lost by the cloud merge.
      expect(cloudKeysOut.some((key) => key.startsWith("unassigned/"))).toBe(true);
      const manifest = await store.getJson<{ validationPassed: boolean; counters: { uniqueCompanies: number; uniqueContacts: number } }>(
        "manifests/cloud-p2/manifest.json",
      );
      expect(manifest?.validationPassed).toBe(true);
      expect(manifest?.counters.uniqueCompanies).toBe(result.companies);
      expect(manifest?.counters.uniqueContacts).toBe(result.contacts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("pause between partitions, then resume without duplicating records", async () => {
    const { store, data } = await seedPass1("cloud-p2-pause");
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-pause-"));
    try {
      const workDir = join(dir, "work");
      await store.putJson(cloudKeys.control("cloud-p2-pause"), {
        version: CLOUD_CONTROL_VERSION,
        pause: true,
        abort: false,
        approvedFullRun: false,
        updatedAt: new Date().toISOString(),
      } satisfies CloudControl);

      const paused = await runCloudPass2({ store, version: "cloud-p2-pause", config: configFor("cloud-p2-pause", workDir), workDir });
      expect(paused.stopped).toBe("paused");
      const pausedState = await store.getJson<{ stage: string }>(cloudKeys.state("cloud-p2-pause"));
      expect(pausedState?.stage).toBe("paused");
      // No manifest may exist for an unfinished version.
      expect((await store.head("manifests/cloud-p2-pause/manifest.json")).exists).toBe(false);

      await store.putJson(cloudKeys.control("cloud-p2-pause"), {
        version: CLOUD_CONTROL_VERSION,
        pause: false,
        abort: false,
        approvedFullRun: false,
        updatedAt: new Date().toISOString(),
      } satisfies CloudControl);

      const resumed = await runCloudPass2({ store, version: "cloud-p2-pause", config: configFor("cloud-p2-pause", workDir), workDir });
      expect(resumed.stopped).toBe("complete");
      expect(resumed.rows).toBe(data.companyRows + data.contactRows);

      const manifest = await store.getJson<{ counters: { uniqueCompanies: number; uniqueContacts: number } }>("manifests/cloud-p2-pause/manifest.json");
      expect(manifest?.counters.uniqueCompanies).toBe(resumed.companies);
      expect(manifest?.counters.uniqueContacts).toBe(resumed.contacts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("refuses a non-empty directory that is not its own scratch, without deleting it", async () => {
    const { store } = await seedPass1("cloud-p2-guard");
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-guard-"));
    try {
      const workDir = join(dir, "work");
      mkdirSync(join(workDir, "spool"), { recursive: true });
      writeFileSync(join(workDir, "spool", "part-0000.jsonl.gz"), "real spool data");
      await expect(
        runCloudPass2({ store, version: "cloud-p2-guard", config: configFor("cloud-p2-guard", workDir), workDir }),
      ).rejects.toThrow(/not a Cloud Pass 2 scratch directory/);
      expect(readFileSync(join(workDir, "spool", "part-0000.jsonl.gz"), "utf8")).toBe("real spool data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("refuses a corrupted segment instead of merging it", async () => {
    const { store } = await seedPass1("cloud-p2-corrupt");
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-corrupt-"));
    try {
      const segment = store.keys(`${cloudKeys.jobRoot("cloud-p2-corrupt")}/segments/`)[0]!;
      const body = Buffer.from(store.bytes(segment)!);
      body[body.length - 1] = body[body.length - 1]! ^ 0xff;
      await store.put(segment, body);
      await expect(
        runCloudPass2({ store, version: "cloud-p2-corrupt", config: configFor("cloud-p2-corrupt", join(dir, "work")), workDir: join(dir, "work") }),
      ).rejects.toThrow(/checksum mismatch/);
      expect((await store.head("manifests/cloud-p2-corrupt/manifest.json")).exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a completed version is immutable", async () => {
    const { store } = await seedPass1("cloud-p2-immutable");
    const dir = mkdtempSync(join(tmpdir(), "cloud-pass2-immutable-"));
    try {
      const workDir = join(dir, "work");
      await runCloudPass2({ store, version: "cloud-p2-immutable", config: configFor("cloud-p2-immutable", workDir), workDir });
      await expect(
        runCloudPass2({ store, version: "cloud-p2-immutable", config: configFor("cloud-p2-immutable", workDir), workDir }),
      ).rejects.toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

