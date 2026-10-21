/**
 * Cloud Pass 2 for a bounded benchmark.
 *
 * The staging benchmark stopped at 16 MB per source with 16 partitions. Finishing it
 * must merge exactly that prefix — not read another byte and not widen the job into
 * the full corpus — so this test runs Pass 1 with a real byte bound, then Pass 2 with
 * `allowBounded` and the same partition count, and requires:
 *
 *   - the merge to complete and produce a validation report that passed;
 *   - every row of the bounded prefix to reach the index (no segment dropped);
 *   - the job to end `complete`, so the dashboard cannot show it paused;
 *   - a bounded job to be refused when `allowBounded` is absent, so the relaxation
 *     can never become the default for a full run.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { runCloudPass2 } from "../tools/cloud/pass2";
import { MemoryBlobStore } from "../tools/cloud/store";
import { cloudKeys, type CloudJobState } from "../src/shared/cloud/types";
import type { IndexerConfig } from "../tools/indexer/src/build";

const COMPANY_HEADER = ["organization_id", "organization_name", "organization_domain", "description"];
const CONTACT_HEADER = ["person_name", "person_email", "sanitized_organization_name_unanalyzed"];

function companyRow(index: number): string {
  return [`c${index}`, `Company ${index} Ltd`, `company${index}.example`, `"company ${index} description"`].join("\t");
}

function contactRow(index: number): string {
  return [`Person ${index}`, `person${index}@example.com`, `Company ${index % 37} Ltd`].join("\t");
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
    workDir: join(workDir, "cfg"),
    outputDir: join(workDir, "cfg-out"),
    // The production layout has 256 partitions; the benchmark was built with 16, and
    // the partition count is part of the spool identity Pass 2 must match.
    partitions: 16,
    shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
  };
}

async function seedBounded(version: string, maxSourceBytes = 4_000) {
  const companies = [COMPANY_HEADER.join("\t")];
  for (let index = 0; index < 400; index += 1) companies.push(companyRow(index));
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 400; index += 1) contacts.push(contactRow(index));

  const store = new MemoryBlobStore();
  await store.put("raw/file1.csv", Buffer.from(`${companies.join("\n")}\n`, "utf8"));
  await store.put("raw/file2.csv", Buffer.from(`${contacts.join("\n")}\n`, "utf8"));

  const pass1 = await runPass1({
    store,
    version,
    sources: SOURCES,
    partitions: 16,
    chunkBytes: 1_024,
    sliceBytes: 256,
    maxSourceBytes,
    verifySegments: true,
  });
  const state = (await store.getJson<CloudJobState>(cloudKeys.state(version)))!;
  return { store, pass1, state };
}

describe("Cloud Pass 2 on a bounded benchmark", () => {
  test("merges the bounded prefix, validates, and finishes the job", async () => {
    const version = "stg-bounded-pass2";
    const { store, pass1, state } = await seedBounded(version);

    // Pass 1 stopped at the bound, not at EOF, and recorded that it was bounded.
    expect(pass1.stopped).toBe("bounded");
    expect(state.stage).toBe("pass1-complete");
    expect(state.mode).toBe("benchmark");
    expect(state.partitions).toBe(16);
    expect(state.totals.rowsRead).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), "cloud-bounded-pass2-"));
    try {
      const workDir = join(dir, "work");
      const result = await runCloudPass2({
        store,
        version,
        config: configFor(version, workDir),
        workDir,
        allowBounded: true,
      });

      expect(result.stopped).toBe("complete");
      expect(result.partitions).toBe(16);
      // Every row of the prefix is merged: the bounded merge does not drop segments.
      expect(result.rows).toBe(state.totals.rowsRead);

      const manifest = await store.getJson<{
        validationPassed: boolean;
        counters: { uniqueCompanies: number; uniqueContacts: number };
        partitionCount?: number;
      }>(`manifests/${version}/manifest.json`);
      expect(manifest?.validationPassed).toBe(true);
      // The bounded prefix really produced index content, not an empty shell.
      expect(manifest?.counters.uniqueCompanies).toBeGreaterThan(0);
      expect(manifest?.partitionCount ?? 16).toBe(16);

      // The dashboard reads state.json: a finished benchmark must be `complete`, not
      // paused or pass1-complete, and it must not become activatable.
      const final = (await store.getJson<CloudJobState>(cloudKeys.state(version)))!;
      expect(final.stage).toBe("complete");
      expect(final.mode).toBe("benchmark");
      expect(final.pass2?.partitionsDone).toBe(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a job that stopped mid-Pass 1 is accepted only with --allow-bounded", async () => {
    const version = "stg-bounded-legacy";
    const { store, state } = await seedBounded(version);

    // The state the pre-upgrade benchmark left behind: stage `pass1`, incomplete
    // checkpoints, no durable config. That is exactly what `--allow-bounded` accepts.
    const legacy: CloudJobState = { ...state, stage: "pass1", config: undefined };
    await store.putJson(cloudKeys.state(version), legacy);

    const dir = mkdtempSync(join(tmpdir(), "cloud-bounded-legacy-"));
    try {
      const workDir = join(dir, "work");
      await expect(
        runCloudPass2({ store, version, config: configFor(version, workDir), workDir }),
      ).rejects.toThrow(/refus/i);

      const result = await runCloudPass2({
        store,
        version,
        config: configFor(version, workDir),
        workDir,
        allowBounded: true,
      });
      expect(result.stopped).toBe("complete");
      expect((await store.getJson<CloudJobState>(cloudKeys.state(version)))!.stage).toBe("complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
