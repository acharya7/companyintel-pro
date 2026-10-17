/**
 * CompanyIntel — repeatable synthetic association scenarios (dev harness).
 *
 * WHY THIS EXISTS
 * ---------------
 * The association rules are easiest to "verify" by looking at a handful of unit
 * cases, and easiest to break in the places unit cases do not reach: a parent
 * company whose domain looks like a subsidiary's, a public mailbox that must not
 * confirm anyone, two people with one name at two employers, a duplicate row that
 * must not become a second contact. This harness builds ONE synthetic corpus that
 * contains all of those, runs it through the REAL indexer, and reports what the
 * index actually stored — counts per scenario, the category split, reassignments,
 * duplicates, and a set of reconciliation invariants.
 *
 * WHAT IT IS NOT
 * --------------
 * This is a test corpus, not a measurement of real-data accuracy. It is
 * deliberately adversarial and small, so its category shares mean "the rules did
 * what the specification says on constructed evidence", never "X% of real
 * contacts are correct". Every report says so.
 *
 * Every company and person here is invented. No source data, no R2 credentials
 * and no network access are used; the index is built in a temporary directory and
 * (unless `keep` is set) deleted afterwards.
 *
 *   bun run index:assoc-scenarios            # human report
 *   bun run index:assoc-scenarios -- --json  # machine-readable
 *   bun run index:assoc-scenarios -- --keep  # keep the generated index
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { runIndex } from "../../tools/indexer/src/build.ts";
import { auditStoredAssociations } from "./association-audit.mjs";

export const SCENARIO_VERSION = "assoc-scenarios-v1";
const NOTICE =
  "SYNTHETIC corpus. These counts verify the rules on constructed evidence; they are not real-data association accuracy.";

/**
 * The association situations the specification asks to be covered, verbatim.
 *
 * Every scenario tags itself with the requirements it exercises (`covers`), and
 * `runAssociationScenarios` reports any requirement no scenario covers, so a
 * scenario cannot quietly be deleted and leave a gap behind.
 */
export const REQUIRED_COVERAGE = [
  "Companies with identical names in different countries",
  "Subsidiaries and parent companies",
  "Different companies using similar brand names",
  "Corporate email domains",
  "Generic/public email providers",
  "Conflicting employer evidence",
  "Employees changing companies",
  "Duplicate contact records",
  "Missing company identifiers",
  "Missing country and domain information",
  "Ambiguous company names",
];

/** Requirement → scenario ids that exercise it. */
export function scenarioCoverage() {
  const covered = new Map(REQUIRED_COVERAGE.map((requirement) => [requirement, []]));
  for (const scenario of SCENARIOS) {
    for (const requirement of scenario.covers ?? []) covered.get(requirement)?.push(scenario.id);
  }
  return covered;
}

/* -------------------------------------------------------------------------- */
/* Scenario definitions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every `contacts[]` entry is one source row. `companyDomain` is the company the
 * contact must end up attached to; `expect.preserved` means it must be kept in
 * `unassigned/` instead, with no employer. `moved` records whether the index must
 * store `movedFrom` (an email-domain reassignment, not merely resolving a
 * name-only claim).
 */
