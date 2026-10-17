/**
 * Fixture dataset: two CSVs with **different schemas**, indexed by the real
 * indexer, so tests exercise the production pipeline rather than a simulation.
 *
 * Deliberately included (these are the cases that break naive pipelines):
 *   - csv1:      "Company Name", "Website", "Industry", "Country", "City",
 *                "Contact Name", "Job Title", "Email", "Phone"
 *   - csv2:      "organization", "domain", "linkedin_url", "industry",
 *                "employee_range", "full_name", "designation", "seniority",
 *                "department", "work_email", "mobile", "linkedin_profile",
 *                "location_country"
 *   - a company present in BOTH files with the same verified domain (must merge,
 *     and its contacts must come from both files),
 *   - two companies with the same name but different domains (must stay apart),
 *   - a multiline quoted job title, an embedded comma, an escaped quote,
 *   - a row with no company name (must be reported as rejected, not dropped),
 *   - a duplicated contact row inside one file (must deduplicate),
 *   - rows from csv2 that carry only a LinkedIn company URL as identity.
 *
 * The build is memoised: both e2e test files reuse one indexing run.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IndexerConfig, RunResult } from "../../tools/indexer/src/build";
import { runIndex } from "../../tools/indexer/src/build";

export interface FixtureDataset {
  result: RunResult;
  outputDir: string;
  workDir: string;
  version: string;
  /**
   * Remove the temp directory. **Do not call this from a test file.**
   *
   * `bun test` shares one module instance across test files in the same process,
   * so this fixture is a single directory that every file reads — and each file
   * can run in any order. A file that cleans up in `afterAll` deletes the index
   * out from under the others; that is exactly how `tests/search-cache.test.ts`
   * broke `tests/e2e-index.test.ts` and `tests/api-e2e.test.ts` with ENOENT on a
   * company partition. Cleanup is for a caller that owns the whole process (a
   * script), and the temp directory is otherwise left to the OS.
   */
  cleanup: () => void;
}

/* --------------------------------- csv1 ---------------------------------- */

/**
 * A value longer than the old 400-character capture cap, with commas (so the CSV
 * reader must honour quoting) and non-ASCII punctuation. It exists to prove the
 * lossless path end to end: indexer → partition object → API → record.
 */
const LONG_DESCRIPTION = Array.from(
  { length: 40 },
  (_, index) => `Segment ${index}: Microsoft builds platforms, tools and services for developers, enterprises and consumers — “worldwide”.`,
).join(" ");

/** Unicode a naive pipeline mangles (combining marks, CJK, emoji, RTL). */
const UNICODE_NOTE = "café · naïve · 東京 · مرحبا · ✅ — “quoted”";

/** csv1 carries a long company description and a unicode note on the first row only. */
const CSV1 = `"Company Name","Website","Industry","Country","City","Company Size","Contact Name","Job Title","Email","Phone","Company Description","Organization Notes"
"Microsoft Corporation","https://www.microsoft.com","Software","United States","Redmond","10001+","Satya Nadella","Chief Executive Officer","satya.nadella@microsoft.com","+1 425 882 8080","${LONG_DESCRIPTION}","${UNICODE_NOTE}"
"Microsoft Corporation","https://www.microsoft.com","Software","United States","Redmond","10001+","Kevin Scott","Chief Technology Officer","kevin.scott@microsoft.com",""
"Microsoft Corporation","https://www.microsoft.com","Software","United States","Redmond","10001+","Kevin Scott","Chief Technology Officer","kevin.scott@microsoft.com",""
"Infosys Limited","https://www.infosys.com","IT Services","India","Bengaluru","10001+","Salil Parekh","Chief Executive Officer
and Managing Director","salil.parekh@infosys.com","+91 80 2852 0261"
"Infosys Limited","https://www.infosys.com","IT Services","India","Bengaluru","10001+","Nilanjan Roy","Chief Financial Officer","nilanjan.roy@infosys.com",""
"Infosys Limited","https://www.infosys.com","IT Services","India","Bengaluru","10001+","""Ravi"" Kumar","Vice President, Delivery","ravi.kumar@infosys.com",""
"Vertex Analytics Private Limited","https://vertexanalytics.example","Analytics","India","Pune","201-500","Priya Menon","Head of Data, Analytics","priya.menon@vertexanalytics.example",""
"","https://nocompany.example","Consulting","India","Pune","","Someone Anon","Analyst","anon@nocompany.example",""
"Acme, Inc.","https://acme.example","Manufacturing","United States","Detroit","501-1000","John O'Neil","Plant Manager","john.oneil@acme.example","+1 313 555 0100"
`;

/* --------------------------------- csv2 ---------------------------------- */

