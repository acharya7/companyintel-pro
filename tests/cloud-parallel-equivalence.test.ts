/**
 * Parallel pipeline equivalence: does 256-way merging + independent shard assembly
 * produce the SAME index as the sequential run?
 *
 * Both legs start from the same two CSVs and the same verified Pass 1 code:
 *
 *   A. `runCloudPass2` — the sequential cloud run (merge every partition, then
 *      finalize in-process).
 *   B. `runPartitionTask` per partition → `runShardTask` per (kind, shard) →
 *      `finalizeParallelBuild` — the swarm path.
 *
 * The only intended difference is document-ref numbering (`planRefBases` gives every
 * partition an aligned slice), so refs are translated to company names before any
 * comparison. Everything a user observes must match: the companies, the contacts and
 * their association evidence, every posting in every shard, the counts and the
 * search results through the real Worker read path.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeParallelBuild } from "../tools/cloud/finalize";
import { runPartitionTask } from "../tools/cloud/partition";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { runCloudPass2 } from "../tools/cloud/pass2";
import { runShardTask, shardTasksFor } from "../tools/cloud/shard";
import { MemoryBlobStore } from "../tools/cloud/store";
import { planRefBases } from "../tools/indexer/src/ref-space";
import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { searchCompanies } from "../src/shared/search/engine";
import type { Company, Contact } from "../src/shared/models";
import { FakeR2Bucket } from "./helpers/fake-r2";

const COMPANY_HEADER = ["organization_id", "organization_name", "organization_domain", "description"];
const CONTACT_HEADER = ["person_name", "person_email", "sanitized_organization_name_unanalyzed"];

function corpus() {
  const companies = [COMPANY_HEADER.join("\t")];
  for (let index = 0; index < 37; index += 1) {
    companies.push([`c${index}`, `Company ${index} Ltd`, `company${index}.example`, `"company ${index} description"`].join("\t"));
  }
  // Two namesakes with different strong identities: their contacts cannot be attached
  // to either, so they must be preserved as unassigned by BOTH legs.
  companies.push(["c-acme-a", "Acme Ltd", "acme-a.example", '"first acme"'].join("\t"));
  companies.push(["c-acme-b", "Acme Ltd", "acme-b.example", '"second acme"'].join("\t"));
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 60; index += 1) {
    const employer = index % 3 === 0 ? `Nowhere Holdings ${index}` : `Company ${index % 37} Ltd`;
    contacts.push([`Person ${index}`, `person${index}@example.com`, employer].join("\t"));
  }
  contacts.push(["Acme Person A", "", "Acme Ltd"].join("\t"));
  contacts.push(["Acme Person B", "", "Acme Ltd"].join("\t"));
  return {
    company: Buffer.from(`${companies.join("\n")}\n`, "utf8"),
    contact: Buffer.from(`${contacts.join("\n")}\n`, "utf8"),
    rows: 39 + 62,
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

const PARTITIONS = 8;
const SHARDS = { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 };

function configFor(version: string, workDir: string) {
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
    partitions: PARTITIONS,
    shards: SHARDS,
  };
}

function gunzip(bytes: Buffer): Buffer {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

/** Every company projection of one version, keyed by ref. */
async function companyRefs(store: MemoryBlobStore, version: string): Promise<Map<number, Company>> {
  const out = new Map<number, Company>();
  for (const key of store.keys(`companies/${version}/`)) {
    const payload = JSON.parse(gunzip(store.bytes(key)!).toString("utf8")) as { firstRef: number; companies: Company[] };
    payload.companies.forEach((company, index) => out.set(payload.firstRef + index, company));
  }
  return out;
}

/**
 * Company id → company JSON.
 *
 * Keyed by id, not name: the indexer deliberately keeps namesakes apart (two records
 * with the same name and different evidence are different companies), and the id is
 * content-derived, so it is stable across the two ref allocations.
 */
async function companiesById(store: MemoryBlobStore, version: string): Promise<Map<string, Company>> {
  const out = new Map<string, Company>();
  for (const company of (await companyRefs(store, version)).values()) {
    if (out.has(company.id)) throw new Error(`duplicate company id ${company.id}`);
    out.set(company.id, company);
  }
  return out;
}