export const SCENARIOS = [
  {
    id: "same-name-different-countries",
    title: "Identical names in different countries",
    covers: ["Companies with identical names in different countries", "Missing country and domain information"],
    companies: [
      { name: "Meridian Systems", domain: "meridian-us.example", country: "United States", city: "Austin" },
      { name: "Meridian Systems", domain: "meridian-de.example", country: "Germany", city: "Berlin" },
    ],
    contacts: [
      {
        name: "Alice Stone",
        claim: "Meridian Systems",
        domain: "meridian-us.example",
        email: "alice.stone@meridian-us.example",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "meridian-us.example" },
      },
      {
        name: "Bob Weber",
        claim: "Meridian Systems",
        domain: "meridian-de.example",
        email: "bob.weber@meridian-de.example",
        country: "Germany",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "meridian-de.example" },
      },
      {
        name: "Cara Diaz",
        claim: "Meridian Systems",
        email: "cara.diaz@gmail.com",
        country: "Mexico",
        expect: { category: "unresolved", reason: "several_candidates_remain", preserved: true },
      },
      {
        name: "Dan Ito",
        claim: "Meridian Systems",
        email: "dan.ito@gmail.com",
        country: "United States",
        expect: { category: "plausible", reason: "country_identifies_company", companyDomain: "meridian-us.example" },
      },
    ],
  },
  {
    id: "subsidiaries-and-parent",
    title: "Subsidiary and parent company",
    covers: ["Subsidiaries and parent companies", "Corporate email domains"],
    companies: [
      { name: "Northwind Group", domain: "northwind.example", country: "United Kingdom", city: "London" },
      { name: "Northwind Logistics", domain: "logistics.northwind.example", country: "United Kingdom", city: "Leeds" },
    ],
    contacts: [
      {
        name: "Eve Turner",
        claim: "Northwind Logistics",
        domain: "logistics.northwind.example",
        email: "eve.turner@logistics.northwind.example",
        country: "United Kingdom",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "logistics.northwind.example" },
      },
      {
        // A parent-domain address at a subsidiary: direction matters, so this must
        // never be high confidence at the subsidiary (see `isBranchOf`). The row
        // carried only a name, so the country is what makes it a possible match.
        name: "Frank Moss",
        claim: "Northwind Logistics",
        email: "frank.moss@northwind.example",
        country: "United Kingdom",
        expect: { category: "plausible", reason: "country_identifies_company", companyDomain: "logistics.northwind.example" },
      },
      {
        // A name-only row the parent domain itself identifies: high confidence at
        // the group, and no invented "moved from" employer.
        name: "Gina Hall",
        claim: "Northwind Group",
        email: "gina.hall@northwind.example",
        country: "United Kingdom",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "northwind.example",
          moved: false,
        },
      },
    ],
  },
  {
    id: "similar-brand-names",
    title: "Different companies with similar brand names",
    covers: ["Different companies using similar brand names", "Corporate email domains"],
    companies: [
      { name: "Acme Analytics", domain: "acme-analytics.example", country: "United States", city: "Boston" },
      { name: "Acme Analytix", domain: "acme-analytix.example", country: "United States", city: "Boston" },
      { name: "Acme Analytics Group", domain: "acme-group.example", country: "United States", city: "Chicago" },
    ],
    contacts: [
      {
        name: "Hugo Lane",
        claim: "Acme Analytix",
        domain: "acme-analytix.example",
        email: "hugo.lane@acme-analytix.example",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "acme-analytix.example" },
      },
      {
        name: "Ivy Chen",
        claim: "Acme Analytics Group",
        domain: "acme-group.example",
        email: "ivy.chen@acme-group.example",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "acme-group.example" },
      },
      {
        // A domain that belongs to a DIFFERENT brand is not evidence for this one.
        name: "Gina Cole",
        claim: "Acme Analytics",
        email: "gina.cole@acme-analytix.example",
        country: "United States",
        expect: { category: "plausible", reason: "country_identifies_company", companyDomain: "acme-analytics.example" },
      },
      {
        name: "Jack Doyle",
        claim: "Acme Analytix",
        email: "jack.doyle@acme-analytics.example",
        country: "United States",
        expect: { category: "plausible", reason: "country_identifies_company", companyDomain: "acme-analytix.example" },
      },
    ],
  },
  {
    id: "corporate-domains",
    title: "Corporate email domains and branch mailboxes",
    covers: ["Corporate email domains"],
    companies: [{ name: "Vertex Data", domain: "vertexdata.example", country: "United States", city: "Denver" }],
    contacts: [
      {
        name: "Priya Nair",
        claim: "Vertex Data",
        domain: "vertexdata.example",
        email: "priya.nair@vertexdata.example",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "vertexdata.example" },
      },
      {
        // Only a name on the row: the exact corporate domain identifies the
        // employer. It is identification, not a reassignment from a claim.
        name: "Quentin Frost",
        claim: "Vertex Data",
        email: "quentin.frost@vertexdata.example",
        country: "United States",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "vertexdata.example",
          moved: false,
        },
      },
      {
        name: "Rosa Ortiz",
        claim: "Vertex Data",
        email: "rosa.ortiz@mail.vertexdata.example",
        country: "United States",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "vertexdata.example",
          moved: false,
        },
      },
    ],
  },
  {
    id: "public-email-providers",
    title: "Generic and public email providers",
    covers: ["Generic/public email providers"],
    companies: [{ name: "Lumen Labs", domain: "lumenlabs.example", country: "United States", city: "Seattle" }],
    contacts: [
      {
        name: "Jack Reed",
        claim: "Lumen Labs",
        email: "jack.reed@gmail.com",
        expect: { category: "plausible", reason: "single_strong_candidate", companyDomain: "lumenlabs.example" },
      },
      {
        name: "Kara Lin",
        claim: "Lumen Labs",
        email: "kara.lin@yahoo.com",
        country: "United States",
        expect: { category: "plausible", reason: "country_identifies_company", companyDomain: "lumenlabs.example" },
      },
      {
        name: "Leo Park",
        claim: "Lumen Labs",
        email: "leo.park@outlook.com",
        expect: { category: "plausible", reason: "single_strong_candidate", companyDomain: "lumenlabs.example" },
      },
      {
        // The ROW identifies the employer; the personal address neither confirms
        // nor contradicts it, so the record-provided identity still stands.
        name: "Mia Chen",
        claim: "Lumen Labs",
        domain: "lumenlabs.example",
        email: "mia.chen@gmail.com",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "lumenlabs.example" },
      },
    ],
  },
  {
    id: "conflicting-evidence",
    title: "Conflicting employer evidence",
    covers: ["Conflicting employer evidence", "Ambiguous company names"],
    companies: [
      { name: "Orion Data", domain: "orion-alpha.example", country: "United States", city: "Austin" },
      { name: "Orion Data", domain: "orion-beta.example", country: "United States", city: "Austin" },
    ],
    contacts: [
      {
        name: "Nate Ford",
        claim: "Orion Data",
        domain: "orion-alpha.example",
        email: "nate.ford@orion-beta.example",
        country: "United States",
        expect: { category: "conflicting", reason: "email_domain_conflicts_with_row_identity", companyDomain: "orion-alpha.example" },
      },
      {
        name: "Rae Kim",
        claim: "Orion Data",
        domain: "orion-alpha.example",
        email: "rae.kim@unrelated.example",
        country: "United States",
        expect: { category: "conflicting", reason: "email_domain_outside_name_family", companyDomain: "orion-alpha.example" },
      },
      {
        name: "Opal Reed",
        claim: "Orion Data",
        email: "opal.reed@orion-beta.example",
        country: "United States",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "orion-beta.example",
          moved: false,
        },
      },
      {
        name: "Quin Hall",
        claim: "Orion Data",
        email: "quin.hall@unrelated.example",
        country: "United States",
        expect: { category: "unresolved", reason: "several_candidates_remain", preserved: true },
      },
    ],
  },
  {
    id: "employees-changing-companies",
    title: "One person at two employers",
    covers: ["Employees changing companies", "Duplicate contact records"],
    companies: [
      { name: "Helios Energy", domain: "helios-energy.example", country: "United States", city: "Phoenix" },
      { name: "Helios Power", domain: "helios-power.example", country: "United States", city: "Tucson" },
    ],
    contacts: [
      {
        name: "Tess Nguyen",
        claim: "Helios Energy",
        domain: "helios-energy.example",
        email: "tess.nguyen@gmail.com",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "helios-energy.example" },
      },
      {
        name: "Tess Nguyen",
        claim: "Helios Power",
        domain: "helios-power.example",
        email: "tess.nguyen@gmail.com",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "helios-power.example" },
      },
    ],
    duplicates: [{ contact: 0, times: 1 }],
  },
  {
    id: "duplicate-rows",
    title: "Duplicate contact rows",
    covers: ["Duplicate contact records", "Ambiguous company names"],
    companies: [
      { name: "Cascade Retail", domain: "cascaderetail.example", country: "United States", city: "Portland" },
      { name: "Silverline", domain: "silverline-one.example", country: "United States", city: "Miami" },
      { name: "Silverline", domain: "silverline-two.example", country: "United States", city: "Miami" },
    ],
    contacts: [
      {
        name: "Uma Shah",
        claim: "Cascade Retail",
        domain: "cascaderetail.example",
        email: "uma.shah@cascaderetail.example",
        country: "United States",
        expect: { category: "high_confidence", reason: "row_carries_employer_identity", companyDomain: "cascaderetail.example" },
      },
      {
        name: "Vic Moss",
        claim: "Silverline",
        title: "Analyst",
        expect: { category: "unresolved", reason: "several_candidates_remain", preserved: true },
      },
    ],
    duplicates: [
      { contact: 0, times: 2 },
      { contact: 1, times: 1 },
    ],
  },
  {
    id: "missing-identifiers",
    title: "Missing company identifiers, country and domain",
    covers: ["Missing company identifiers", "Missing country and domain information"],
    companies: [{ name: "Nimbus Works" }],
    contacts: [
      {
        // The whole family is name-only, so the record itself is the answer —
        // preserved as plausible, never presented as verified.
        name: "Will Tran",
        claim: "Nimbus Works",
        email: "will.tran@nimbusworks.example",
        expect: { category: "plausible", reason: "no_credible_candidate", companyName: "Nimbus Works" },
      },
      {
        name: "Xena Ford",
        claim: "Nimbus Works",
        expect: { category: "plausible", reason: "no_credible_candidate", companyName: "Nimbus Works" },
      },
    ],
  },
  {
    id: "ambiguous-names",
    title: "Ambiguous company names",
    covers: ["Ambiguous company names", "Missing country and domain information", "Conflicting employer evidence"],
    companies: [
      { name: "Apex Solutions", domain: "apex-us.example", country: "United States", city: "New York" },
      { name: "Apex Solutions", domain: "apex-uk.example", country: "United Kingdom", city: "London" },
      { name: "Apex Solutions", domain: "apex-de.example", country: "Germany", city: "Berlin" },
    ],
    contacts: [
      {
        name: "Wes Ford",
        claim: "Apex Solutions",
        expect: { category: "unresolved", reason: "several_candidates_remain", preserved: true },
      },
      {
        name: "Xena Ruiz",
        claim: "Apex Solutions",
        email: "xena.ruiz@apex-de.example",
        country: "Germany",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "apex-de.example",
          moved: false,
        },
      },
      {
        // The address names the US company even though the contact's country is
        // Germany: an email domain is identity, country is a weaker hint.
        name: "Yuri Petrov",
        claim: "Apex Solutions",
        email: "yuri.petrov@apex-us.example",
        country: "Germany",
        expect: {
          category: "high_confidence",
          reason: "email_domain_matches_assigned_company",
          companyDomain: "apex-us.example",
          moved: false,
        },
      },
      {
        name: "Zoe Lang",
        claim: "Apex Solutions",
        domain: "apex-uk.example",
        email: "zoe.lang@apex-de.example",
        country: "United Kingdom",
        expect: { category: "conflicting", reason: "email_domain_conflicts_with_row_identity", companyDomain: "apex-uk.example" },
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Corpus                                                                     */
/* -------------------------------------------------------------------------- */

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values) {
  return values.map(csvField).join(",");
}

function contactRow(contact) {
  return csvLine([contact.claim, contact.domain ?? "", contact.name, contact.title ?? "Employee", contact.email ?? "", contact.country ?? ""]);
}

/** Build the two source files. Deterministic: the same scenarios give the same bytes. */
export function buildScenarioCorpus() {
  const companyRows = ["Company Name,Company Domain,Industry,Country,City"];
  const contactRows = ["organization,domain,full_name,title,work_email,contact_country"];
  const expectedRows = [];
  for (const scenario of SCENARIOS) {
    for (const company of scenario.companies) {
      companyRows.push(csvLine([company.name, company.domain ?? "", "Software", company.country ?? "", company.city ?? ""]));
    }
    for (const contact of scenario.contacts) {
      contactRows.push(contactRow(contact));
      expectedRows.push({ scenario: scenario.id, contact });
    }
    for (const duplicate of scenario.duplicates ?? []) {
      const contact = scenario.contacts[duplicate.contact];
      for (let i = 0; i < duplicate.times; i += 1) contactRows.push(contactRow(contact));
    }
  }
  return {
    csv1: `${companyRows.join("\n")}\n`,
    csv2: `${contactRows.join("\n")}\n`,
    rows: contactRows.length - 1,
    expectedRows,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading generated objects                                                  */
/* -------------------------------------------------------------------------- */

function readJsonFile(path) {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
}

function readPartitionObjects(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json.gz"))
    .sort()
    .map((name) => readJsonFile(join(dir, name)));
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the corpus, index it with the real pipeline, and evaluate every scenario.
 *
 * Returns a report object; `passed` is false when any expectation or invariant
 * fails. No assertion library is involved, so the CLI and the tests share exactly
 * the same measurements.
 */
export async function runAssociationScenarios(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "companyintel-assoc-scenarios-"));
  const cleanup = options.keep ? null : () => rmSync(root, { recursive: true, force: true });
  try {
    const corpus = buildScenarioCorpus();
    const sourceDir = join(root, "raw");
    mkdirSync(sourceDir, { recursive: true });
    const csv1 = join(sourceDir, "companies.csv");
    const csv2 = join(sourceDir, "people.csv");
    writeFileSync(csv1, corpus.csv1, "utf8");
    writeFileSync(csv2, corpus.csv2, "utf8");

    const outputDir = join(root, "out");
    const result = await runIndex(
      {
        datasetVersion: SCENARIO_VERSION,
        sources: [
          { id: "csv1", path: csv1, encoding: "utf8", delimiter: "," },
          { id: "csv2", path: csv2, encoding: "utf8", delimiter: "," },
        ],
        workDir: join(root, "work"),
        outputDir,
        partitions: 16,
        shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
      },
      options.onProgress ? { onProgress: options.onProgress } : {},
    );

    /* ------------------------------ read what was stored ------------------------------ */

    const companyObjects = readPartitionObjects(join(outputDir, "companies", SCENARIO_VERSION));
    const companies = companyObjects.flatMap((payload) => {
      const firstRef = payload.firstRef ?? 0;
      return (payload.companies ?? []).map((company, index) => ({ ref: firstRef + index, company }));
    });
    const contactsByRef = new Map();
    for (const payload of readPartitionObjects(join(outputDir, "contacts", SCENARIO_VERSION))) {
      for (const [ref, contacts] of Object.entries(payload.byCompany ?? {})) contactsByRef.set(Number(ref), contacts);
    }
    const attached = [...contactsByRef.values()].flat();
    const preserved = readPartitionObjects(join(outputDir, "unassigned", SCENARIO_VERSION)).flatMap((payload) => payload.contacts ?? []);
    const manifest = readJsonFile(join(outputDir, "manifests", SCENARIO_VERSION, "manifest.json"));
    const directory = readJsonFile(join(outputDir, "indexes", SCENARIO_VERSION, "directory.json"));

    const companyById = new Map(companies.map((entry) => [entry.company.id, entry.company]));
    const companyByDomain = new Map(companies.filter((entry) => entry.company.domain).map((entry) => [entry.company.domain, entry.company]));
    const companyByName = new Map(companies.map((entry) => [entry.company.name, entry.company]));
    const storedByName = new Map();
    for (const contact of [...attached, ...preserved]) {
      const list = storedByName.get(contact.fullName) ?? [];
      list.push(contact);
      storedByName.set(contact.fullName, list);
    }

    /* -------------------------------- scenarios -------------------------------- */

    const used = new Set();
    const scenarioReports = [];
    for (const scenario of SCENARIOS) {
      const checks = [];
      let moved = 0;
      for (const spec of scenario.contacts) {
        const candidates = (storedByName.get(spec.name) ?? []).filter((contact) => !used.has(contact));
        const expectedCompany = spec.expect.companyDomain
          ? companyByDomain.get(spec.expect.companyDomain)
          : spec.expect.companyName
            ? companyByName.get(spec.expect.companyName)
            : null;
        const match = candidates.find((contact) =>
          spec.expect.preserved ? contact.companyId === "" : Boolean(expectedCompany) && contact.companyId === expectedCompany.id,
        );
        const label = spec.name;
        if (!match) {
          checks.push({
            name: label,
            ok: false,
            detail: spec.expect.preserved
              ? "expected the contact to be preserved with no employer, but no such record exists"
              : `expected attachment to ${spec.expect.companyDomain ?? spec.expect.companyName}, but no such stored contact exists`,
          });
          continue;
        }
        used.add(match);
        const category = match.association?.category;
        const reason = match.association?.reason;
        const movedFrom = Boolean(match.association?.movedFrom);
        const problems = [];
        if (category !== spec.expect.category) problems.push(`category ${category} (expected ${spec.expect.category})`);
        if (reason !== spec.expect.reason) problems.push(`reason ${reason} (expected ${spec.expect.reason})`);
        if (movedFrom !== Boolean(spec.expect.moved)) problems.push(`moved ${movedFrom} (expected ${Boolean(spec.expect.moved)})`);
        if (spec.expect.preserved) {
          if (match.companyId !== "") problems.push(`preserved contact has companyId ${match.companyId}`);
          if (match.claimedCompanyName !== spec.claim) problems.push(`preserved contact lost its claimed name (${match.claimedCompanyName})`);
          if (candidates.length !== 1) problems.push(`${candidates.length} stored records share this name`);
        } else {
          if (match.companyId !== expectedCompany.id) problems.push(`attached to ${match.companyId} instead of ${expectedCompany.id}`);
          if (match.companyId && companyById.get(match.companyId)?.name !== spec.claim && !spec.expect.moved) {
            problems.push("attached to a company with a different name without a recorded move");
          }
        }
        if (movedFrom) moved += 1;
        checks.push({ name: label, ok: problems.length === 0, detail: problems.join("; ") });
      }

      const scenarioNames = new Set(scenario.contacts.map((contact) => contact.name));
      const stored = [...attached, ...preserved].filter((contact) => scenarioNames.has(contact.fullName));
      const count = (category) => stored.filter((contact) => contact.association?.category === category).length;
      const rows = scenario.contacts.length + (scenario.duplicates ?? []).reduce((sum, entry) => sum + entry.times, 0);
      scenarioReports.push({
        id: scenario.id,
        title: scenario.title,
        covers: scenario.covers,
        rows,
        stored: stored.length,
        duplicates: rows - stored.length,
        high: count("high_confidence"),
        plausible: count("plausible"),
        conflicting: count("conflicting"),
        unresolved: count("unresolved"),
        preserved: stored.filter((contact) => contact.companyId === "").length,
        moved,
        checks,
        passed: checks.every((check) => check.ok),
      });
    }

    /* -------------------------------- totals -------------------------------- */

    const categoryCount = (category) => [...attached, ...preserved].filter((contact) => contact.association?.category === category).length;
    const totals = {
      rows: scenarioReports.reduce((sum, scenario) => sum + scenario.rows, 0),
      stored: [...attached, ...preserved].length,
      high: categoryCount("high_confidence"),
      plausible: categoryCount("plausible"),
      conflicting: categoryCount("conflicting"),
      unresolved: categoryCount("unresolved"),
      preserved: preserved.length,
      moved: [...attached, ...preserved].filter((contact) => contact.association?.movedFrom).length,
      duplicates: result.counters.duplicateRowsResolved,
    };

    /* ------------------------- independent reconciliation ------------------------- */

    const audit = auditStoredAssociations({ companies, contactsByRef, unassigned: preserved, sampleLimit: 5 });
    const counters = result.counters;
    const expectedNames = new Set(SCENARIOS.flatMap((scenario) => scenario.contacts.map((contact) => contact.name)));
    const unexpected = [...attached, ...preserved].filter((contact) => !expectedNames.has(contact.fullName));

    const invariants = [
      {
        id: "both-sources",
        ok: result.manifest.validationPassed,
        detail: `manifest validation ${result.manifest.validationPassed ? "passed" : "FAILED"}`,
      },
      {
        id: "rows-accounted-for",
        ok: corpus.rows === counters.uniqueContacts + counters.duplicateRowsResolved,
        detail: `${corpus.rows} contact rows = ${counters.uniqueContacts} stored + ${counters.duplicateRowsResolved} duplicates`,
      },
      {
        id: "attached-plus-preserved",
        ok: audit.reconciliation.attached + audit.reconciliation.preserved === counters.uniqueContacts,
        detail: `${audit.reconciliation.attached} attached + ${audit.reconciliation.preserved} preserved = ${counters.uniqueContacts}`,
      },
      {
        id: "category-sum",
        ok: (categoryCount("high_confidence") + categoryCount("plausible") + categoryCount("conflicting") + categoryCount("unresolved")) === counters.uniqueContacts,
        detail: "high + plausible + conflicting + unresolved equals every stored contact",
      },
      {
        id: "attached-categories",
        ok: attached.every((contact) => ["high_confidence", "plausible", "conflicting"].includes(contact.association?.category)),
        detail: "no attached contact is classified unresolved, and every attached contact carries a category",
      },
      {
        id: "preserved-detached",
        ok: preserved.every((contact) => contact.companyId === "" && contact.association?.category === "unresolved"),
        detail: "every preserved contact has no employer and is unresolved",
      },
      {
        id: "no-name-invented",
        ok: unexpected.length === 0,
        detail: unexpected.length ? `${unexpected.length} stored contact(s) are not in the corpus` : "no stored contact is outside the synthetic corpus",
      },
      {
        id: "contact-count",
        ok: audit.reconciliation.contactCount.mismatched === 0,
        detail: `${audit.reconciliation.contactCount.mismatched} company contactCount mismatch(es)`,
      },
      {
        id: "association-split",
        ok: audit.reconciliation.associations.mismatched === 0,
        detail: `${audit.reconciliation.associations.mismatched} company association-split mismatch(es)`,
      },
      {
        id: "facets",
        ok: audit.reconciliation.facets.mismatched === 0,
        detail: `${audit.reconciliation.facets.mismatched} facet mismatch(es)`,
      },
      {
        id: "unique-ids",
        ok: audit.reconciliation.ids.duplicated === 0,
        detail: `${audit.reconciliation.ids.duplicated} duplicated contact id(s)`,
      },
      {
        id: "format-v3",
        ok: directory.formatVersion === 3 && manifest.indexFormatVersion === 3,
        detail: `directory format ${directory.formatVersion}, manifest format ${manifest.indexFormatVersion}`,
      },
      {
        id: "coverage",
        ok: [...scenarioCoverage().values()].every((scenarios) => scenarios.length > 0),
        detail: `${[...scenarioCoverage().values()].filter((scenarios) => scenarios.length === 0).length} required situation(s) with no scenario`,
      },
      {
        id: "no-fabricated-move",
        ok: totals.moved === 0,
        detail: `${totals.moved} contact(s) recorded a previous employer (a row that carried only a name has none)`,
      },
    ];

    const report = {
      generatedAt: new Date().toISOString(),
      synthetic: true,
      notice: NOTICE,
      index: {
        version: SCENARIO_VERSION,
        formatVersion: directory.formatVersion,
        companies: counters.uniqueCompanies,
        uniqueContacts: counters.uniqueContacts,
        rowsRead: counters.rowsRead,
        outputDir: options.keep ? outputDir : null,
      },
      totals,
      scenarios: scenarioReports,
      invariants,
      reconciliation: audit.reconciliation,
      counters: {
        rowsRead: counters.rowsRead,
        uniqueCompanies: counters.uniqueCompanies,
        uniqueContacts: counters.uniqueContacts,
        duplicateRowsResolved: counters.duplicateRowsResolved,
        contactsMoved: counters.contactsMoved,
        contactsHighConfidence: counters.contactsHighConfidence,
        contactsPlausible: counters.contactsPlausible,
        contactsConflicting: counters.contactsConflicting,
        contactsUnresolved: counters.contactsUnresolved,
      },
      passed: scenarioReports.every((scenario) => scenario.passed) && invariants.every((invariant) => invariant.ok),
    };
    return report;
  } finally {
    if (cleanup) cleanup();
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const WIDTHS = { scenario: 30, rows: 5, stored: 6, high: 5, plaus: 6, conf: 8, unres: 6, dup: 4, moved: 6, preserved: 9 };

function pad(value, width, right = false) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

/** Human-readable table plus every invariant; `--json` prints the raw object. */
export function formatAssociationScenarioReport(report) {
  const lines = [];
  lines.push("");
  lines.push("CompanyIntel association scenarios");
  lines.push("");
  lines.push(`  ${report.notice}`);
  lines.push(`  index ${report.index.version} · format v${report.index.formatVersion} · ${report.index.companies} companies · ${report.index.uniqueContacts} contacts`);
  lines.push("");
  lines.push(
    `  ${pad("scenario", WIDTHS.scenario)}${pad("rows", WIDTHS.rows, true)}${pad("stored", WIDTHS.stored, true)}${pad("high", WIDTHS.high, true)}${pad("plaus", WIDTHS.plaus, true)}${pad("conf", WIDTHS.conf, true)}${pad("unres", WIDTHS.unres, true)}${pad("dup", WIDTHS.dup, true)}${pad("moved", WIDTHS.moved, true)}${pad("preserved", WIDTHS.preserved, true)}  result`,
  );
  for (const scenario of report.scenarios) {
    lines.push(
      `  ${pad(scenario.id, WIDTHS.scenario)}${pad(scenario.rows, WIDTHS.rows, true)}${pad(scenario.stored, WIDTHS.stored, true)}${pad(scenario.high, WIDTHS.high, true)}${pad(scenario.plausible, WIDTHS.plaus, true)}${pad(scenario.conflicting, WIDTHS.conf, true)}${pad(scenario.unresolved, WIDTHS.unres, true)}${pad(scenario.duplicates, WIDTHS.dup, true)}${pad(scenario.moved, WIDTHS.moved, true)}${pad(scenario.preserved, WIDTHS.preserved, true)}  ${scenario.passed ? "PASS" : "FAIL"}`,
    );
  }
  lines.push(
    `  ${pad("TOTAL", WIDTHS.scenario)}${pad(report.totals.rows, WIDTHS.rows, true)}${pad(report.totals.stored, WIDTHS.stored, true)}${pad(report.totals.high, WIDTHS.high, true)}${pad(report.totals.plausible, WIDTHS.plaus, true)}${pad(report.totals.conflicting, WIDTHS.conf, true)}${pad(report.totals.unresolved, WIDTHS.unres, true)}${pad(report.totals.duplicates, WIDTHS.dup, true)}${pad(report.totals.moved, WIDTHS.moved, true)}${pad(report.totals.preserved, WIDTHS.preserved, true)}  ${report.passed ? "PASS" : "FAIL"}`,
  );
  lines.push("");
  lines.push("  invariants");
  for (const invariant of report.invariants) lines.push(`    ${invariant.ok ? "PASS" : "FAIL"}  ${invariant.id} — ${invariant.detail}`);
  const failed = report.scenarios.flatMap((scenario) => scenario.checks.filter((check) => !check.ok).map((check) => ({ scenario: scenario.id, ...check })));
  if (failed.length) {
    lines.push("");
    lines.push("  failed scenario checks");
    for (const failure of failed) lines.push(`    FAIL  ${failure.scenario}: ${failure.name} — ${failure.detail}`);
  }
  lines.push("");
  lines.push(report.passed ? "  result: PASS — every scenario and invariant held" : "  result: FAIL — see the checks above");
  lines.push("");
  return lines.join("\n");
}