const PERSON_BIO = `${"Amy has led finance across cloud, devices and enterprise sales. ".repeat(30)}—“quoted”, comma-separated, and 東京.`;
const CSV2 = `organization,domain,linkedin_url,industry,employee_range,full_name,designation,seniority,department,work_email,mobile,linkedin_profile,location_country,person_bio
Microsoft Corp,https://www.microsoft.com,https://www.linkedin.com/company/microsoft,Software,10001+,Amy Hood,Chief Financial Officer,Executive,Finance,amy.hood@microsoft.com,,https://www.linkedin.com/in/amyhood,United States,"${PERSON_BIO.replace(/"/g, '""')}"
Microsoft Corp,https://www.microsoft.com,https://www.linkedin.com/company/microsoft,Software,10001+,Judson Althoff,Chief Commercial Officer,Executive,Sales,judson.althoff@microsoft.com,+1 425 555 0199,,United States
Vertex Analytics Private Limited,https://www.vertexanalytics.example,https://www.linkedin.com/company/vertex-analytics,Analytics,51-200,Arun Das,Data Engineer,Mid,Data,arun.das@vertexanalytics.example,,,India
Vertex Analytics Pvt Ltd,https://metrics.vertexanalytics.example,https://www.linkedin.com/company/vertex-metrics,Analytics,51-200,Divya Rao,Director of Analytics,Director,Analytics,divya.rao@metrics.vertexanalytics.example,,,India
Northwind Traders,,https://www.linkedin.com/company/northwind-traders,Retail,201-500,Erin Boyle,Head of Buying,Director,Merchandising,erin.boyle@northwind.example,+44 20 7946 0101,,United Kingdom
Northwind Traders,,https://www.linkedin.com/company/northwind-traders,Retail,201-500,Erin Boyle,Head of Buying,Director,Merchandising,erin.boyle@northwind.example,+44 20 7946 0101,,United Kingdom
Globex Corporation,,https://www.linkedin.com/company/globex-corp,Industrial,501-1000,Hank Scorpio,Chief Executive Officer,Executive,Operations,hank.scorpio@globex.example,,,United States
`;

function writeFixtures(dir: string): { csv1: string; csv2: string } {
  mkdirSync(dir, { recursive: true });
  const csv1 = join(dir, "source-one.csv");
  const csv2 = join(dir, "source-two.csv");
  writeFileSync(csv1, CSV1, "utf8");
  writeFileSync(csv2, CSV2, "utf8");
  return { csv1, csv2 };
}

let cached: Promise<FixtureDataset> | null = null;

/** Run the real indexer over the two differently shaped fixtures. */
export function buildFixtureDataset(): Promise<FixtureDataset> {
  if (cached) return cached;
  cached = (async () => {
    const root = mkdtempSync(join(tmpdir(), "companyintel-fixture-"));
    const files = writeFixtures(join(root, "raw"));
    const config: IndexerConfig = {
      datasetVersion: "fixture-v1",
      sources: [
        { id: "csv1", path: files.csv1, encoding: "utf8", delimiter: "," },
        { id: "csv2", path: files.csv2, encoding: "utf8", delimiter: "," },
      ],
      workDir: join(root, "work"),
      outputDir: join(root, "out"),
      partitions: 16,
      shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
    };
    /*
     * The merge's free-space floor is lowered for the fixture on purpose.
     *
     * The default (512 MB) protects a real run whose output may be gigabytes; the
     * fixture's output is a few hundred kilobytes, so requiring half a gigabyte of free
     * space would make the whole suite fail on a machine — or in a container — that is
     * legitimately nearly full, for a reason that has nothing to do with the code under
     * test.
     */
    const result = await runIndex(config, { diskFloorBytes: 16 * 1024 * 1024 });
    return {
      result,
      outputDir: config.outputDir,
      workDir: config.workDir,
      version: config.datasetVersion,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  })();
  return cached;
}

/** Names/ids the tests assert against, so expectations live in one place. */
/** The over-long values the lossless-capture tests assert on, in one place. */
export const LONG_FIELDS = {
  companyDescription: LONG_DESCRIPTION,
  companyNote: UNICODE_NOTE,
  personBio: PERSON_BIO,
};

export const EXPECTED = {
  /** Present in csv1 (2 unique contacts) and csv2 (2 more) → one merged company. */
  microsoft: { name: "Microsoft Corporation", domain: "microsoft.com", contactsFromCsv1: 2, contactsFromCsv2: 2 },
  infosys: { name: "Infosys Limited", domain: "infosys.com", contacts: 3 },
  /** Same normalized name in BOTH files, different domains → must not merge. */
  vertexA: { name: "Vertex Analytics Private Limited", domain: "vertexanalytics.example" },
  vertexB: { name: "Vertex Analytics Pvt Ltd", domain: "metrics.vertexanalytics.example" },
  northwind: { name: "Northwind Traders", contacts: 1 },
  globex: { name: "Globex Corporation" },
  /** csv1 has a comma in the name and an apostrophe in the contact name. */
  acme: { name: "Acme, Inc.", contact: "John O'Neil" },
} as const;
