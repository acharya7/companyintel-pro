/**
 * End-to-end index test — the real pipeline, no simulation:
 *
 *   two differently shaped CSVs
 *     → the real streaming indexer (`tools/indexer/src/build.ts`)
 *     → the generated objects on disk, loaded into an R2 binding exactly as
 *       `uploadOutput` sends them (gzipped shards carry `content-encoding: gzip`)
 *     → the real Worker read path (`R2Store` + `R2CandidateSource`) + the shared
 *       search engine.
 *
 * This is the test that would have caught an indexer/reader contract drift, and
 * it is why it exists separately from the unit tests: everything below runs the
 * same code that answers a request in production.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { CsvParser } from "../tools/indexer/src/csv";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { EXPECTED, buildFixtureDataset } from "./helpers/fixture-dataset";
import { searchCompanies } from "../src/shared/search/engine";
import { activeManifestKey, contactPartitionOfRef, indexDirectoryKey, partitionOfRef } from "../src/shared/search/index-format";

const fixture = await buildFixtureDataset();
const bucket = new FakeR2Bucket();
const loaded = bucket.loadObjects(
  fixture.outputDir,
  fixture.result.objects.map((object) => object.key),
);
// Publish the fixture the same way the indexer does, so the read path is real.
bucket.putBytes(
  activeManifestKey(),
  Buffer.from(
    JSON.stringify({
      version: fixture.version,
      previousVersion: null,
      activatedAt: new Date().toISOString(),
      activatedBy: "tests",
    }),
    "utf8",
  ),
);
const store = new R2Store(bucket as unknown as R2Bucket);

async function sourceFor(): Promise<R2CandidateSource> {
  const directory = await store.getDirectory(fixture.version);
  if (!directory) throw new Error("fixture directory is missing");
  return new R2CandidateSource(store, directory);
}

async function search(query: string, overrides: Record<string, unknown> = {}) {
  const source = await sourceFor();
  return searchCompanies(source, query, { pageSize: 25, resultBudget: 400, retrievalBudget: 3000, ...overrides });
}

/* -------------------------------------------------------------------------- */

describe("indexer output", () => {
  test("both sources are indexed and the manifest records their coverage", () => {
    const { counters, manifest } = fixture.result;
    expect(counters.perSource.csv1?.rowsRead).toBeGreaterThan(5);
    expect(counters.perSource.csv2?.rowsRead).toBeGreaterThan(5);
    expect(counters.perSource.csv1?.contacts).toBeGreaterThan(0);
    expect(counters.perSource.csv2?.contacts).toBeGreaterThan(0);
    expect(manifest.validationPassed).toBe(true);
    expect(fixture.result.directory.sources).toEqual(["csv1", "csv2"]);
  });

  test("malformed rows are reported, never silently dropped", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = `${fixture.workDir}/rejected.jsonl`;
    expect(existsSync(path)).toBe(true);
    const rejected = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { reason: string; line: number });
    expect(rejected.some((row) => row.reason === "missing_company_name")).toBe(true);
    expect(fixture.result.counters.rowsRejected).toBe(rejected.length);
  });

  test("shards are gzip-compressed and bounded in size", () => {
    const shardKeys = bucket.keys(`indexes/${fixture.version}/`).filter((key) => key.endsWith(".json.gz"));
    expect(shardKeys.length).toBeGreaterThan(0);
    for (const key of shardKeys.slice(0, 40)) {
      const object = bucket.getObject(key)!;
      expect(object.bytes[0]).toBe(0x1f); // gzip magic
      expect(object.bytes[1]).toBe(0x8b);
      expect(object.bytes.length).toBeLessThan(4 * 1024 * 1024);
      // Every shard must be valid gzip that decompresses to JSON.
      expect(() => JSON.parse(gunzipSync(object.bytes).toString("utf8"))).not.toThrow();
    }
  });

  test("the layout is sharded: no object per company or per contact", () => {
    const keys = fixture.result.objects.map((object) => object.key);
    // Tier 1: the bucket holds only these prefixes.
    expect(keys.every((key) => /^(indexes|companies|contacts|manifests)\//.test(key))).toBe(true);
    // Tier 2: object names are numeric shard/partition names or fixed manifest
    // names — never a company id or a contact id.
    expect(
      keys.every((key) =>
        /\/(?:\d{4,5}\.json(?:\.gz)?|directory\.json|manifest\.json|validation\.json|progress\.json|stats\.json)$/.test(key),
      ),
    ).toBe(true);
    // Tier 3: the object count is bounded by the configured shard skeleton
    // (5 kinds × 8 shards) + partitions + manifests, independent of record count.
    const shardSkeleton = 5 * 8;
    expect(fixture.result.objects.length).toBeLessThanOrEqual(shardSkeleton + 8);
  });
});

