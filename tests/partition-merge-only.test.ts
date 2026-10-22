/**
 * A parallel partition task must stop at the merge. If it reached FINALIZE it would
 * write the shared index shard objects, and 256 containers would overwrite one
 * another's shards — the failure mode this whole design exists to avoid.
 *
 * This test merges one partition in merge-only mode and asserts what the task owns:
 * projection/detail objects inside its own ref allocation, shard PARTS (which a shard
 * task will read), and no final index objects at all.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPartitionMerge, type IndexerConfig } from "../tools/indexer/src/build";
import { planRefBases } from "../tools/indexer/src/ref-space";

const CSV1 = `"Company Name","Website","Industry","Country"
"Microsoft Corporation","https://www.microsoft.com","Software","United States"
"Infosys Limited","https://www.infosys.com","IT Services","India"
"Acme, Inc.","https://acme.example","Manufacturing","United States"
"Globex Corporation","https://globex.example","Industrial","United States"
"Northwind Traders","https://northwind.example","Retail","United Kingdom"
"Zebra Systems","https://zebra.example","Software","Canada"
`;

const CSV2 = `organization,domain,full_name,designation,work_email
Microsoft Corp,https://www.microsoft.com,Amy Hood,Chief Financial Officer,amy@microsoft.com
Infosys Limited,https://www.infosys.com,Nandan Nilekani,Chairman,nandan@infosys.com
Acme Inc,https://acme.example,John O'Neil,Plant Manager,john@acme.example
`;

describe("merge-only partition execution", () => {
  test("writes partition artifacts and never the shared index shards", async () => {
    const root = mkdtempSync(join(tmpdir(), "companyintel-merge-only-"));
    try {
      const one = join(root, "one.csv");
      const two = join(root, "two.csv");
      writeFileSync(one, CSV1, "utf8");
      writeFileSync(two, CSV2, "utf8");

      const config: IndexerConfig = {
        datasetVersion: "merge-only",
        sources: [
          { id: "csv1", path: one, delimiter: "," },
          { id: "csv2", path: two, delimiter: "," },
        ],
        workDir: join(root, "work"),
        outputDir: join(root, "out"),
        partitions: 4,
        shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
      } as IndexerConfig;

      const allocation = planRefBases([40, 10, 10, 10]);
      const partition = 1;
      const base = allocation.bases[partition]!;
      const snapshot = await runPartitionMerge(config, {
        diskFloorBytes: 16 * 1024 * 1024,
        refBase: base,
        mergePartitions: [partition],
      });

      // The task produced real records, and their refs stay inside its allocation.
      expect(snapshot.counters.uniqueCompanies).toBeGreaterThan(0);
      expect(snapshot.globalRef).toBeGreaterThanOrEqual(base);
      expect(snapshot.globalRef).toBeLessThan(base + allocation.capacities[partition]!);
      expect(snapshot.companyPartitionIndex).toBeGreaterThanOrEqual(base / 250);

      // It wrote records (companies / contacts / details) but not one index object.
      expect(snapshot.objects.length).toBeGreaterThan(0);
      const indexes = snapshot.objects.filter((object) => object.key.startsWith("indexes/"));
      expect(indexes).toHaveLength(0);
      expect(snapshot.objects.some((object) => object.key.startsWith("companies/"))).toBe(true);

      // Nothing in the output directory is a finalised index generation: finalize,
      // manifests and validation are separate tasks.
      expect(existsSync(join(root, "out", "indexes"))).toBe(false);
      expect(existsSync(join(root, "out", "manifests"))).toBe(false);
      // Shard PARTS are the merge's hand-off to shard assembly, so they must exist
      // (`workDir/shards/<kind>/` — local mode; the cloud driver writes them to R2).
      const shardDir = join(root, "work", "shards");
      expect(existsSync(shardDir)).toBe(true);
      expect(readdirSync(shardDir).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
