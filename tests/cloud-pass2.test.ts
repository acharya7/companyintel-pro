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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  // Every third contact names an employer that is not in the company file: it must
  // survive as an unassigned contact rather than be dropped.
  const employer = index % 3 === 0 ? `Nowhere Holdings ${index}` : `Company ${index % 37} Ltd`;
  return [`Person ${index}`, `person${index}@example.com`, employer].join("\t");
}

function corpus() {
  const companies = [COMPANY_HEADER.join("\t")];
  for (let index = 0; index < 37; index += 1) companies.push(companyRow(index));
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 60; index += 1) contacts.push(contactRow(index));
  return {
    company: Buffer.from(`${companies.join("\n")}\n`, "utf8"),
    contact: Buffer.from(`${contacts.join("\n")}\n`, "utf8"),
    companyRows: 37,
    contactRows: 60,
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
    workDir,
    outputDir: join(workDir, "out"),
    partitions: 8,
    shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
  };
}

async function seedPass1(version = "cloud-p2", partitions = 8) {
  const data = corpus();
  const store = new MemoryBlobStore({ "raw/file1.csv": data.company, "raw/file2.csv": data.contact });
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
      await assembleRun({ store, version: "cloud-p2", config: configFor("cloud-p2", localWork), workDir: localWork });
      const localConfig = { ...configFor("cloud-p2", localWork), outputDir: localOut };
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

