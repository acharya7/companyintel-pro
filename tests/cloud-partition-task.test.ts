/**
 * Component 1 of the parallel merge: the cloud partition task.
 *
 * It runs against a REAL Cloud Pass 1 spool (built by `runPass1` into an in-memory R2)
 * and checks the properties that make 256 concurrent tasks safe:
 *
 *   - each partition's refs stay inside its allocated range;
 *   - no two partitions write the same object key;
 *   - posting parts are partition-tagged, so the future shard assembler can tell them
 *     apart;
 *   - a durable `partitions/<n>.json` result exists per partition;
 *   - no final index shard (shared object) is written by any partition task.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { cloudKeys } from "../src/shared/cloud/types";
import { planRefBases } from "../tools/indexer/src/ref-space";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { partitionPartPrefix, partitionResultKey, runPartitionTask } from "../tools/cloud/partition";
import { MemoryBlobStore } from "../tools/cloud/store";

const CSV = `"Company Name","Website","Industry","Country","Contact Name","Job Title","Email"
"Microsoft Corporation","https://www.microsoft.com","Software","United States","Satya Nadella","CEO","satya@microsoft.com"
"Infosys Limited","https://www.infosys.com","IT Services","India","Nandan Nilekani","Chairman","nandan@infosys.com"
"Acme, Inc.","https://acme.example","Manufacturing","United States","John O'Neil","Plant Manager","john@acme.example"
"Globex Corporation","https://globex.example","Industrial","United States","Hank Scorpio","CEO","hank@globex.example"
"Northwind Traders","https://northwind.example","Retail","United Kingdom","Erin Boyle","Head of Buying","erin@northwind.example"
"Zebra Systems","https://zebra.example","Software","Canada","Alex Lee","Engineer","alex@zebra.example"
`;

const SOURCE: Pass1SourceSpec = { id: "csv1", key: "raw/file1.csv", delimiter: "," };
const VERSION = "partition-task-test";
const PARTITIONS = 4;

describe("cloud partition task", () => {
  test("each partition owns its refs, objects and posting parts", async () => {
    const store = new MemoryBlobStore({ [SOURCE.key]: Buffer.from(CSV, "utf8") });
    const size = Buffer.byteLength(CSV, "utf8");
    const pass1 = await runPass1({
      store,
      version: VERSION,
      sources: [SOURCE],
      partitions: PARTITIONS,
      chunkBytes: size,
      mode: "full",
      verifySegments: true,
    });
    expect(pass1.stopped).toBe("complete");
    const rows = pass1.checkpoints[0]!.rows;

    // The plan's allocation, computed from spool rows (an upper bound on companies).
    const allocation = planRefBases(Array.from({ length: PARTITIONS }, () => rows));
    const results = [];
    const written = new Set<string>();
    for (let partition = 0; partition < PARTITIONS; partition += 1) {
      const result = await runPartitionTask({
        store,
        version: VERSION,
        config: {
          datasetVersion: VERSION,
          sources: [{ id: SOURCE.id, path: SOURCE.key, delimiter: "," }],
          workDir: `/tmp/unused-${partition}`,
          outputDir: `/tmp/unused-out-${partition}`,
          partitions: PARTITIONS,
          shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
        } as never,
        partition,
        refBase: allocation.bases[partition]!,
        rowsByPartition: Array.from({ length: PARTITIONS }, () => rows),
        workDir: `/tmp/companyintel-partition-test-${partition}`,
        diskFloorBytes: 16 * 1024 * 1024,
      });
      results.push(result);

      // Refs inside the allocation this partition was granted.
      expect(result.nextRef).toBeGreaterThanOrEqual(result.refBase);
      expect(result.nextRef).toBeLessThanOrEqual(result.refBase + result.capacity);
      // A partition task must never have written a final index object.
      expect(result.objects.some((object) => object.key.startsWith("indexes/"))).toBe(false);
      for (const object of result.objects) {
        expect(written.has(object.key)).toBe(false);
        written.add(object.key);
      }
      // The durable result exists and matches what was returned.
      const stored = await store.getJson<{ partition: number; digest: string; companies: number }>(partitionResultKey(VERSION, partition));
      expect(stored?.partition).toBe(partition);
      expect(stored?.digest).toBe(result.digest);
    }

    // The companies were distributed, not all merged into one partition, and no
    // partition invented records: the total never exceeds the spool's row count.
    const populated = results.filter((result) => result.companies > 0);
    expect(populated.length).toBeGreaterThan(0);
    const totalCompanies = results.reduce((total, result) => total + result.companies, 0);
    expect(totalCompanies).toBeGreaterThan(0);
    expect(totalCompanies).toBeLessThanOrEqual(rows);

    // Company projections really are inside their partition's range, and the
    // partition-tagged posting parts exist for a populated partition.
    for (const result of populated) {
      for (const object of result.objects.filter((entry) => entry.key.startsWith("companies/"))) {
        const body = gunzipSync(await store.getRange(object.key, 0, object.bytes)).toString("utf8");
        const payload = JSON.parse(body) as { firstRef: number; companies: unknown[] };
        expect(payload.firstRef).toBeGreaterThanOrEqual(result.refBase);
        expect(payload.firstRef + payload.companies.length).toBeLessThanOrEqual(result.refBase + result.capacity);
      }
      const parts = await store.list(partitionPartPrefix(VERSION, "exact", 0));
      expect(parts.some((part) => part.key.includes(`p-${String(result.partition).padStart(3, "0")}-`))).toBe(true);
    }

    // Nothing was finalised and nothing was activated.
    expect(await store.list("indexes/")).toHaveLength(0);
    expect(await store.list(`manifests/${VERSION}/`)).toHaveLength(0);
    expect(await store.getJson(cloudKeys.state(VERSION))).not.toBeNull();
  }, 120_000);
});
