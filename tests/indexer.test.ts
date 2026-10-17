import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import {
  ROWS_PER_SECOND_MEASURED,
  STORAGE,
  estimateWorkingSet,
  preflight,
  runIndex,
  type IndexerConfig,
} from "../tools/indexer/src/build";
import { adoptSpool, inspectSpool, readSpoolManifest, spoolManifestPathFor, type SpoolIdentity } from "../tools/indexer/src/spool";
import { readJsonlLines } from "../tools/indexer/src/jsonl";
import { R2CandidateSource, type ShardReader } from "../worker/src/search-source";
import { searchCompanies } from "../src/shared/search/engine";
import { companyPartitionKey, indexShardKey, partitionOfRef, type ShardPayload } from "../src/shared/search/index-format";
import type { Company, CompanyFacets, Contact } from "../src/shared/models";

const FIRST_HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Full Name", "Job Title", "Email", "LinkedIn URL"];

/** Records in every `part-*.jsonl`, and the raw bytes of the spool. */
async function spoolStats(workDir: string): Promise<{ files: number; records: number; bytes: number; hasLiteralSeparator: boolean }> {
  const files = (await readdir(join(workDir, "spool")).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
  let records = 0;
  let bytes = 0;
  let hasLiteralSeparator = false;
  for (const file of files) {
    const path = join(workDir, "spool", file);
    for await (const line of readJsonlLines(path)) {
      records += line.byteLength > 0 ? 1 : 0;
      bytes += line.byteLength + 1;
      if (line.text.includes("\u2028") || line.text.includes("\u2029")) hasLiteralSeparator = true;
    }
  }
  return { files: files.length, records, bytes, hasLiteralSeparator };
}
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
  const shardReads: { kind: string; shard: number }[] = [];

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

  test("a checkpoint from a different run is refused instead of silently merged", async () => {
    const workDir = join(dir, "work-provenance");
    await runIndex({ ...config, workDir, outputDir: join(dir, "out-prov") }, {});

    // Same workDir, different version: the spool belongs to the first run, so
    // resuming would merge two different inputs into one index.
    await expect(
      runIndex({ ...config, datasetVersion: "test-v2", workDir, outputDir: join(dir, "out-prov-2") }, {}),
    ).rejects.toThrow(/different run/);

    // `--no-resume` is the documented answer: it rebuilds from the sources.
    const rebuilt = await runIndex(
      { ...config, datasetVersion: "test-v2", workDir, outputDir: join(dir, "out-prov-3") },
      { resume: false },
    );
    expect(rebuilt.manifest.validationPassed).toBe(true);
    expect(rebuilt.counters.rowsRead).toBe(5);
    expect(rebuilt.counters.uniqueCompanies).toBe(3);
    expect(rebuilt.counters.uniqueContacts).toBe(5);
  });

  test("a fresh run clears the stale spool so rows cannot be counted twice", async () => {
    const workDir = join(dir, "work-stale-spool");
    const spoolLines = async () => {
      const files = (await readdir(join(workDir, "spool"))).filter((name) => name.endsWith(".jsonl"));
      let lines = 0;
      for (const name of files) {
        lines += (await readFile(join(workDir, "spool", name), "utf8")).split("\n").filter(Boolean).length;
      }
      return lines;
    };

    await runIndex({ ...config, workDir, outputDir: join(dir, "out-stale-1") }, {});
    // Five data rows are spooled (three from csv1, two from csv2).
    expect(await spoolLines()).toBe(5);

    // Pass 1 appends to `part-*.jsonl`. Without clearing, this second fresh run
    // would leave ten rows in the spool and double every count downstream.
    await runIndex({ ...config, workDir, outputDir: join(dir, "out-stale-2") }, { resume: false });
    expect(await spoolLines()).toBe(5);
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

describe("the pass-2 merge survives the separators real data contains", () => {
  /*
   * The 1,000,000-record benchmark died here:
   *
   *     JSON Parse error: Unterminated string
   *
   * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are what scraped
   * exports use as an in-cell line break. `JSON.stringify` leaves them literal in
   * a spool row, and `readline` — which pass 2 used — treats them as terminators,
   * so one record was read as two and the first half was truncated mid-string.
   *
   * The fixture below puts both characters in columns that reach the spool
   * unchanged (industry and job title are not display-normalised), which is what
   * the real files did. Every assertion is about the run completing without losing
   * or splitting a single record.
   */
  const U2028 = "\u2028";
  const U2029 = "\u2029";
  let dir: string;
  let config: IndexerConfig;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ci-separators-"));
    const source = join(dir, "separators.csv");
    await writeFile(
      source,
      csv(FIRST_HEADERS, [
        ["Globex" + U2028 + "Holdings", "globex.example", "Software" + U2029 + "Services", "United States", "Austin", "Ada" + U2028 + "Lovelace", "VP" + U2029 + "Engineering", "ada@globex.example", ""],
        ["Acme, Inc.", "acme.example", "Manufacturing", "United States", "Detroit", "John O'Neil", "Plant Manager", "john@acme.example", ""],
        ["Initech", "initech.example", "Hardware", "India", "Pune", "Pat Kim", "CTO", "pat@initech.example", ""],
      ]),
      "utf8",
    );
    config = {
      datasetVersion: "separators-v1",
      sources: [{ id: "csv1", path: source }],
      workDir: join(dir, "work"),
      outputDir: join(dir, "out"),
      partitions: 4,
      shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
    };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a run whose rows carry U+2028/U+2029 builds and validates", async () => {
    const result = await runIndex(config, {});
    expect(result.manifest.validationPassed).toBe(true);
    expect(result.counters.rowsRead).toBe(3);
    expect(result.counters.uniqueCompanies).toBe(3);
    expect(result.counters.uniqueContacts).toBe(3);

    // One spool record per source row: the separators are escaped on the way in,
    // so a reader can never see half a record.
    const stats = await spoolStats(config.workDir);
    expect(stats.records).toBe(3);
    expect(stats.hasLiteralSeparator).toBe(false);
  });

  test("re-reading the same spool resumes cleanly (the record is not split)", async () => {
    const resumed = await runIndex({ ...config, outputDir: join(dir, "out-resumed") }, {});
    expect(resumed.resumed).toBe(true);
    expect(resumed.manifest.validationPassed).toBe(true);
    expect(resumed.counters.rowsRead).toBe(3);
    expect(resumed.counters.uniqueCompanies).toBe(3);
  });
});

describe("spool completeness is recorded, verified and recoverable", () => {
  let dir: string;
  let config: IndexerConfig;

  const spoolDirFor = () => join(config.workDir, "spool");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ci-spool-"));
    const source = join(dir, "source.csv");
    await writeFile(
      source,
      csv(FIRST_HEADERS, [
        ["Tata Consultancy Services Limited", "tcs.com", "IT Services", "India", "Mumbai", "Asha Rao", "CTO", "asha@tcs.example", ""],
        ["Meridian Logistics GmbH", "meridian.example", "Logistics", "Germany", "Hamburg", "Lukas Weber", "Director", "lukas@meridian.example", ""],
        ["Acme Industries", "acme.example", "Manufacturing", "United States", "Austin", "Ada Lovelace", "CTO", "ada@acme.example", ""],
      ]),
      "utf8",
    );
    config = {
      datasetVersion: "spool-v1",
      sources: [{ id: "csv1", path: source }],
      workDir: join(dir, "work"),
      outputDir: join(dir, "out"),
      partitions: 4,
      shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
    };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("pass 1 records every partition with its size, record count and checksum", async () => {
    await runIndex(config, {});
    const manifest = await readSpoolManifest(config.workDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.complete).toBe(true);
    expect(manifest!.totals.lines).toBe(3);
    for (const entry of manifest!.partitions) {
      const size = (await stat(join(spoolDirFor(), entry.file))).size;
      expect(entry.bytes).toBe(size);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.lines).toBeGreaterThan(0);
    }
    expect(manifest!.totals.bytes).toBe(manifest!.partitions.reduce((total, entry) => total + entry.bytes, 0));
  });

  test("a spool with no manifest is refused instead of merged blind", async () => {
    await rm(spoolManifestPathFor(config.workDir), { force: true });
    await expect(runIndex({ ...config, outputDir: join(dir, "out-nomanifest") }, {})).rejects.toThrow(/no spool-manifest\.json/);

    // The documented recovery path: inspect, then adopt only if every partition
    // verifies. This is what lets an existing Pass 1 result be reused.
    const inspection = await inspectSpool(config.workDir);
    expect(inspection.verdict).toBe("incomplete");
    expect(inspection.totals.records).toBe(3);
    const identity = inspection.checkpoint.identity as SpoolIdentity;
    expect(identity).not.toBeNull();
    await adoptSpool(config.workDir, identity, inspection);

    const resumed = await runIndex({ ...config, outputDir: join(dir, "out-adopted") }, {});
    expect(resumed.resumed).toBe(true);
    expect(resumed.counters.rowsRead).toBe(3);
    expect(resumed.counters.uniqueCompanies).toBe(3);
    expect(resumed.manifest.validationPassed).toBe(true);
  });

  test("a truncated partition is detected by position and never merged", async () => {
    const manifest = await readSpoolManifest(config.workDir);
    const target = manifest!.partitions[0];
    const path = join(spoolDirFor(), target.file);
    const before = await readFile(path, "utf8");
    // Simulate an interrupted write: a partial record with no terminator.
    await writeFile(path, `${before}{ "keys": ["n:globex"`, "utf8");

    await expect(runIndex({ ...config, outputDir: join(dir, "out-truncated") }, {})).rejects.toThrow(/truncated/);

    const inspection = await inspectSpool(config.workDir);
    expect(inspection.verdict).toBe("damaged");
    const damaged = inspection.partitions.find((entry) => entry.problems.length > 0)!;
    expect(damaged.file).toBe(target.file);
    expect(damaged.problems[0].kind).toBe("truncated");
    expect(damaged.problems[0].line).toBe(target.lines + 1);
    expect(damaged.problems[0].byteOffset).toBe(target.bytes);
    expect(JSON.stringify(inspection)).not.toContain("globex");

    // Adopting it is refused as well: recording a manifest over a damaged spool
    // would be exactly the silent data loss the manifest exists to prevent.
    await expect(adoptSpool(config.workDir, manifest!.identity, inspection)).rejects.toThrow(/not provably complete/);

    // --no-resume is the documented answer, and it rebuilds a clean spool.
    const rebuilt = await runIndex({ ...config, outputDir: join(dir, "out-rebuilt") }, { resume: false });
    expect(rebuilt.manifest.validationPassed).toBe(true);
    expect(rebuilt.counters.rowsRead).toBe(3);
    expect((await inspectSpool(config.workDir)).verdict).toBe("clean");
  });

  test("a manifest that describes a different run is refused", async () => {
    const manifest = (await readSpoolManifest(config.workDir))!;
    await writeFile(
      spoolManifestPathFor(config.workDir),
      JSON.stringify({ ...manifest, identity: { ...manifest.identity, version: "some-other-version" } }),
      "utf8",
    );
    await expect(runIndex({ ...config, outputDir: join(dir, "out-mismatch") }, {})).rejects.toThrow(/describes a different run/);
  });

  test("a fresh run clears the previous manifest before it spools anything", async () => {
    // Restore a valid manifest, then start over: the old manifest must not survive
    // into the new pass 1, or a crash mid-way would leave a claim that pass 1
    // finished over a spool that was just emptied.
    await rm(spoolManifestPathFor(config.workDir), { force: true });
    const rebuilt = await runIndex({ ...config, outputDir: join(dir, "out-fresh") }, { resume: false });
    expect(rebuilt.manifest.validationPassed).toBe(true);
    const manifest = await readSpoolManifest(config.workDir);
    expect(manifest!.totals.lines).toBe(3);
  });
});