/** Company id → its contacts (association record included), ref numbering removed. */
async function contactsByCompanyId(store: MemoryBlobStore, version: string): Promise<Map<string, Contact[]>> {
  const refs = await companyRefs(store, version);
  const out = new Map<string, Contact[]>();
  for (const key of store.keys(`contacts/${version}/`)) {
    const payload = JSON.parse(gunzip(store.bytes(key)!).toString("utf8")) as { firstRef: number; byCompany: Record<string, Contact[]> };
    for (const [ref, contacts] of Object.entries(payload.byCompany)) {
      const company = refs.get(Number(ref));
      if (!company) throw new Error(`contact object ${key} holds ref ${ref}, which has no company projection`);
      out.set(company.id, contacts);
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.fullName + a.email).localeCompare(b.fullName + b.email));
  return out;
}

/** Company id → its detail record (source columns + facets). */
async function companyDetailsById(store: MemoryBlobStore, version: string): Promise<Map<string, unknown>> {
  const refs = await companyRefs(store, version);
  const out = new Map<string, unknown>();
  for (const key of store.keys(`details/${version}/companies/`)) {
    const payload = JSON.parse(gunzip(store.bytes(key)!).toString("utf8")) as { firstRef: number; records: unknown[] };
    payload.records.forEach((record, index) => {
      const company = refs.get(payload.firstRef + index);
      if (company) out.set(company.id, record);
    });
  }
  return out;
}

/**
 * Terms of one shard, with postings translated from refs to stable identities.
 *
 * A positive ref becomes the company id; a negative ref is the ids shard's encoding
 * of "this contact is unassigned, in spool partition -ref-1" (never a company ref),
 * which is compared as-is because both legs use the same spool partitions.
 */
async function shardTerms(store: MemoryBlobStore, version: string, key: string, refs: Map<number, Company>): Promise<Record<string, string[]>> {
  const body = store.bytes(key);
  if (!body) return {};
  const payload = JSON.parse(gunzip(body).toString("utf8")) as { terms: Record<string, { refs: number[] }> };
  const out: Record<string, string[]> = {};
  for (const [term, postings] of Object.entries(payload.terms)) {
    out[term] = postings.refs
      .map((ref) => {
        if (ref < 0) return `unassigned:${-ref - 1}`;
        const company = refs.get(ref);
        if (!company) throw new Error(`${key} term ${term} points at ref ${ref}, which has no company projection`);
        return company.id;
      })
      .sort();
  }
  return out;
}

/** Load one version into an R2 binding exactly as an upload would, then read it. */
function loadVersion(bucket: FakeR2Bucket, store: MemoryBlobStore, version: string): void {
  for (const key of store.keys()) {
    if (!key.includes(`/${version}/`)) continue;
    const bytes = store.bytes(key)!;
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    bucket.putBytes(key, bytes, { contentEncoding: gzip ? "gzip" : undefined });
  }
}

async function searchVersion(bucket: FakeR2Bucket, version: string, query: string) {
  const store = new R2Store(bucket as unknown as R2Bucket);
  const directory = await store.getDirectory(version);
  if (!directory) throw new Error(`no directory for ${version}`);
  const source = new R2CandidateSource(store, directory);
  return searchCompanies(source, query, { pageSize: 25, resultBudget: 400, retrievalBudget: 3000 });
}

