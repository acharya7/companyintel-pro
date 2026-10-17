/**
 * Format v4 — the search-projection / detail split, from the READER's side.
 *
 * The end-to-end test proves the indexer writes both halves. This file proves the
 * reader handles every case that exists in a live bucket during a migration:
 *
 *   - a v4 index: search projections have no `attributes`, and a record view merges
 *     the matching `details/` object back in;
 *   - a v3 index (the previously published development version): attributes are
 *     inline and NO detail object is read, so rollback needs no rebuild;
 *   - a v4 index with a missing detail object: the record still opens with its
 *     projection instead of throwing, because an incomplete upload must not take
 *     the whole dataset offline.
 */

import { describe, expect, test } from "bun:test";

import { R2Store } from "../worker/src/store";
import { FakeR2Bucket } from "./helpers/fake-r2";
import {
  INDEX_FORMAT_VERSION,
  SUPPORTED_INDEX_FORMAT_VERSIONS,
  companyDetailKey,
  companyPartitionKey,
  contactDetailKey,
  contactPartitionKey,
  indexDirectoryKey,
  isDetailSplitFormat,
  partitionOfRef,
} from "../src/shared/search/index-format";

const VERSION = "split-v1";
const REF = 3;
const PARTITION = partitionOfRef(REF);

function directory(formatVersion: number) {
  return {
    formatVersion,
    normalizerVersion: 1,
    version: VERSION,
    createdAt: "2026-10-17T00:00:00.000Z",
    shards: {
      exact: 8,
      prefix: 8,
      token: 8,
      trigram: 8,
      ids: 8,
      companyPartitions: 1,
      contactPartitions: 1,
    },
    counts: { companies: 4, contacts: 1, indexedAliases: 0 },
    sources: ["csv1"],
    bytes: { indexes: 0, companies: 0, contacts: 0, total: 0 },
    fields: { company: ["name"], contact: ["fullName"] },
  };
}

function companyRecord(attributes?: Record<string, string>) {
  return {
    id: `c_${REF}`,
    name: "Split Holdings",
    normalizedName: "split holdings",
    contactCount: 1,
    sources: [{ source: "csv1", row: 2 }],
    ...(attributes ? { attributes } : {}),
  };
}

function contactRecord(attributes?: Record<string, string>) {
  return {
    id: "p_1",
    companyId: `c_${REF}`,
    fullName: "Ada Lovelace",
    source: { source: "csv1", row: 2 },
    ...(attributes ? { attributes } : {}),
  };
}

/** A bucket holding one company + one contact at ref 3. */
function bucketWith(formatVersion: number, options: { lean: boolean; withDetails: boolean }) {
  const bucket = new FakeR2Bucket();
  bucket.putBytes(indexDirectoryKey(VERSION), Buffer.from(JSON.stringify(directory(formatVersion)), "utf8"));
  // `gzipMetadata` is irrelevant here: objects are written as plain JSON.
  bucket.putBytes(
    companyPartitionKey(VERSION, PARTITION),
    Buffer.from(
      JSON.stringify({
        firstRef: 0,
        companies: Array.from({ length: REF + 1 }, (_, ref) =>
          ref === REF ? companyRecord(options.lean ? undefined : { "Org Name": "Split Holdings", Description: "x".repeat(500) }) : null,
        ),
      }),
      "utf8",
    ),
  );
  bucket.putBytes(
    contactPartitionKey(VERSION, PARTITION),
    Buffer.from(
      JSON.stringify({ firstRef: 0, byCompany: { [String(REF)]: [contactRecord(options.lean ? undefined : { Email: "ada@split.example" })] } }),
      "utf8",
    ),
  );
  if (options.withDetails) {
    bucket.putBytes(
      companyDetailKey(VERSION, PARTITION),
      Buffer.from(
        JSON.stringify({
          firstRef: 0,
          records: Array.from({ length: REF + 1 }, (_, ref) =>
            ref === REF ? { attributes: { "Org Name": "Split Holdings", Description: "x".repeat(500) }, facets: { designations: [] } } : null,
          ),
        }),
        "utf8",
      ),
    );
    bucket.putBytes(
      contactDetailKey(VERSION, PARTITION),
      Buffer.from(
        JSON.stringify({ firstRef: 0, byCompany: { [String(REF)]: [{ Email: "ada@split.example" }] } }),
        "utf8",
      ),
    );
  }
  return { bucket, store: new R2Store(bucket as unknown as R2Bucket) };
}

describe("index format v4", () => {
  test("the reader accepts v2, v3 and v4 and knows which ones split details", () => {
    expect(INDEX_FORMAT_VERSION).toBe(4);
    expect(SUPPORTED_INDEX_FORMAT_VERSIONS).toEqual([2, 3, 4]);
    expect(isDetailSplitFormat(3)).toBe(false);
    expect(isDetailSplitFormat(4)).toBe(true);
  });

  test("a v4 record view merges the projection with its detail object", async () => {
    const { store } = bucketWith(4, { lean: true, withDetails: true });
    const company = await store.getCompanyByRef(VERSION, REF);

    expect(company?.name).toBe("Split Holdings");
    expect(company?.attributes?.["Org Name"]).toBe("Split Holdings");
    // Full values, not a truncated preview: the 500-character column survives whole.
    expect(company?.attributes?.Description).toHaveLength(500);
    expect(company?.facets).toBeDefined();

    const contacts = await store.getContactsByCompanyRef(VERSION, REF);
    expect(contacts[0]?.fullName).toBe("Ada Lovelace");
    expect(contacts[0]?.attributes?.Email).toBe("ada@split.example");
  });

  test("a v3 index keeps its inline attributes and reads no detail object", async () => {
    const { bucket, store } = bucketWith(3, { lean: false, withDetails: false });
    bucket.resetCounters();

    const company = await store.getCompanyByRef(VERSION, REF);
    expect(company?.attributes?.["Org Name"]).toBe("Split Holdings");
    expect(company?.attributes?.Description).toHaveLength(500);
    expect(bucket.counters.readKeys.filter((key) => key.startsWith("details/")).length).toBe(0);

    const contacts = await store.getContactsByCompanyRef(VERSION, REF);
    expect(contacts[0]?.attributes?.Email).toBe("ada@split.example");
  });

  test("a missing detail object still opens the record instead of failing", async () => {
    const { store } = bucketWith(4, { lean: true, withDetails: false });
    const company = await store.getCompanyByRef(VERSION, REF);

    expect(company?.name).toBe("Split Holdings");
    expect(company?.attributes).toBeUndefined();
    expect(await store.getContactsByCompanyRef(VERSION, REF)).toHaveLength(1);
  });
});
