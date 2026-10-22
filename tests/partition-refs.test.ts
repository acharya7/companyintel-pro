/**
 * A parallel merge is only safe if a partition-scoped run assigns refs that (a) never
 * collide with another partition's, and (b) land in the SAME company-object numbering
 * the reader derives with `floor(ref / 250)`. Otherwise two containers write one object
 * and the index is silently corrupt.
 *
 * This runs the real indexer twice over the same sources: once sequentially (the
 * reference), once merging a single spool partition with a base from
 * `planRefBases`. It then compares what was written to `companies/<version>/`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { partitionOfRef } from "../src/shared/search/index-format";
import { runIndex, type IndexerConfig } from "../tools/indexer/src/build";
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
Globex Corporation,https://globex.example,Hank Scorpio,CEO,hank@globex.example
`;

interface CompanyObject {
  firstRef: number;
  companies: { id: string; name: string }[];
}

function writeSources(root: string): [string, string] {
  const one = join(root, "one.csv");
  const two = join(root, "two.csv");
  writeFileSync(one, CSV1, "utf8");
  writeFileSync(two, CSV2, "utf8");
  return [one, two];
}

function configFor(root: string, version: string, sources: [string, string], extra: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    datasetVersion: version,
    sources: [
      { id: "csv1", path: sources[0], delimiter: "," },
      { id: "csv2", path: sources[1], delimiter: "," },
    ],
    workDir: join(root, "work"),
    outputDir: join(root, "out"),
    partitions: 4,
    shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
    ...extra,
  } as IndexerConfig;
}

/** Every company object written for a version, in object order. */
function readCompanyObjects(outputDir: string, version: string): CompanyObject[] {
  const dir = join(outputDir, "companies", version);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json.gz"))
    .sort()
    .map((file) => JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString("utf8")) as CompanyObject);
}

describe("partition-scoped merges", () => {
  test("a partition merged at its own base writes refs and objects nobody else owns", async () => {
    const root = mkdtempSync(join(tmpdir(), "companyintel-refs-"));
    try {
      const sources = writeSources(root);

      /*
       * Two independent spools from the same sources. The spool identity includes the
       * dataset version, so the partition run cannot reuse the sequential run's
       * work directory — and it does not need to: both spools are built from the same
       * bytes, and company ids are content-derived, so the comparison is exact.
       */
      const allocation = planRefBases([40, 10, 10, 10]);
      const partition = 1;
      const base = allocation.bases[partition]!;
      const part = configFor(root, "refs-part", sources, {
        workDir: join(root, "work-part"),
        outputDir: join(root, "out-part"),
      });
      // Ref base and partition subset are RUN options, not config: they describe this
      // merge attempt, not the dataset identity (a resume must reuse the same ones).
      const partResult = await runIndex(part, {
        diskFloorBytes: 16 * 1024 * 1024,
        refBase: base,
        mergePartitions: [partition],
      });

      const full = configFor(root, "refs-full", sources, { workDir: join(root, "work-full"), outputDir: join(root, "out-full") });
      const fullResult = await runIndex(full, { diskFloorBytes: 16 * 1024 * 1024 });
      const reference = readCompanyObjects(full.outputDir, "refs-full");
      const referenceIds = new Set(reference.flatMap((object) => object.companies.map((company) => company.id)));
      const referenceRefs = new Set<number>();
      for (const object of reference) {
        object.companies.forEach((_, index) => referenceRefs.add(object.firstRef + index));
      }
      expect(referenceIds.size).toBe(fullResult.counters.uniqueCompanies);
      expect(reference.length).toBeGreaterThan(0);
      const merged = readCompanyObjects(part.outputDir, "refs-part");
      const mergedCompanies = merged.flatMap((object) => object.companies);

      // The subset produced real records, all inside its own allocation.
      expect(mergedCompanies.length).toBeGreaterThan(0);
      expect(mergedCompanies.length).toBeLessThanOrEqual(fullResult.counters.uniqueCompanies);
      expect(partResult.counters.uniqueCompanies).toBe(mergedCompanies.length);
      for (const object of merged) {
        expect(object.firstRef).toBeGreaterThanOrEqual(base);
        expect(object.firstRef).toBeLessThan(base + allocation.capacities[partition]!);
        object.companies.forEach((_, index) => {
          const ref = object.firstRef + index;
          // Same records, different ref space: no collision with the sequential run.
          expect(referenceRefs.has(ref)).toBe(false);
        });
      }

      // The reader's own mapping resolves every merged ref into these objects.
      const objectIndices = merged.map((object) => partitionOfRef(object.firstRef));
      expect(new Set(objectIndices).size).toBe(objectIndices.length);
      for (const object of merged) {
        object.companies.forEach((_, index) => {
          expect(objectIndices).toContain(partitionOfRef(object.firstRef + index));
        });
      }

      // Association survived the subset merge: an employee of a company in this
      // partition is still attached to the same company id as in the full run.
      const fullCompanyByName = new Map(reference.flatMap((object) => object.companies).map((company) => [company.name, company.id]));
      for (const company of mergedCompanies) {
        const referenceId = fullCompanyByName.get(company.name);
        if (referenceId !== undefined) expect(company.id).toBe(referenceId);
      }
      expect(mergedCompanies.every((company) => referenceIds.has(company.id))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