describe("search over the generated index (real Worker read path)", () => {
  test("exact search returns the merged company", async () => {
    const response = await search("Microsoft Corporation");
    expect(response.hits[0]?.name).toBe(EXPECTED.microsoft.name);
    expect(response.hits[0]?.matchCategory).toBe("exact");
    expect(response.datasetVersion).toBe(fixture.version);
  });

  test("fuzzy search survives typos and transpositions", async () => {
    for (const query of ["Microsft", "Mircosoft", "Microosoft", "microsoft corp"]) {
      const response = await search(query);
      expect(response.hits[0]?.name).toBe(EXPECTED.microsoft.name);
    }
    const infosys = await search("Infosys Ltd");
    expect(infosys.hits[0]?.name).toBe(EXPECTED.infosys.name);
  });

  test("prefix search resolves short queries without trigrams", async () => {
    const response = await search("micro");
    expect(response.hits.some((hit) => hit.name === EXPECTED.microsoft.name)).toBe(true);
  });

  test("a company present in both files is one record with contacts from both", async () => {
    const response = await search("Microsoft");
    const hit = response.hits[0];
    expect(hit?.name).toBe(EXPECTED.microsoft.name);
    expect(hit?.multiSource).toBe(true);
    // 2 unique contacts in csv1 + 2 unique in csv2 (the duplicate row deduped).
    expect(hit?.contactCount).toBe(EXPECTED.microsoft.contactsFromCsv1 + EXPECTED.microsoft.contactsFromCsv2);

    const source = await sourceFor();
    const ref = await source.refForCompanyId(hit!.id);
    expect(ref).not.toBeNull();
    const contacts = await store.getContactsByCompanyRef(fixture.version, ref!);
    const sources = new Set(contacts.map((contact) => contact.source.source));
    expect(sources).toEqual(new Set(["csv1", "csv2"]));
    expect(contacts.map((contact) => contact.fullName).sort()).toEqual(
      ["Amy Hood", "Judson Althoff", "Kevin Scott", "Satya Nadella"].sort(),
    );
    // Every contact points at the company it was found with.
    expect(contacts.every((contact) => contact.companyId === hit!.id)).toBe(true);
  });

  test("duplicate contact rows are deduplicated, not duplicated", async () => {
    const response = await search("Microsoft");
    const source = await sourceFor();
    const ref = await source.refForCompanyId(response.hits[0]!.id);
    const contacts = await store.getContactsByCompanyRef(fixture.version, ref!);
    expect(contacts.filter((contact) => contact.fullName === "Kevin Scott")).toHaveLength(1);
    expect(fixture.result.counters.duplicateRowsResolved).toBeGreaterThan(0);
  });

  test("similarly named companies stay separate and keep their own contacts", async () => {
    const response = await search("Vertex Analytics");
    const names = response.hits.map((hit) => hit.name);
    expect(names).toContain(EXPECTED.vertexA.name);
    expect(names).toContain(EXPECTED.vertexB.name);

    const source = await sourceFor();
    const a = response.hits.find((hit) => hit.name === EXPECTED.vertexA.name)!;
    const b = response.hits.find((hit) => hit.name === EXPECTED.vertexB.name)!;
    expect(a.id).not.toBe(b.id);

    const contactsA = await store.getContactsByCompanyRef(fixture.version, (await source.refForCompanyId(a.id))!);
    const contactsB = await store.getContactsByCompanyRef(fixture.version, (await source.refForCompanyId(b.id))!);
    const emailsA = contactsA.map((contact) => contact.email);
    const emailsB = contactsB.map((contact) => contact.email);
    expect(emailsA).toContain("priya.menon@vertexanalytics.example");
    expect(emailsA).toContain("arun.das@vertexanalytics.example");
    expect(emailsB).toContain("divya.rao@metrics.vertexanalytics.example");
    // No contact is shared between the two distinct companies.
    expect(emailsA.filter((email) => emailsB.includes(email))).toEqual([]);
  });

  test("identity from a LinkedIn URL alone is strong enough to group (csv2 rows)", async () => {
    const response = await search("Globex");
    expect(response.hits[0]?.name).toBe(EXPECTED.globex.name);
    const response2 = await search("Northwind");
    const hit = response2.hits[0]!;
    expect(hit.name).toBe(EXPECTED.northwind.name);
    expect(hit.contactCount).toBe(EXPECTED.northwind.contacts);
  });

  test("a multiline quoted field stays one record, with its content intact", async () => {
    const infosys = await search("Infosys");
    const source = await sourceFor();
    const ref = await source.refForCompanyId(infosys.hits[0]!.id);
    const contacts = await store.getContactsByCompanyRef(fixture.version, ref!);

    // If the embedded newline had split the record, this company would have an
    // extra malformed contact and a truncated title.
    expect(contacts).toHaveLength(EXPECTED.infosys.contacts);
    const ceo = contacts.find((contact) => contact.fullName === "Salil Parekh");
    expect(ceo?.title).toBe("Chief Executive Officer and Managing Director");
    expect(ceo?.email).toBe("salil.parekh@infosys.com");
    expect(fixture.result.counters.rowsRejected).toBe(1); // only the no-name row

    // The parser itself preserves the raw newline (attribute normalization is a
    // later, deliberate step that collapses whitespace for display).
    const parser = new CsvParser({ delimiter: "," });
    const raw = [...parser.push('a,b\n1,"line one\nline two"\n2,"He said ""hi"", mid"\n')];
    expect(raw[1].fields[1]).toBe("line one\nline two");
    expect(raw[2].fields[1]).toBe('He said "hi", mid');

    const acme = await search("Acme");
    expect(acme.hits[0]?.name).toBe(EXPECTED.acme.name);
    const acmeRef = await source.refForCompanyId(acme.hits[0]!.id);
    const acmeContacts = await store.getContactsByCompanyRef(fixture.version, acmeRef!);
    expect(acmeContacts.some((contact) => contact.fullName === EXPECTED.acme.contact)).toBe(true);
  });

  test("a query with no match returns an explicit empty result", async () => {
    const response = await search("zzzzzzqqqqq");
    expect(response.hits).toEqual([]);
    expect(response.page.total).toBe(0);
  });

  test("retrieval stays inside its budgets", async () => {
    const response = await search("Microsoft Corporation");
    expect(response.retrieval.exact + response.retrieval.prefix + response.retrieval.token + response.retrieval.trigram)
      .toBeLessThanOrEqual(3000 * 4);
    expect(response.retrieval.scored).toBeLessThanOrEqual(400);
  });
});

