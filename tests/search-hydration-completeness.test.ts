/**
 * Hydration completeness regression.
 *
 * The reader caches companies per document ref and remembers which profile
 * partitions it has read, so a search never fetches the same object twice. That
 * bookkeeping is only sound if reading a partition really does load the WHOLE
 * partition. It used to cache just the refs it asked for while still marking the
 * partition read — so a later pass (the weak token/trigram tier, or a deferred fuzzy
 * sweep) skipped the rest of that object's companies and silently dropped them from
 * the results.
 *
 * These two cases cover both object densities the defect depends on:
 *
 *   - a FULL object (`firstRef` 0, several companies) read after asking for one ref;
 *   - a SPARSE object (an aligned ref base far from 0, one company).
 *
 * In both, the contract is the same: the returned map holds every company of every
 * partition that was read, so "hydrated" is a truthful statement.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import type { Company } from "../src/shared/models";
import { companyDetailKey, companyPartitionKey, type IndexDirectory } from "../src/shared/search/index-format";
import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { FakeR2Bucket } from "./helpers/fake-r2";

const VERSION = "hydration-test";

function company(ref: number, name: string): Company {
  return {
    id: `c_hydration_${ref}`,
    name,
    normalizedName: name.toLowerCase(),
    contactCount: ref % 3,
    sources: [{ source: "csv1", row: ref + 2 }],
  } as Company;
}

/**
 * Partition 0 holds three companies (refs 0–2) and partition 4 holds one (ref 1000).
 * Ref 1000 is the aligned base a parallel merge gives its second populated partition,
 * so the second object is genuinely sparse in the way production objects can be.
 */
function bucketWithBothDensities(): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  const write = (partition: number, firstRef: number, companies: Company[]) => {
    bucket.putBytes(companyPartitionKey(VERSION, partition), gzipSync(Buffer.from(JSON.stringify({ firstRef, companies }), "utf8")), {
      contentEncoding: "gzip",
    });
  };
  write(0, 0, [company(0, "Alpha Systems"), company(1, "Beta Systems"), company(2, "Gamma Systems")]);
  write(4, 1000, [company(1000, "Sparse Object Ltd")]);

  bucket.putBytes(
    `indexes/${VERSION}/directory.json`,
    Buffer.from(
      JSON.stringify({
        formatVersion: 4,
        normalizerVersion: 1,
        version: VERSION,
        createdAt: new Date().toISOString(),
        shards: { exact: 1, prefix: 1, token: 1, trigram: 1, ids: 1, companyPartitions: 5, contactPartitions: 1 },
        counts: { companies: 4, contacts: 0, indexedAliases: 0 },
        sources: ["csv1"],
        bytes: { indexes: 0, companies: 0, contacts: 0, total: 0 },
        fields: { company: ["name"], contact: [] },
      } satisfies IndexDirectory),
      "utf8",
    ),
  );
  return bucket;
}

describe("hydration completeness", () => {
  test("reading a partition returns every company in it, not only the requested refs", async () => {
    const store = new R2Store(bucketWithBothDensities() as unknown as R2Bucket);

    // Step 1: ask for ONE ref out of the dense object.
    const first = await store.getCompaniesByRefs(VERSION, [1]);
    expect([...first.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(first.get(0)?.name).toBe("Alpha Systems");

    // Step 2: the sparse object behaves the same way for its single company.
    const sparse = await store.getCompaniesByRefs(VERSION, [1000]);
    expect([...sparse.keys()]).toEqual([1000]);
    expect(sparse.get(1000)?.name).toBe("Sparse Object Ltd");

    // The detail object key uses the same partition, which is what makes the
    // projection/detail halves line up for both densities.
    expect(companyDetailKey(VERSION, 4)).toBe(`details/${VERSION}/companies/00004.json.gz`);
  });

  test("a second pass over the same partition needs no further read, for both densities", async () => {
    const bucket = bucketWithBothDensities();
    const store = new R2Store(bucket as unknown as R2Bucket);
    const directory = (await store.getDirectory(VERSION))!;
    const source = new R2CandidateSource(store, directory);

    await source.docs([0]);
    const afterFirst = bucket.counters.gets;

    // Refs 1 and 2 are in the object that was already read. They must hydrate from the
    // per-search cache — no second GET for partition 0.
    await source.docs([1]);
    await source.docs([2]);
    expect(bucket.counters.gets).toBe(afterFirst);

    // The sparse object still costs exactly one read the first time it is needed.
    await source.docs([1000]);
    expect(bucket.counters.gets).toBe(afterFirst + 1);
    // ...and nothing the second time.
    await source.docs([1000]);
    expect(bucket.counters.gets).toBe(afterFirst + 1);
  });
});
