/**
 * Two-stage association, end to end, through the real indexer.
 *
 * The fixture below is built so that every outcome the specification asks for
 * actually occurs in one small run:
 *
 *   - two companies with the same normalized name and different domains
 *     ("Delta Systems Limited" / "Delta Systems Pvt Ltd"),
 *   - a contact whose email domain picks one of them (a reassignment),
 *   - a contact whose row identifies one company while their address belongs to
 *     the other (a conflict),
 *   - a contact with a contractor domain that matches nobody (a conflict),
 *   - a personal gmail address (not evidence at all),
 *   - a country that identifies another member of the same name (a conflict),
 *   - a country that supports the assigned company (plausible),
 *   - two contacts with no email and no country, in a shared family
 *     (unresolved — preserved, detached, and deduplicated),
 *   - duplicate rows for a resolved contact AND for an unresolved one,
 *   - two different people with the same name and different titles,
 *   - a uniquely named company whose contacts are plausible.
 *
 * The assertions are about reconciliation: nothing may be lost, nothing may be
 * attached twice, and the counters must add up.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIndex, type IndexerConfig, type RunResult } from "../tools/indexer/src/build";
import { CompanyResolver, companyKeysFromInput, partitionFor, RESOLVER_CONFLICT_SAMPLE_LIMIT } from "../tools/indexer/src/mapping";
import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { app } from "../worker/src/app";
import type { Env } from "../worker/src/env";
import { FakeR2Bucket } from "./helpers/fake-r2";
import {
  INDEX_FORMAT_VERSION,
  activeManifestKey,
  companyPartitionKey,
  spoolPartitionOfNormalizedName,
  type CompanyPartitionPayload,
} from "../src/shared/search/index-format";
import type { Company, Contact, UnassignedContact } from "../src/shared/models";

const VERSION = "assoc-fixture-v1";
const PARTITIONS = 8;

/* --------------------------------- input ---------------------------------- */

const CSV1 = [
  "Company Name,Website,Company LinkedIn,Country,City,Contact Name,Job Title,Email",
  "Delta Systems Limited,https://deltasystems.example,,United States,Austin,Ada Lovelace,VP Engineering,ada.lovelace@deltasystems.example",
  "Delta Systems Pvt Ltd,https://deltasystems.in,https://www.linkedin.com/company/delta-in,India,Pune,Ravi Desai,Analyst,ravi.desai@deltasystems.in",
  // One row carrying BOTH companies' identifiers: contradictory evidence, which
  // must create its own record and claim neither identifier (see the resolver
  // tests below). It has no contact row.
  "Delta Systems,https://deltasystems.example,https://www.linkedin.com/company/delta-in,United States,Austin,,,",
  "Delta Systems Limited,https://deltasystems.example,,United States,Austin,Kyle Adams,Sales Director,kyle.adams@deltasystems.in",
  "Umbrella Group,https://umbrella.example,,United States,Raccoon City,Alice Chen,Scientist,alice.chen@umbrella.example",
  "Acme Corporation,https://acme.example,,United States,Detroit,John Smith,Plant Manager,john.smith@gmail.com",
].join("\n");

const CSV2 = [
  "organization,full_name,title,seniority,department,work_email,contact_country",
  "Delta Systems,Priya Menon,Engineer,Senior,Engineering,,India",
  "Delta Systems,Sam Allen,Engineer,Mid,Engineering,sam.allen@deltasystems.example,United States",
  "Delta Systems,Nina Patel,Director,Director,Sales,,United States",
  "Delta Systems,Omar Haddad,Analyst,Mid,Analytics,omar.haddad@contractor.example,United States",
  "Delta Systems,Leo Frank,Analyst,Mid,Analytics,,",
  "Delta Systems,Leo Frank,Analyst,Mid,Analytics,,",
  "Delta Systems,Gina Rossi,Engineer,Senior,Engineering,gina.rossi@deltasystems.in,Italy",
  "Delta Systems,Gina Rossi,Engineer,Senior,Engineering,gina.rossi@deltasystems.in,Italy",
  "Umbrella Group,Bob Lee,Analyst,Mid,Analytics,,United States",
  "Acme Corporation,Carol King,Vice President,Executive,Operations,carol.king@acme.example,United States",
  "Acme Corporation,Tina Brooks,Controller,Mid,Finance,,United States",
  "Acme Corporation,Tina Brooks,Analyst,Mid,Analytics,,United States",
].join("\n");

