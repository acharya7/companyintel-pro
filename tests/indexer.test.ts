import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  CompanyResolver,
  buildColumnMap,
  buildContact,
  companyKeysFromInput,
  contactFingerprint,
  extractCompanyInput,
  extractContactInput,
  finalizeFacets,
  accumulateFacets,
  pickCanonicalKey,
} from "../tools/indexer/src/mapping";
import { runIndex, preflight, type IndexerConfig } from "../tools/indexer/src/build";
import { R2CandidateSource, type ShardReader } from "../worker/src/search-source";
import { searchCompanies } from "../src/shared/search/engine";
import { companyPartitionKey, indexShardKey, partitionOfRef, type ShardPayload } from "../src/shared/search/index-format";
import type { Company, CompanyFacets, Contact } from "../src/shared/models";

const FIRST_HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Full Name", "Job Title", "Email", "LinkedIn URL"];
const SECOND_HEADERS = ["organization", "website", "company linkedin", "employees", "person name", "title", "work email", "region", "contact city", "department", "seniority"];

function csv(headers: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n") + "\n";
}

describe("header mapping", () => {
  test("maps common aliases from both schemas", () => {
    const first = buildColumnMap(FIRST_HEADERS);
    expect(first.companyname).toBe(0);
    expect(first.companydomain).toBe(1);
    expect(first.email).toBe(7);
    expect(first.linkedin).toBe(8);

    const second = buildColumnMap(SECOND_HEADERS);
    expect(second.companyname).toBe(0);
    expect(second.companydomain).toBe(1);
    expect(second.companylinkedin).toBe(2);
    expect(second.companysize).toBe(3);
    expect(second.contactname).toBe(4);
    expect(second.email).toBe(6);
    expect(second.department).toBe(9);
  });

  test("extracts canonical inputs and rejects rows without a company name", () => {
    const map = buildColumnMap(FIRST_HEADERS);
    const company = extractCompanyInput(
      ["Acme, Inc.", "https://www.acme.example/about", "Manufacturing", "United States", "Austin", "Ada Lovelace", "CTO", "ada@acme.example", "https://linkedin.com/in/ada"],
      map,
    );
    expect(company?.name).toBe("Acme, Inc.");
    expect(company?.domain).toBe("https://www.acme.example/about");

    const contact = extractContactInput(
      ["Acme, Inc.", "acme.example", "Manufacturing", "United States", "Austin", "Ada Lovelace", "CTO", "ada@acme.example", "https://linkedin.com/in/ada"],
      map,
    );
    expect(contact?.name).toBe("Ada Lovelace");
    expect(contact?.email).toBe("ada@acme.example");

    expect(extractCompanyInput(["", "acme.example"], map)).toBeNull();
  });
});