describe("R2 object reader", () => {
  test("company and contact partitions resolve with bounded reads", async () => {
    bucket.resetCounters();
    const response = await search("Microsoft");
    const ref = await (await sourceFor()).refForCompanyId(response.hits[0]!.id);
    expect(ref).not.toBeNull();
    const company = await store.getCompanyByRef(fixture.version, ref!);
    expect(company?.name).toBe(EXPECTED.microsoft.name);

    const companyKey = `companies/${fixture.version}/${String(partitionOfRef(ref!)).padStart(5, "0")}.json.gz`;
    const contactKey = `contacts/${fixture.version}/${String(contactPartitionOfRef(ref!)).padStart(5, "0")}.json.gz`;
    expect(bucket.keys().includes(companyKey)).toBe(true);
    expect(bucket.keys().includes(contactKey)).toBe(true);
    // A search hydrates at most `maxHydrate` partitions, never the whole index.
    expect(bucket.counters.bytesRead).toBeLessThan(8 * 1024 * 1024);
  });

  test("gzip without content-encoding metadata is still readable (rclone uploads)", async () => {
    // Re-load the same objects without metadata, exactly as `rclone copy` leaves
    // them, and confirm the reader still finds the company.
    const noMetadata = new FakeR2Bucket();
    noMetadata.loadDirectory(fixture.outputDir, { gzipMetadata: false });
    noMetadata.putBytes(
      activeManifestKey(),
      Buffer.from(JSON.stringify({ version: fixture.version, previousVersion: null }), "utf8"),
    );
    const store2 = new R2Store(noMetadata as unknown as R2Bucket);
    const directory = await store2.getDirectory(fixture.version);
    expect(directory).not.toBeNull();

    const source = new R2CandidateSource(store2, directory!);
    const response = await searchCompanies(source, "Microsoft", { resultBudget: 400, retrievalBudget: 3000 });
    expect(response.hits[0]?.name).toBe(EXPECTED.microsoft.name);
  });

  test("the directory is the single source of truth for shard counts", async () => {
    const directory = await store.getDirectory(fixture.version);
    expect(directory?.shards.exact).toBe(8);
    expect(directory?.shards.trigram).toBe(8);
    expect(directory?.counts.companies).toBe(fixture.result.counters.uniqueCompanies);
    expect(directory?.counts.contacts).toBe(fixture.result.counters.uniqueContacts);
    // The directory itself must be small: it is read once per version.
    const dirBytes = bucket.getObject(indexDirectoryKey(fixture.version))!.bytes.length;
    expect(dirBytes).toBeLessThan(64 * 1024);
  });

  test("every generated object is present in the bucket, and only those objects", async () => {
    for (const object of fixture.result.objects) {
      expect(bucket.getObject(object.key)).toBeDefined();
    }
    expect(loaded).toBe(fixture.result.objects.length);
    // `objects.jsonl` is the indexer's local validation log: it exists on disk
    // but is intentionally never uploaded.
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${fixture.outputDir}/objects.jsonl`)).toBe(true);
    expect(bucket.keys().some((key) => key.endsWith("objects.jsonl"))).toBe(false);
  });
});