describe("parallel partition merges + shard assembly", () => {
  const store = new MemoryBlobStore();
  const data = corpus();
  const dir = mkdtempSync(join(tmpdir(), "cloud-parallel-"));
  const REFERENCE = "parallel-ref";
  const SPLIT = "parallel-split";
  let reference: Awaited<ReturnType<typeof runCloudPass2>>;
  let final: Awaited<ReturnType<typeof finalizeParallelBuild>>;
  let partitioned: { rows: number; companies: number; contacts: number }[];

  test("both legs complete", async () => {
    try {
      await store.put("raw/file1.csv", data.company);
      await store.put("raw/file2.csv", data.contact);

      for (const version of [REFERENCE, SPLIT]) {
        const pass1 = await runPass1({
          store,
          version,
          sources: SOURCES,
          partitions: PARTITIONS,
          chunkBytes: 384,
          sliceBytes: 64,
          verifySegments: true,
        });
        expect(pass1.stopped).toBe("complete");
      }

      // A. sequential
      reference = await runCloudPass2({
        store,
        version: REFERENCE,
        config: configFor(REFERENCE, join(dir, "ref")),
        workDir: join(dir, "ref"),
      });
      expect(reference.stopped).toBe("complete");

      // B. parallel partition merges
      const checkpoint = (await store.getJson<{ rows: number }>(`cloud/jobs/${SPLIT}/checkpoints/csv1.json`))!;
      const rows = checkpoint.rows;
      // Every partition's row count is an upper bound for its companies, exactly as
      // the coordinator plans it before dispatching tasks.
      const allocation = planRefBases(Array.from({ length: PARTITIONS }, () => rows));
      partitioned = [];
      for (let partition = 0; partition < PARTITIONS; partition += 1) {
        const result = await runPartitionTask({
          store,
          version: SPLIT,
          config: configFor(SPLIT, join(dir, `p${partition}`)) as never,
          partition,
          refBase: allocation.bases[partition]!,
          rowsByPartition: Array.from({ length: PARTITIONS }, () => rows),
          workDir: join(dir, `p${partition}`),
          diskFloorBytes: 0,
        });
        partitioned.push({ rows: result.rows, companies: result.companies, contacts: result.contacts });
      }

      // B. independent shard assembly
      const tasks = shardTasksFor({ shards: SHARDS } as never);
      expect(tasks.length).toBe((8 + 8 + 8 + 8 + 8) + (8 + 8 + 8));
      for (const task of tasks) {
        await runShardTask({ store, version: SPLIT, config: { shards: SHARDS } as never, kind: task.kind, shard: task.shard });
      }

      // B. single-owner finalize
      final = await finalizeParallelBuild({
        store,
        version: SPLIT,
        config: configFor(SPLIT, join(dir, "split")) as never,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("every partition merged its own rows, and they add up", () => {
    expect(partitioned.reduce((total, part) => total + part.rows, 0)).toBe(data.rows);
    expect(partitioned.reduce((total, part) => total + part.companies, 0)).toBe(reference.companies);
    expect(partitioned.reduce((total, part) => total + part.contacts, 0)).toBe(reference.contacts);
  });

  test("finalize publishes the same counts, coverage and validation as the sequential run", () => {
    expect(final.validationPassed).toBe(true);
    expect(final.counts.companies).toBe(reference.companies);
    expect(final.counts.contacts).toBe(reference.contacts);
    expect(final.counts.rows).toBe(data.rows);
    expect(final.shardObjects).toBeGreaterThan(0);
  });

  test("company projections, details and contact associations are identical", async () => {
    const expected = await companiesById(store, REFERENCE);
    const actual = await companiesById(store, SPLIT);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [id, company] of expected) {
      expect(actual.get(id)).toEqual(company);
    }

    const expectedDetails = await companyDetailsById(store, REFERENCE);
    const actualDetails = await companyDetailsById(store, SPLIT);
    expect([...actualDetails.keys()].sort()).toEqual([...expectedDetails.keys()].sort());
    for (const [id, detail] of expectedDetails) {
      expect(actualDetails.get(id)).toEqual(detail);
    }

    const expectedContacts = await contactsByCompanyId(store, REFERENCE);
    const actualContacts = await contactsByCompanyId(store, SPLIT);
    expect([...actualContacts.keys()].sort()).toEqual([...expectedContacts.keys()].sort());
    for (const [id, contacts] of expectedContacts) {
      expect(actualContacts.get(id)).toEqual(contacts);
    }
  });

  test("every index shard holds the same terms and postings (refs translated to names)", async () => {
    const expectedRefs = await companyRefs(store, REFERENCE);
    const actualRefs = await companyRefs(store, SPLIT);
    const expectedShards = store.keys(`indexes/${REFERENCE}/`).filter((key) => !key.endsWith("directory.json"));
    const actualShards = store.keys(`indexes/${SPLIT}/`).filter((key) => !key.endsWith("directory.json"));
    const relative = (key: string, version: string) => key.slice(`indexes/${version}/`.length);
    expect(actualShards.map((key) => relative(key, SPLIT)).sort()).toEqual(expectedShards.map((key) => relative(key, REFERENCE)).sort());

    for (const key of expectedShards) {
      const relativeKey = relative(key, REFERENCE);
      // Contact-name shards post contact ids, which are content-derived and therefore
      // identical across versions even though refs are not.
      if (relativeKey.startsWith("contact")) {
        const expected = JSON.parse(gunzip(store.bytes(key)!).toString("utf8")) as { terms: Record<string, { ids: string[] }> };
        const actual = JSON.parse(gunzip(store.bytes(`indexes/${SPLIT}/${relativeKey}`)!).toString("utf8")) as { terms: Record<string, { ids: string[] }> };
        expect(Object.keys(actual.terms).sort()).toEqual(Object.keys(expected.terms).sort());
        for (const term of Object.keys(expected.terms)) {
          expect([...actual.terms[term]!.ids].sort()).toEqual([...expected.terms[term]!.ids].sort());
        }
        continue;
      }
      expect(await shardTerms(store, SPLIT, `indexes/${SPLIT}/${relativeKey}`, actualRefs)).toEqual(
        await shardTerms(store, REFERENCE, key, expectedRefs),
      );
    }
  });

  test("the real read path returns the same search results for both indexes", async () => {
    const bucket = new FakeR2Bucket();
    loadVersion(bucket, store, REFERENCE);
    loadVersion(bucket, store, SPLIT);
    /*
     * Whole-name queries, i.e. the exact/prefix tier. Those candidates are hydrated
     * through the exact index regardless of ref layout, so the result sets must be
     * identical.
     *
     * Weak (token/trigram only) queries are deliberately not compared: the reader
     * hydrates per company object and marks a WHOLE object read, so on a 73-record
     * fixture (where the sequential build keeps every company in one object while the
     * parallel build spreads them over aligned ref slices) the two layouts expose a
     * different number of weak candidates to the scorer. That is a property of the
     * fixture's object density, not of the index contents — and the shard comparison
     * above proves the contents (terms and postings) are identical.
     */
    const queries = ["Company 7 Ltd", "Company 13 Ltd", "Company 0 Ltd", "Acme Ltd", "Nowhere Holdings 3", "zzzzzzqqqqq"];
    for (const query of queries) {
      const expected = await searchVersion(bucket, REFERENCE, query);
      const actual = await searchVersion(bucket, SPLIT, query);
      // Retrieval reads the index, so its counts must be identical: the same exact,
      // prefix, token and trigram postings answered the query in both builds.
      expect({ exact: actual.retrieval.exact, prefix: actual.retrieval.prefix, token: actual.retrieval.token, trigram: actual.retrieval.trigram }).toEqual({
        exact: expected.retrieval.exact,
        prefix: expected.retrieval.prefix,
        token: expected.retrieval.token,
        trigram: expected.retrieval.trigram,
      });
      expect(actual.retrieval.candidates).toBe(expected.retrieval.candidates);
      // The whole-name hits (what the user's query actually names) are identical, in
      // the same order, with the same ids and contact counts.
      const wholeName = (hits: { matchCategory: string }[]) => hits.filter((hit) => hit.matchCategory === "exact" || hit.matchCategory === "alias");
      expect(wholeName(actual.hits).map((hit) => `${hit.name}:${hit.id}:${hit.contactCount}`)).toEqual(
        wholeName(expected.hits).map((hit) => `${hit.name}:${hit.id}:${hit.contactCount}`),
      );
      // No result the sequential index found is missing from the parallel one.
      const actualIds = new Set(actual.hits.map((hit) => hit.id));
      expect(expected.hits.map((hit) => hit.id).filter((id) => !actualIds.has(id))).toEqual([]);
      if (query === "zzzzzzqqqqq") {
        expect(actual.page.total).toBe(0);
        expect(expected.page.total).toBe(0);
      }
    }
  });

  test("the directory describes the same shard layout, counts and a complete projection/detail split", async () => {
    const expected = JSON.parse(gunzip(store.bytes(`indexes/${REFERENCE}/directory.json`)!).toString("utf8")) as {
      shards: Record<string, unknown>;
      counts: Record<string, number>;
      objects: Record<string, number>;
    };
    const actual = JSON.parse(gunzip(store.bytes(`indexes/${SPLIT}/directory.json`)!).toString("utf8")) as {
      shards: Record<string, unknown>;
      counts: Record<string, number>;
      objects: Record<string, number>;
    };
    expect(actual.shards.exact).toBe(expected.shards.exact);
    expect(actual.shards.prefix).toBe(expected.shards.prefix);
    expect(actual.shards.token).toBe(expected.shards.token);
    expect(actual.shards.trigram).toBe(expected.shards.trigram);
    expect(actual.shards.ids).toBe(expected.shards.ids);
    expect(actual.shards.contactIndex).toEqual(expected.shards.contactIndex);
    expect(actual.counts).toEqual(expected.counts);
    /*
     * Object COUNTS are a consequence of the ref allocation, not of the data: the
     * sequential build fills 250-record objects from ref 0, while every partition
     * task writes its own aligned slice. What must hold either way is that each
     * search projection has a detail object on the same boundary (a projection whose
     * detail half is missing would open a record with its source columns gone).
     */
    expect(actual.objects.companyDetails).toBe(actual.objects.companyProjections);
    expect(actual.objects.contactDetails).toBe(actual.objects.contactProjections);
    expect(actual.objects.companyProjections).toBeGreaterThanOrEqual(expected.objects.companyProjections);
    expect(actual.shards.companyPartitions).toBe(actual.objects.companyProjections);
  });
});