describe("identity resolution", () => {
  test("collects every identifier and partitions by the strongest", () => {
    const keys = companyKeysFromInput({ name: "Acme Incorporated", domain: "https://acme.example/x" }, "csv1");
    expect(keys.all).toContain("d:acme.example");
    expect(keys.bucket).toBe("d:acme.example");
    expect(keys.strong).toBe(true);
    expect(keys.normalizedName).toBe("acme");
  });

  test("name-derived identities are marked weak", () => {
    const keys = companyKeysFromInput({ name: "Acme Industries" }, "csv1");
    expect(keys.all).toEqual(["n:acme industries"]);
    expect(keys.strong).toBe(false);
  });

  test("canonical identity prefers domain, then linkedin, then source id, then name", () => {
    expect(pickCanonicalKey(["n:acme", "l:linkedin.com/company/acme", "d:acme.example"])).toBe("d:acme.example");
    expect(pickCanonicalKey(["n:acme", "l:linkedin.com/company/acme"])).toBe("l:linkedin.com/company/acme");
    expect(pickCanonicalKey(["n:acme", "s:csv1:123"])).toBe("s:csv1:123");
    expect(pickCanonicalKey(["n:acme"])).toBe("n:acme");
  });

  test("the spool partition is the normalized company name, so both files can meet", () => {
    // The join key: a company row and a contact row that name the same company
    // must land in the same partition, whatever else they carry. Partitioning by
    // the strongest identifier instead split organizations (domain) from people
    // (name only), leaving every contact unassociated in the real dataset.
    const companyRow = companyKeysFromInput(
      { name: "Microsoft Corporation", domain: "microsoft.com", sourceId: "org_1" },
      "csv1",
    );
    const contactRow = companyKeysFromInput({ name: "Microsoft Corp" }, "csv2");
    expect(companyRow.partitionKey).toBe("n:microsoft");
    expect(contactRow.partitionKey).toBe(companyRow.partitionKey);
    // …while the strongest identifier still describes the row itself.
    expect(companyRow.bucket).toBe("d:microsoft.com");
    expect(contactRow.bucket).toBe("n:microsoft");
  });

  test("name-only rows merge with name-only rows of the same normalized name", () => {
    const resolver = new CompanyResolver();
    const weak = resolver.resolve(companyKeysFromInput({ name: "Meridian Logistics" }, "csv1"));
    expect(weak.created).toBe(true);
    const weakAgain = resolver.resolve(companyKeysFromInput({ name: "Meridian Logistics Ltd" }, "csv2"));
    expect(weakAgain.created).toBe(false);
    expect(weakAgain.ref).toBe(weak.ref);

    // A different normalized name is a different company.
    const other = resolver.resolve(companyKeysFromInput({ name: "Meridian Logistics Group" }, "csv2"));
    expect(other.ref).not.toBe(weak.ref);
  });

  test("a row carrying strong identity is never merged on a name match alone", () => {
    const resolver = new CompanyResolver();
    const weak = resolver.resolve(companyKeysFromInput({ name: "Meridian Logistics" }, "csv1"));
    const strong = resolver.resolve(companyKeysFromInput({ name: "Meridian Logistics GmbH", domain: "meridian-logistics.example" }, "csv2"));
    expect(strong.created).toBe(true);
    expect(strong.ref).not.toBe(weak.ref);
    // Both records are flagged: the same name now maps to two identities.
    expect(strong.ambiguous).toBe(true);
    expect(resolver.entry(weak.ref)?.ambiguous).toBe(true);
  });

  test("the same domain merges rows across the two files, even when one row also has LinkedIn", () => {
    const resolver = new CompanyResolver();
    // Different identifier *kinds* are unioned: a row with a domain and a row with
    // a domain + LinkedIn page are the same company.
    const first = resolver.resolve(companyKeysFromInput({ name: "Tata Consultancy Services Limited", domain: "tcs.com" }, "csv1"));
    const second = resolver.resolve(
      companyKeysFromInput(
        { name: "Tata Consultancy Services", domain: "https://www.tcs.com/contact", linkedinUrl: "linkedin.com/company/tata-consultancy-services" },
        "csv2",
      ),
    );
    expect(second.ref).toBe(first.ref);
    expect(second.created).toBe(false);

    // The LinkedIn identifier learned from the second row now resolves on its own.
    const third = resolver.resolve(companyKeysFromInput({ name: "TCS", linkedinUrl: "https://www.linkedin.com/company/tata-consultancy-services/" }, "csv2"));
    expect(third.ref).toBe(first.ref);
  });

  test("contradictory strong identifiers keep records apart and flag them", () => {
    const resolver = new CompanyResolver();
    const first = resolver.resolve(companyKeysFromInput({ name: "Acme Industries", domain: "acme-one.example" }, "csv1"));
    const second = resolver.resolve(companyKeysFromInput({ name: "Acme Industries", domain: "acme-two.example" }, "csv2"));
    expect(first.ref).not.toBe(second.ref);
    // The first record is flagged when the contradiction is discovered.
    expect(resolver.entry(first.ref)?.ambiguous).toBe(true);
    expect(second.ambiguous).toBe(true);
  });
});