describe("preflight resource estimates match what a real run consumes", () => {
  const modeB: IndexerConfig = {
    datasetVersion: "bench",
    sources: [
      { id: "csv1", path: "r2://company-intel-data/raw/file1.csv" },
      { id: "csv2", path: "r2://company-intel-data/raw/file2.csv" },
    ],
    workDir: ".indexer-work",
    outputDir: ".indexer-output",
    partitions: 256,
    shards: { exact: 512, prefix: 256, token: 256, trigram: 512, ids: 256 },
    rawCacheDir: ".indexer-raw-cache",
  };
  /** The real object sizes, measured from the bucket. */
  const MEASURED = [
    { id: "csv1", bytes: 10_223_471_749 },
    { id: "csv2", bytes: 54_038_527_871 },
  ];

  test("the 1 M benchmark estimate includes the Mode B staging file it used to omit", () => {
    const estimate = estimateWorkingSet(modeB, MEASURED, { sampleLimit: 1_000_000 });
    // Before the fix this term did not exist in the arithmetic at all, and the
    // benchmark's own peak (2.49 GB) was above the 1.87 GB the preflight promised.
    expect(estimate.rawCachePeakBytes).toBeGreaterThan(1e9);
    expect(estimate.totalBytes).toBeGreaterThan(2_490_000_000);
    // The total is the sum of the named terms (times the margin), not a rounded
    // fraction of the input size.
    const terms = estimate.spoolBytes + estimate.rawCachePeakBytes + estimate.outputBytes + estimate.overheadBytes;
    expect(estimate.totalBytes).toBe(Math.ceil(terms * estimate.safetyMargin));
    expect(estimate.spoolBytes).toBe(2_000_000 * STORAGE.spoolBytesPerRow);
    expect(estimate.perSource.every((source) => source.mode === "r2" && source.rows === 1_000_000)).toBe(true);
  });

  test("the full-corpus requirement covers spool, raw cache and output", () => {
    const estimate = estimateWorkingSet(modeB, MEASURED, {});
    // Previously the preflight reported 70.96 GB, which is the SPOOL alone: the
    // 54 GB csv2 cache and the generated index were never in the total, even
    // though the repository's own docs budgeted ~145-155 GB for exactly this run.
    expect(estimate.spoolBytes).toBeGreaterThan(60e9);
    expect(estimate.rawCachePeakBytes).toBeGreaterThan(50e9);
    expect(estimate.totalBytes).toBeGreaterThan(140e9);
    expect(estimate.totalBytes).toBeGreaterThan(70_960_000_000);
  });

  test("the bookkeeping term scales with the run instead of being a flat 256 MB", () => {
    const tiny = estimateWorkingSet(modeB, MEASURED, { sampleLimit: 1_000 });
    // A thousand rows do not need a quarter of a gigabyte of headroom. A flat term is
    // what made a 3 MB fixture run refuse to finish on a volume that was merely busy.
    expect(tiny.overheadBytes).toBe(STORAGE.minimumOverheadBytes);

    const full = estimateWorkingSet(modeB, MEASURED, {});
    // The full corpus is ~100 M rows, so the term is capped at the measured ceiling.
    expect(full.overheadBytes).toBe(STORAGE.fixedOverheadBytes);
  });

  test("a local-file run has no staging term, and the sample bounds the spool", () => {
    const local: IndexerConfig = { ...modeB, sources: [{ id: "csv1", path: "/tmp/does-not-exist.csv" }], rawCacheDir: null };
    const estimate = estimateWorkingSet(local, [{ id: "csv1", bytes: 10_223_471_749 }], { sampleLimit: 1_000_000 });
    expect(estimate.rawCachePeakBytes).toBe(0);
    expect(estimate.spoolBytes).toBe(1_000_000 * STORAGE.spoolBytesPerRow);
  });

  test("preflight labels its duration as the measured end-to-end rate, not a synthetic one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-preflight-"));
    const source = join(dir, "one.csv");
    await writeFile(source, csv(FIRST_HEADERS, [["Acme, Inc.", "acme.example", "Manufacturing", "United States", "Austin", "Ada Lovelace", "CTO", "ada@acme.example", ""]]), "utf8");
    try {
      const report = await preflight(
        { datasetVersion: "preflight-v1", sources: [{ id: "csv1", path: source }], workDir: dir, outputDir: join(dir, "out"), partitions: 4, shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 } },
        undefined,
        { sampleLimit: 1_000_000 },
      );
      // One source × 1,000,000 records at the measured end-to-end rate. The old
      // 120,000 rows/s constant promised 8 s for this job.
      expect(report.estimatedDurationSeconds).toBe(1_000_000 / ROWS_PER_SECOND_MEASURED);
      expect(report.estimatedDurationSeconds).toBeGreaterThan(120);
      expect(ROWS_PER_SECOND_MEASURED).toBeLessThanOrEqual(10_000);
      expect(report.estimate.rawCachePeakBytes).toBe(0);
      // The reported figure IS the itemised total, so the number an operator reads
      // is the one the terms add up to (this sandbox has ~0.6 GB free, so whether a
      // warning appears depends on the machine — the arithmetic must not).
      expect(report.estimatedWorkBytes).toBe(report.estimate.totalBytes);
      expect(report.estimatedOutputBytes).toBe(report.estimate.outputBytes);
      // The bookkeeping term scales with the run's row count and is capped by the
      // full-corpus ceiling, so the itemised total is computed the same way here.
      const overhead = Math.min(
        STORAGE.fixedOverheadBytes,
        Math.max(STORAGE.minimumOverheadBytes, 1_000_000 * STORAGE.overheadBytesPerRow),
      );
      const terms = STORAGE.spoolBytesPerRow * 1_000_000 + STORAGE.outputBytesPerRow * 1_000_000 + overhead;
      expect(report.estimatedWorkBytes).toBe(Math.ceil(terms * STORAGE.safetyMargin));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a run reports where its time went, per stage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-stages-"));
    const source = join(dir, "one.csv");
    // Several hundred rows rather than one: the assertion below is that pass 1
    // reports a duration > 0, and a single-row pass 1 can finish inside the
    // millisecond resolution of `Date.now()` — a flaky failure about the clock, not
    // about the stage timings. The corpus is only large enough to be measurable.
    const rows = Array.from({ length: 400 }, (_, index) => [
      `Company ${index} Ltd`,
      `company-${index}.example`,
      "Manufacturing",
      "United States",
      "Austin",
      `Person ${index}`,
      "CTO",
      `person.${index}@company-${index}.example`,
      "",
    ]);
    await writeFile(source, csv(FIRST_HEADERS, rows), "utf8");
    const config: IndexerConfig = { datasetVersion: "stages-v1", sources: [{ id: "csv1", path: source }], workDir: join(dir, "work"), outputDir: join(dir, "out"), partitions: 4, shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 } };
    try {
      const fresh = await runIndex(config, {});
      expect(fresh.resumed).toBe(false);
      expect(fresh.stages.pass1Ms).toBeGreaterThan(0);
      for (const value of Object.values(fresh.stages)) expect(value).toBeGreaterThanOrEqual(0);

      const resumed = await runIndex({ ...config, outputDir: join(dir, "out-2") }, {});
      expect(resumed.resumed).toBe(true);
      expect(resumed.stages.pass1Ms).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