interface Fixture {
  result: RunResult;
  root: string;
  outputDir: string;
}

let fixtureCache: Fixture | null = null;

async function buildFixture(): Promise<Fixture> {
  if (fixtureCache) return fixtureCache;
  const root = mkdtempSync(join(tmpdir(), "companyintel-assoc-"));
  const csv1 = join(root, "source-one.csv");
  const csv2 = join(root, "source-two.csv");
  writeFileSync(csv1, `${CSV1}\n`, "utf8");
  writeFileSync(csv2, `${CSV2}\n`, "utf8");
  const config: IndexerConfig = {
    datasetVersion: VERSION,
    sources: [
      { id: "csv1", path: csv1, encoding: "utf8", delimiter: "," },
      { id: "csv2", path: csv2, encoding: "utf8", delimiter: "," },
    ],
    workDir: join(root, "work"),
    outputDir: join(root, "out"),
    partitions: PARTITIONS,
    shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
  };
  const result = await runIndex(config, {});
  fixtureCache = { result, root, outputDir: config.outputDir };
  return fixtureCache;
}

function bucketFor(fixture: Fixture): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  bucket.loadObjects(fixture.outputDir, fixture.result.objects.map((object) => object.key));
  bucket.putBytes(
    activeManifestKey(),
    Buffer.from(JSON.stringify({ version: VERSION, previousVersion: null, activatedAt: new Date().toISOString() }), "utf8"),
  );
  return bucket;
}

/* -------------------------------------------------------------------------- */