describe("contact deduplication", () => {
  const base = (overrides: Partial<Contact>): Contact => ({
    id: "p_1",
    companyId: "c_1",
    fullName: "Ada Lovelace",
    source: { source: "csv1", row: 1 },
    ...overrides,
  });

  test("email is the primary fingerprint", () => {
    expect(contactFingerprint(base({ email: "Ada@Acme.example" }))).toBe("e:Ada@Acme.example");
  });

  test("linkedin is used when there is no email", () => {
    expect(contactFingerprint(base({ linkedinUrl: "https://linkedin.com/in/ada" }))).toBe("l:linkedin.com/in/ada");
  });

  test("same name with a different title stays a separate person", () => {
    const one = contactFingerprint(base({ title: "CTO" }));
    const two = contactFingerprint(base({ title: "Head of Data" }));
    expect(one).not.toBe(two);
  });

  test("actions build a deduplicated contact row", () => {
    const company: Company = { id: "c_1", name: "Acme, Inc.", normalizedName: "acme", contactCount: 0, sources: [] };
    const contact = buildContact({
      input: { name: "Ada Lovelace", title: "CTO", email: "ADA@acme.example", linkedinUrl: "https://www.linkedin.com/in/ada/" },
      company,
      source: { source: "csv1", row: 4 },
      rowFingerprint: "csv1:4",
    });
    expect(contact.companyId).toBe("c_1");
    expect(contact.email).toBe("ada@acme.example");
    expect(contact.linkedinUrl).toBe("https://linkedin.com/in/ada");
  });

  test("facets accumulate and are trimmed", () => {
    const facets: CompanyFacets = { designations: [], departments: [], seniority: [], countries: [], cities: [], emailAvailable: 0, linkedinAvailable: 0 };
    accumulateFacets(facets, base({ designation: "CTO", department: "Engineering", country: "India", email: "a@b.co" }));
    accumulateFacets(facets, base({ designation: "CTO", department: "Engineering", country: "India" }));
    expect(facets.designations[0]).toEqual({ value: "CTO", count: 2 });
    expect(facets.emailAvailable).toBe(1);
    expect(finalizeFacets(facets, 1).departments).toHaveLength(1);
  });
});