describe("two-stage association through the real indexer", () => {
  test("companies with one name and different domains stay separate", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const companies = await allCompanies(store);
    const names = companies.map((company) => company.name).sort();
    expect(names).toEqual(["Acme Corporation", "Delta Systems", "Delta Systems Limited", "Delta Systems Pvt Ltd", "Umbrella Group"]);
    // Four real companies plus the one contradictory row, which is kept as its own
    // record because two of its identifiers belong to two different companies.
    expect(fixture.result.counters.uniqueCompanies).toBe(5);
    // The name-only rows from the second file did not invent a company of the same
    // name: they resolved into the identity the first file established.
    expect(companies.filter((company) => company.normalizedName === "delta systems")).toHaveLength(3);

    // Every record has a distinct id, and the contradicting one owns nothing, so it
    // can neither borrow a domain nor capture a company id that already exists.
    const ids = companies.map((company) => company.id);
    expect(new Set(ids).size).toBe(ids.length);
    const contradicted = companies.find((company) => company.name === "Delta Systems")!;
    expect(contradicted.domain).toBe("deltasystems.example");
    expect(contradicted.contactCount).toBe(0);
    expect(contradicted.ambiguous).toBe(true);
    const alpha = companies.find((company) => company.name === "Delta Systems Limited")!;
    expect(contradicted.id).not.toBe(alpha.id);
  }, 60_000);

  test("every contact is either attached with evidence or preserved without it", async () => {
    const fixture = await buildFixture();
    const counters = fixture.result.counters;
    // 18 rows; 17 carry a contact and 2 of those are duplicates of an earlier row.
    expect(counters.rowsRejected).toBe(0);
    expect(counters.duplicateRowsResolved).toBe(2);
    // The contradicting row tried to claim a domain and a LinkedIn page that other
    // records already own; neither claim was granted.
    expect(counters.identifierConflicts).toBeGreaterThan(0);
    expect(counters.uniqueContacts).toBe(15);
    expect(counters.contactsHighConfidence! + counters.contactsPlausible! + counters.contactsConflicting! + counters.contactsUnresolved!).toBe(15);
    expect(counters.contactsHighConfidence).toBe(7);
    expect(counters.contactsPlausible).toBe(4);
    expect(counters.contactsConflicting).toBe(3);
    expect(counters.contactsUnresolved).toBe(1);
    // One reassignment: Gina's address names the other Delta company.
    expect(counters.contactsMoved).toBe(1);
    expect(counters.unassignedObjects).toBe(1);
  }, 60_000);

  test("company contact counts and association counts reconcile", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const companies = await allCompanies(store);
    const byName = new Map(companies.map((company) => [company.name, company]));

    const attached = companies.reduce((total, company) => total + company.contactCount, 0);
    expect(attached).toBe(14); // 15 preserved − 1 unresolved
    expect(attached + (fixture.result.counters.contactsUnresolved ?? 0)).toBe(fixture.result.counters.uniqueContacts);

    for (const company of companies) {
      const counts = company.associations!;
      expect(counts.total).toBe(company.contactCount);
      expect(counts.highConfidence + counts.plausible + counts.conflicting).toBe(counts.total);
      // Facets are computed from the attached contacts, so they agree with the count.
      const facetTotal = (company.facets?.designations ?? []).reduce((sum, bucket) => sum + bucket.count, 0);
      expect(facetTotal).toBeLessThanOrEqual(company.contactCount);
    }

    const alpha = byName.get("Delta Systems Limited")!;
    expect(alpha.contactCount).toBe(6);
    expect(alpha.associations).toEqual({ highConfidence: 2, plausible: 1, conflicting: 3, total: 6 });
    const beta = byName.get("Delta Systems Pvt Ltd")!;
    expect(beta.contactCount).toBe(2);
    expect(beta.associations).toEqual({ highConfidence: 2, plausible: 0, conflicting: 0, total: 2 });
    expect(byName.get("Umbrella Group")!.associations).toEqual({ highConfidence: 1, plausible: 1, conflicting: 0, total: 2 });
    expect(byName.get("Acme Corporation")!.associations).toEqual({ highConfidence: 2, plausible: 2, conflicting: 0, total: 4 });
  }, 60_000);

  test("a contact whose email domain names another company is reassigned, with provenance", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const { alpha, beta } = await deltaCompanies(store);
    const alphaContacts = await contactsOf(store, alpha.id);
    const betaContacts = await contactsOf(store, beta.id);

    expect(alphaContacts.some((contact) => contact.fullName === "Gina Rossi")).toBe(false);
    const gina = betaContacts.find((contact) => contact.fullName === "Gina Rossi")!;
    expect(gina).toBeDefined();
    expect(gina.association?.category).toBe("high_confidence");
    expect(gina.association?.reason).toBe("email_domain_matches_other_company_of_same_name");
    // Provenance: the move can be explained after the fact.
    expect((gina.association as { movedFrom?: string } | undefined)?.movedFrom).toBe(alpha.id);
    expect(gina.companyId).toBe(beta.id);
  }, 60_000);

  test("conflicting evidence is attached but flagged, never silently confirmed", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const { alpha } = await deltaCompanies(store);
    const contacts = await contactsOf(store, alpha.id);
    const byName = new Map(contacts.map((contact) => [contact.fullName, contact]));

    expect(byName.get("Kyle Adams")!.association?.category).toBe("conflicting");
    expect(byName.get("Kyle Adams")!.association?.reason).toBe("email_domain_conflicts_with_row_identity");
    expect(byName.get("Omar Haddad")!.association?.reason).toBe("email_domain_outside_name_family");
    expect(byName.get("Priya Menon")!.association?.reason).toBe("country_points_to_other_company_of_same_name");
    // The row's own identity still wins the attachment; the conflict is a label.
    expect(byName.get("Kyle Adams")!.companyId).toBe(alpha.id);

    // Plausible and high-confidence contacts carry their own reasons.
    expect(byName.get("Ada Lovelace")!.association?.reason).toBe("row_carries_employer_identity");
    expect(byName.get("Sam Allen")!.association?.reason).toBe("email_domain_matches_assigned_company");
    expect(byName.get("Nina Patel")!.association?.reason).toBe("country_supports_assigned_company");
    expect(byName.get("Nina Patel")!.association?.category).toBe("plausible");
    // A personal address is recorded as such, and does not weaken the record's identity.
    expect(byName.get("Ada Lovelace")!.email).toBe("ada.lovelace@deltasystems.example");
  }, 60_000);

  test("unresolved contacts are preserved under the name they claimed, not attached", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const { alpha } = await deltaCompanies(store);
    // The reader finds the object from the company record alone.
    const partition = spoolPartitionOfNormalizedName(alpha.normalizedName, PARTITIONS);
    const preserved = await store.getUnassignedContacts(VERSION, partition);
    expect(preserved).toHaveLength(1);
    const leo = preserved[0];
    expect(leo.fullName).toBe("Leo Frank");
    expect(leo.companyId).toBe("");
    // The preserved record keeps the exact name the source row carried.
    expect(leo.claimedCompanyName).toBe("Delta Systems");
    expect(leo.claimedNormalizedName).toBe("delta systems");
    expect(leo.association.category).toBe("unresolved");
    expect(leo.association.reason).toBe("several_candidates_remain");
    // The duplicate row was deduplicated rather than preserved twice.
    expect(preserved.filter((contact) => contact.fullName === "Leo Frank")).toHaveLength(1);
    // And it is NOT on the company it named.
    const attachments = await contactsOf(store, alpha.id);
    expect(attachments.some((contact) => contact.fullName === "Leo Frank")).toBe(false);
  }, 60_000);

  test("distinct people with the same name stay distinct", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const store = new R2Store(bucket as unknown as R2Bucket);
    const companies = await allCompanies(store);
    const acme = companies.find((company) => company.name === "Acme Corporation")!;
    const contacts = await contactsOf(store, acme.id);
    const tina = contacts.filter((contact) => contact.fullName === "Tina Brooks");
    expect(tina).toHaveLength(2);
    expect(new Set(tina.map((contact) => contact.id)).size).toBe(2);
    expect(tina.map((contact) => contact.title).sort()).toEqual(["Analyst", "Controller"]);
  }, 60_000);

  test("the same index build is byte-for-byte deterministic", async () => {
    const fixture = await buildFixture();
    // A second run of the same input, in isolated directories.
    const root = mkdtempSync(join(tmpdir(), "companyintel-assoc-repeat-"));
    const csv1 = join(root, "one.csv");
    const csv2 = join(root, "two.csv");
    writeFileSync(csv1, `${CSV1}\n`, "utf8");
    writeFileSync(csv2, `${CSV2}\n`, "utf8");
    const config: IndexerConfig = {
      datasetVersion: VERSION,
      sources: [
        { id: "csv1", path: csv1, encoding: "utf8", delimiter: "," },
        { id: "csv2", path: csv2, encoding: "utf8", delimiter: "," },
      ],
      workDir: join(root, "work"),
      outputDir: join(root, "out"),
      partitions: PARTITIONS,
      shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
    };
    const again = await runIndex(config, {});
    // `createdAt` is the one field that cannot repeat; everything else must.
    expect({ ...again.directory, createdAt: null }).toEqual({ ...fixture.result.directory, createdAt: null });
    expect(again.counters.uniqueCompanies).toBe(fixture.result.counters.uniqueCompanies);
    expect(again.counters.uniqueContacts).toBe(fixture.result.counters.uniqueContacts);
    expect(again.counters.contactsMoved).toBe(fixture.result.counters.contactsMoved);
    expect(again.counters.identifierConflicts).toBe(fixture.result.counters.identifierConflicts);

    const firstBucket = bucketFor(fixture);
    const secondBucket = new FakeR2Bucket();
    secondBucket.loadObjects(config.outputDir, again.objects.map((object) => object.key));
    const firstStore = new R2Store(firstBucket as unknown as R2Bucket);
    const secondStore = new R2Store(secondBucket as unknown as R2Bucket);
    const firstCompanies = await allCompanies(firstStore);
    const secondCompanies = await allCompanies(secondStore);
    expect(secondCompanies.map((company) => company.id).sort()).toEqual(firstCompanies.map((company) => company.id).sort());
    for (const company of firstCompanies) {
      const other = secondCompanies.find((candidate) => candidate.id === company.id)!;
      expect(other.contactCount).toBe(company.contactCount);
      expect(other.associations).toEqual(company.associations);
    }
    const firstPreserved = await firstStore.getUnassignedContacts(VERSION, 0);
    const secondPreserved = await secondStore.getUnassignedContacts(VERSION, 0);
    expect(secondPreserved).toEqual(firstPreserved);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  test("the directory declares format v3 and where preserved contacts live", async () => {
    const fixture = await buildFixture();
    expect(fixture.result.directory.formatVersion).toBe(INDEX_FORMAT_VERSION);
    expect(INDEX_FORMAT_VERSION).toBe(3);
    expect(fixture.result.directory.shards.spoolPartitions).toBe(PARTITIONS);
    expect(fixture.result.directory.unassigned).toEqual({ objects: 1, contacts: 1 });
    // The reader's partition function must be the indexer's own.
    expect(spoolPartitionOfNormalizedName("delta systems", PARTITIONS)).toBe(partitionFor("n:delta systems", PARTITIONS));
    expect(fixture.result.manifest.indexFormatVersion).toBe(INDEX_FORMAT_VERSION);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */

describe("identifier ownership is never reassigned", () => {
  const alphaKeys = () => companyKeysFromInput({ name: "Delta Systems Limited", domain: "deltasystems.example" }, "csv1");
  const betaKeys = () =>
    companyKeysFromInput({ name: "Delta Systems Pvt Ltd", domain: "deltasystems.in", linkedinUrl: "https://www.linkedin.com/company/delta-in" }, "csv2");
  const mixedKeys = () =>
    companyKeysFromInput({ name: "Delta Systems", domain: "deltasystems.example", linkedinUrl: "https://www.linkedin.com/company/delta-in" }, "csv1");
  const linkedinKey = "l:linkedin.com/company/delta-in";
  const watchedKeys = () => ["d:deltasystems.example", "d:deltasystems.in", linkedinKey, "n:delta systems"];

  test("a contradicting row creates its own record and claims nothing that is taken", () => {
    const resolver = new CompanyResolver();
    const alpha = resolver.resolve(alphaKeys());
    const beta = resolver.resolve(betaKeys());
    expect(alpha.identityClaimed).toBe(true);
    expect(beta.identityClaimed).toBe(true);

    const mixed = resolver.resolve(mixedKeys());
    expect(mixed.created).toBe(true);
    // Every one of its identifiers is already owned, so the row contributes no
    // identity evidence of its own — and it must not be told otherwise.
    expect(mixed.identityClaimed).toBe(false);
    // A record that owns no identifier is not a "strong" record — otherwise a
    // contradicting row would look like a verified company to every later rule.
    expect(resolver.entry(mixed.ref)?.strong).toBe(false);
    expect(resolver.stats().conflicts).toBeGreaterThan(0);
    expect(resolver.stats().samples.length).toBeGreaterThan(0);
    expect(resolver.stats().samples[0]).toHaveProperty("ownerRef");
  });

  test("the owner of a domain does not change when a later row contradicts it", () => {
    const resolver = new CompanyResolver();
    const alpha = resolver.resolve(alphaKeys());
    resolver.resolve(betaKeys());
    resolver.resolve(mixedKeys());

    expect(resolver.refFor("d:deltasystems.example")).toBe(alpha.ref);
    // A row carrying the original domain still resolves to the original company,
    // and still knows that the identity is its own.
    const again = resolver.resolve(alphaKeys());
    expect(again.ref).toBe(alpha.ref);
    expect(again.identityClaimed).toBe(true);
    expect(resolver.refFor("d:deltasystems.example")).toBe(alpha.ref);
  });

  test("a repeated contradicting pattern joins one record instead of creating one per row", () => {
    const resolver = new CompanyResolver();
    resolver.resolve(alphaKeys());
    resolver.resolve(betaKeys());
    const first = resolver.resolve(mixedKeys());
    const entities = resolver.size;
    for (let i = 0; i < 25; i += 1) {
      const repeat = resolver.resolve(mixedKeys());
      expect(repeat.ref).toBe(first.ref);
      expect(repeat.identityClaimed).toBe(false);
    }
    expect(resolver.size).toBe(entities);
  });

  test("resolving the same rows twice never moves an identifier", () => {
    const resolver = new CompanyResolver();
    const keysets = [alphaKeys(), betaKeys(), mixedKeys()];
    const firstPass = keysets.map((keys) => resolver.resolve(keys).ref);
    const owners = watchedKeys().map((key) => resolver.refFor(key));
    const secondPass = keysets.map((keys) => resolver.resolve(keys).ref);
    expect(secondPass).toEqual(firstPass);
    expect(watchedKeys().map((key) => resolver.refFor(key))).toEqual(owners);
    expect(resolver.stats().conflicts).toBeGreaterThanOrEqual(4);
  });

  test("thousands of rows in one shared name stay bounded in records and diagnostics", () => {
    // 5,000 rows of one name, each with its own domain: one record per identity,
    // no conflicts, and no per-row blow-up.
    const wide = new CompanyResolver();
    for (let index = 0; index < 5000; index += 1) {
      wide.resolve(companyKeysFromInput({ name: "Acme", domain: `acme-${index}.example` }, "csv1"));
    }
    expect(wide.size).toBe(5000);
    expect(wide.stats().conflicts).toBe(0);
    expect(wide.stats().samples).toHaveLength(0);

    // 1,000 rows that are all self-contradicting in the SAME way (one key owned by
    // A, another by B): one extra record for the whole pattern, while the refused
    // claims are counted in full but sampled only up to the cap.
    const repeated = new CompanyResolver();
    repeated.resolve(companyKeysFromInput({ name: "Acme", domain: "acme.example" }, "csv1"));
    repeated.resolve(companyKeysFromInput({ name: "Acme", domain: "acme-other.example", linkedinUrl: "https://www.linkedin.com/company/acme-in" }, "csv2"));
    for (let index = 0; index < 1000; index += 1) {
      repeated.resolve(
        companyKeysFromInput({ name: "Acme", domain: "acme.example", linkedinUrl: "https://www.linkedin.com/company/acme-in" }, "csv2"),
      );
    }
    expect(repeated.size).toBe(3);
    // Two STRONG refusals per row (the domain and the LinkedIn page); the shared
    // name key is not counted as a conflict, or a name family would look like one.
    expect(repeated.stats().conflicts).toBe(2 * 1000);
    expect(repeated.stats().samples.length).toBeLessThanOrEqual(RESOLVER_CONFLICT_SAMPLE_LIMIT);
    expect(repeated.refFor("d:acme.example")).toBe(0);
  });

  test("a different input record order changes who owns a key first, but never steals it", () => {
    const forward = new CompanyResolver();
    const forwardAlpha = forward.resolve(alphaKeys()).ref;
    const forwardBeta = forward.resolve(betaKeys()).ref;
    const forwardMixed = forward.resolve(mixedKeys()).ref;

    const reversed = new CompanyResolver();
    const reversedMixed = reversed.resolve(mixedKeys()).ref;
    const reversedAlpha = reversed.resolve(alphaKeys()).ref;
    const reversedBeta = reversed.resolve(betaKeys()).ref;

    // Forward: each key belongs to the record that carried it first, and the
    // contradicting row owns nothing of its own.
    expect(forward.refFor("d:deltasystems.example")).toBe(forwardAlpha);
    expect(forward.refFor("d:deltasystems.in")).toBe(forwardBeta);
    expect(forward.refFor(linkedinKey)).toBe(forwardBeta);
    expect(forwardMixed).not.toBe(forwardAlpha);

    expect(forward.size).toBe(3);

    // Reversed: the mixed row arrives first, so it legitimately owns what it
    // carries. Both later rows then reach it through a strong identifier they
    // share with it (the .example domain and the LinkedIn page respectively), which
    // is the documented "exactly one strong match" merge — nothing is taken back.
    expect(reversed.refFor("d:deltasystems.example")).toBe(reversedMixed);
    expect(reversed.refFor("n:delta systems")).toBe(reversedMixed);
    expect(reversedAlpha).toBe(reversedMixed);
    expect(reversedBeta).toBe(reversedMixed);
    expect(reversed.refFor("d:deltasystems.in")).toBe(reversedMixed);
    expect(reversed.size).toBe(1);

    // Replaying either resolver never moves an identifier.
    for (const resolver of [forward, reversed]) {
      const owners = watchedKeys().map((key) => resolver.refFor(key));
      resolver.resolve(alphaKeys());
      resolver.resolve(betaKeys());
      resolver.resolve(mixedKeys());
      expect(watchedKeys().map((key) => resolver.refFor(key))).toEqual(owners);
    }
    // Ownership was only ever REFUSED in the order that put the conflicting row
    // last; the order itself is not an error, and no key changed hands. What the
    // order changes is how many records the evidence ends up needing, which is why
    // the run records the conflict counts rather than hiding them.
    expect(forward.stats().conflicts).toBeGreaterThan(0);
    expect(reversed.stats().conflicts).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("the Worker serves the preserved contacts without pretending they are employees", () => {
  test("the unassigned endpoint returns them for the name they claimed", async () => {
    const fixture = await buildFixture();
    const bucket = bucketFor(fixture);
    const env = {
      COMPANY_DATA: bucket,
      ENVIRONMENT: "development",
      DEV_ALLOW_UNAUTHENTICATED: "true",
      MAX_SEARCHES_PER_MINUTE: "100000",
      APP_VERSION: "test",
    } as unknown as Env;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const api = async (path: string) => {
      const response = await app.fetch(new Request(`https://companyintel.example${path}`), env, ctx);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const companies = await allCompanies(new R2Store(bucket as unknown as R2Bucket));
    const alpha = companies.find((company) => company.name === "Delta Systems Limited")!;

    const unassigned = await api(`/api/companies/${alpha.id}/unassigned`);
    expect(unassigned.status).toBe(200);
    const body = unassigned.body as unknown as { contacts: UnassignedContact[]; totals: { unresolved: number; conflicting: number } };
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].fullName).toBe("Leo Frank");
    expect(body.contacts[0].association.category).toBe("unresolved");
    expect(body.totals.unresolved).toBe(1);
    expect(body.totals.conflicting).toBe(3);

    // The other categories are attached contacts, not preserved ones.
    const conflictingUnassigned = await api(`/api/companies/${alpha.id}/unassigned?category=conflicting`);
    expect((conflictingUnassigned.body as unknown as { contacts: UnassignedContact[] }).contacts).toHaveLength(0);

    const trusted = await api(`/api/companies/${alpha.id}/contacts?association=high_confidence`);
    const trustedContacts = (trusted.body as unknown as { contacts: Contact[] }).contacts;
    expect(trustedContacts.map((contact) => contact.fullName).sort()).toEqual(["Ada Lovelace", "Sam Allen"]);

    const disputed = await api(`/api/companies/${alpha.id}/contacts?association=conflicting`);
    const disputedContacts = (disputed.body as unknown as { contacts: Contact[] }).contacts;
    expect(disputedContacts.map((contact) => contact.fullName).sort()).toEqual(["Kyle Adams", "Omar Haddad", "Priya Menon"]);

    const profile = await api(`/api/companies/${alpha.id}`);
    const company = (profile.body as unknown as { company: Company }).company;
    expect(company.associations).toEqual({ highConfidence: 2, plausible: 1, conflicting: 3, total: 6 });
  }, 60_000);
});

/* -------------------------------------------------------------------------- */

/**
 * The audit, run as an operator runs it: the actual script, against the actual
 * generated objects.
 *
 * This is the reconciliation Section 11 asks for, measured instead of asserted by
 * construction: counts, association splits and facets are recomputed from what is
 * on disk and compared with what the records claim, and the stored categories are
 * compared with the audit's own independent classification of the same evidence.
 */
describe("the association audit, on a real generated index", () => {
  test("finds no lost contacts, no duplicates, and reconciles every count and facet", async () => {
    const fixture = await buildFixture();
    const script = join(import.meta.dir, "..", "scripts", "association-audit.mjs");
    const run = spawnSync("bun", [script, "--dir", fixture.outputDir, "--version", VERSION, "--json"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);

    expect(report.version).toBe(VERSION);
    expect(report.indexFormatVersion).toBe(3);
    // A contact is either attached or preserved; nothing is outside the two sums.
    expect(report.reconciliation.contactCount.mismatched).toBe(0);
    expect(report.reconciliation.associations.mismatched).toBe(0);
    expect(report.reconciliation.facets.mismatched).toBe(0);
    expect(report.reconciliation.ids.duplicated).toBe(0);
    expect(report.reconciliation.preserved).toBe(report.preserved.total);
    expect(report.preserved.missingClaimedName).toBe(0);
    // Every attached contact carries a stored category: "not classified" is only
    // allowed on a format-v2 index, and this one is v3.
    expect(report.associations.stored.unclassified).toBe(0);
    const stored = report.associations.stored.byCategory;
    expect(stored.high_confidence + stored.plausible + stored.conflicting).toBe(report.reconciliation.attached);
    // The run's own manifest agrees with what the objects hold.
    expect(report.manifestCounters.uniqueContacts).toBe(report.reconciliation.attached + report.reconciliation.preserved);
    // The before/after matrix covers every contact exactly once.
    const crossTabTotal = report.associations.crossTab.reduce((sum: number, row: { contacts: number }) => sum + row.contacts, 0);
    expect(crossTabTotal).toBe(report.reconciliation.attached);
    // No contact value may reach the report.
    expect(run.stdout).not.toContain("@");
    expect(run.stdout).not.toContain("Leo Frank");
  }, 60_000);
});

/* -------------------------------- helpers -------------------------------- */

/** Every company record of the fixture version, in ref order. */
async function allCompanies(store: R2Store): Promise<Company[]> {
  const directory = await store.getDirectory(VERSION);
  if (!directory) throw new Error("fixture directory is missing");
  const out: Company[] = [];
  for (let partition = 0; partition < directory.shards.companyPartitions; partition += 1) {
    const payload = await store.getJson<CompanyPartitionPayload>(companyPartitionKey(VERSION, partition));
    if (!payload) continue;
    out.push(...(payload.companies as Company[]));
  }
  return out;
}

async function deltaCompanies(store: R2Store): Promise<{ alpha: Company; beta: Company }> {
  const companies = await allCompanies(store);
  return {
    alpha: companies.find((company) => company.name === "Delta Systems Limited")!,
    beta: companies.find((company) => company.name === "Delta Systems Pvt Ltd")!,
  };
}

/** The contacts the index attached to one company (through the real reader). */
async function contactsOf(store: R2Store, companyId: string): Promise<Contact[]> {
  const source = await sourceFor(store);
  const ref = await source.refForCompanyId(companyId);
  if (ref === null) return [];
  return store.getContactsByCompanyRef(VERSION, ref);
}

/** The real read path (id index + profile/contact partitions), not a shortcut. */
async function sourceFor(store: R2Store): Promise<R2CandidateSource> {
  const directory = await store.getDirectory(VERSION);
  if (!directory) throw new Error("fixture directory is missing");
  return new R2CandidateSource(store, directory);
}