describe("end-to-end indexing pipeline", () => {
  let dir: string;
  let config: IndexerConfig;
  let shardReads: { kind: string; shard: number }[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ci-index-"));
    const first = join(dir, "part1.csv");
    const second = join(dir, "part2.csv");

    await writeFile(
      first,
      csv(FIRST_HEADERS, [
        ["Tata Consultancy Services Limited", "tcs.com", "IT Services", "India", "Mumbai", "Asha Rao", "CTO", "asha@tcs.example", "https://linkedin.com/in/asha"],
        ["Meridian Logistics GmbH", "meridian.example", "Logistics", "Germany", "Hamburg", "Lukas Weber", "Director", "lukas@meridian.example", ""],
        ["Meridian Logistics", "", "Logistics", "Germany", "Hamburg", "Nina Koch", "Manager", "nina@meridian.example", ""],
        ["", "", "", "", "", "", "", "", ""],
      ]),
      "utf8",
    );

    await writeFile(
      second,
      csv(SECOND_HEADERS, [
        ["Tata Consultancy Services", "https://www.tcs.com/en", "linkedin.com/company/tata-consultancy-services", "10000+", "Ravi Kumar", "VP Engineering", "ravi@tcs.example", "India", "Pune", "Engineering", "VP"],
        ["Acme Industries", "acme.example", "", "51-200", "Ada Lovelace", "CTO", "ada@acme.example", "United States", "Austin", "Engineering", "C-Suite"],
      ]),
      "utf8",
    );

    config = {
      datasetVersion: "test-v1",
      sources: [
        { id: "csv1", path: first },
        { id: "csv2", path: second },
      ],
      workDir: join(dir, "work"),
      outputDir: join(dir, "out"),
      partitions: 4,
      shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
    };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("preflight reports both source files", async () => {
    const report = await preflight(config);
    expect(report.sources).toHaveLength(2);
    expect(report.sources.every((source) => source.exists && (source.bytes ?? 0) > 0)).toBe(true);
    expect(report.cpuCount).toBeGreaterThan(0);
  });

  test("builds a validated index from both files", async () => {
    const result = await runIndex(config, { onProgress: () => undefined });
    expect(result.manifest.validationPassed).toBe(true);
    // Both headers are skipped; the blank line in file 1 is not counted.
    expect(result.counters.rowsRead).toBe(5);
    expect(result.counters.rowsRejected).toBe(0);
    expect(result.counters.perSource.csv1.rowsRead).toBe(3);
    expect(result.counters.perSource.csv2.rowsRead).toBe(2);

    // Both files contributed companies and contacts.
    expect(result.counters.perSource.csv1.companies).toBeGreaterThan(0);
    expect(result.counters.perSource.csv2.companies).toBeGreaterThan(0);

    // Rows are spooled into the partition of the NORMALIZED COMPANY NAME, which is
    // the one signal both files can compute (see `partitionKey` in mapping.ts).
    // Two different names that normalize alike therefore meet, which is what lets
    // a contact-only file associate with a company-only file at all:
    //   - Tata Consultancy Services Limited (csv1, domain) +
    //     Tata Consultancy Services (csv2, domain + LinkedIn) → one company,
    //     one contact from each file;
    //   - Meridian Logistics GmbH (csv1, domain) + Meridian Logistics (csv1,
    //     no domain) → one company, because the normalized names are identical
    //     ("gmbh" is a legal suffix) and one row carries no contradicting
    //     evidence — its contact attaches to the strong record;
    //   - Acme Industries (csv2) → its own company.
    expect(result.counters.uniqueCompanies).toBe(3);
    expect(result.counters.uniqueContacts).toBe(5);

    // The `ambiguous` counter is reserved for a real contradiction: two records
    // whose normalized names collide while both carry *different* strong evidence
    // (the Vertex case in tests/e2e-index.test.ts). An exact name match where one
    // row has no contradicting evidence is an accepted association, not a
    // conflict, so nothing is flagged here.
    expect(result.counters.ambiguousCompanies).toBe(0);
  });

  test("writes every declared artefact plus manifest, stats and directory", async () => {
    const out = config.outputDir;
    expect(existsSync(join(out, "indexes/test-v1/directory.json"))).toBe(true);
    expect(existsSync(join(out, "manifests/test-v1/manifest.json"))).toBe(true);
    expect(existsSync(join(out, "manifests/test-v1/stats.json"))).toBe(true);
    expect(existsSync(join(out, "manifests/test-v1/validation.json"))).toBe(true);
    expect(existsSync(join(out, "companies/test-v1/00000.json.gz"))).toBe(true);
    expect(existsSync(join(out, "contacts/test-v1/00000.json.gz"))).toBe(true);
    expect(existsSync(join(out, "objects.jsonl"))).toBe(true);

    const validation = JSON.parse(await readFile(join(out, "manifests/test-v1/validation.json"), "utf8"));
    expect(validation.passed).toBe(true);
    expect(validation.missingObjects).toEqual([]);
  });

  test("the published index answers fuzzy queries through the Worker search path", async () => {
    const version = "test-v1";
    const reader: ShardReader = {
      async getShard(_version, kind, shard) {
        shardReads.push({ kind, shard });
        const path = join(config.outputDir, indexShardKey(version, kind, shard));
        if (!existsSync(path)) return null;
        return JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as ShardPayload;
      },
      async getCompaniesByRefs(_version, refs) {
        const byRef = new Map<number, Company>();
        const partitions = new Set(refs.map((ref) => partitionOfRef(ref)));
        for (const partition of partitions) {
          const path = join(config.outputDir, companyPartitionKey(version, partition));
          if (!existsSync(path)) continue;
          const payload = JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as { firstRef: number; companies: Company[] };
          refs
            .filter((ref) => partitionOfRef(ref) === partition)
            .forEach((ref) => {
              const company = payload.companies[ref - payload.firstRef];
              if (company) byRef.set(ref, company);
            });
        }
        return byRef;
      },
    };

    const directory = JSON.parse(await readFile(join(config.outputDir, "indexes/test-v1/directory.json"), "utf8"));
    const source = new R2CandidateSource(reader, directory);

    const typo = await searchCompanies(source, "Tata Consultency");
    expect(typo.hits[0]?.name).toBe("Tata Consultancy Services Limited");
    expect(typo.hits[0]?.contactCount).toBe(2); // one contact from each source file
    expect(typo.hits[0]?.multiSource).toBe(true);

    const exact = await searchCompanies(source, "tcs consultancy");
    expect(exact.hits[0]?.name).toBe("Tata Consultancy Services Limited");

    // One Meridian record: the name-only row's contact is associated with the row
    // that carries the domain, and the strong identity wins.
    const meridian = await searchCompanies(source, "Meridian Logistics");
    expect(meridian.hits.length).toBe(1);
    expect(meridian.hits[0]?.contactCount).toBe(2);
    expect(meridian.hits[0]?.domain).toBe("meridian.example");

    const unrelated = await searchCompanies(source, "zzzzzzzz");
    expect(unrelated.hits).toHaveLength(0);
  });

  test("re-running the indexer is idempotent and does not duplicate records", async () => {
    const again = await runIndex({ ...config, workDir: join(dir, "work2"), outputDir: join(dir, "out2") });
    expect(again.counters.uniqueCompanies).toBe(3);
    expect(again.counters.uniqueContacts).toBe(5);
    expect(again.manifest.validationPassed).toBe(true);
  });

  test("a resumed run keeps the pass-1 counters and still validates", async () => {
    const workDir = join(dir, "work-resume");
    const first = await runIndex({ ...config, workDir, outputDir: join(dir, "out-resume") }, {});
    expect(first.manifest.validationPassed).toBe(true);

    // Same workDir ⇒ the checkpoint says pass 1 is done, so pass 1 is skipped and
    // the row counters must be restored from the checkpoint. They used to restart
    // at zero, which made every resumed run report `source_missing_rows`
    // ("csv1=0, csv2=0") and fail validation over its own bookkeeping.
    const resumed = await runIndex({ ...config, workDir, outputDir: join(dir, "out-resume-2") }, {});
    expect(resumed.manifest.validationPassed).toBe(true);
    expect(resumed.counters.rowsRead).toBe(first.counters.rowsRead);
    expect(resumed.counters.perSource.csv1.rowsRead).toBe(3);
    expect(resumed.counters.perSource.csv2.rowsRead).toBe(2);
    expect(resumed.counters.uniqueCompanies).toBe(first.counters.uniqueCompanies);
    expect(resumed.counters.uniqueContacts).toBe(first.counters.uniqueContacts);
  });

  test("a run stops cleanly when free space drops below its floor", async () => {
    // An impossible floor (more than any machine has) proves the guard runs and the
    // error is the actionable one, rather than a crash after the disk filled.
    await expect(
      runIndex({ ...config, workDir: join(dir, "work-floor"), outputDir: join(dir, "out-floor") }, { diskFloorBytes: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(/Stopping before the disk fills/);
  });

  test("search reads a bounded number of shards", () => {
    expect(shardReads.length).toBeGreaterThan(0);
    expect(shardReads.length).toBeLessThan(120);
  });
});
