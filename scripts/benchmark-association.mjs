#!/usr/bin/env node
/**
 * CompanyIntel association (Stage A + Stage B) benchmark.
 *
 *   bun scripts/benchmark-association.mjs                     # 2,000 same-name companies, 20,000 contacts
 *   bun scripts/benchmark-association.mjs --companies 5000 --contacts 100000
 *   bun scripts/benchmark-association.mjs --json
 *
 * WHY IT EXISTS
 * -------------
 * `benchmark-pass2.mjs` measures the merge cost of a corpus with one company per
 * name, where Stage B has a single candidate for every contact. That is the cheap
 * case. This harness measures the expensive one — a **very large shared-name
 * family** — which is both the worst case for association (every contact is judged
 * against every candidate) and the shape the real data has (≈20,848 multi-entity
 * name families, the largest of them national brands).
 *
 * WHAT IT REPORTS
 * ---------------
 *   - the four association categories as the RUN reports them (attached high /
 *     plausible / conflicting, preserved unresolved), so the numbers are the
 *     indexer's own counters, not a re-derivation;
 *   - contacts reassigned between same-name companies and strong identifier claims
 *     refused (`contactsMoved`, `identifierConflicts`);
 *   - pass 1 and pass 2 stage timings, companies/s and contacts/s;
 *   - RSS and heap deltas across the run — the memory answer the specification asks
 *     for is "does Stage B hold anything proportional to the family?" (it does not:
 *     candidates are one small record per company, and contacts are decided one at
 *     a time).
 *
 * The corpus is synthetic and deliberately adversarial, so treat the timings as an
 * upper bound measured on THIS machine, not as a prediction for the 64 GB run.
 */

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const companies = Number(flag("companies", 2000));
const contactRows = Number(flag("contacts", 20_000));
const partitions = Number(flag("partitions", 64));
const json = Boolean(flag("json"));
const version = String(flag("version", "assoc-bench"));

/** A small shard skeleton: association cost is independent of the posting count. */
const SHARDS = { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 };

const { runIndex } = await import("../tools/indexer/src/build.ts");

/* ---------------------------------- corpus --------------------------------- */

const COMPANY_HEADERS = ["Company Name", "Company Domain", "Country", "City"];
const CONTACT_HEADERS = ["Company Name", "Full Name", "Job Title", "Email", "Contact Country"];

/**
 * One name, many companies — the case association exists for.
 *
 * Every organization row carries the SAME name and its own domain, so Stage A must
 * keep 2,000 companies apart on domain evidence alone and Stage B must judge each
 * contact against all of them (a single name family, which is the worst case).
 */
const SHARED_NAME = "Shared Systems Pvt Ltd";

function writeSources(root) {
  const companyPath = join(root, "organizations.csv");
  const contactPath = join(root, "people.csv");

  const companyLines = [COMPANY_HEADERS.join(",")];
  for (let index = 0; index < companies; index += 1) {
    companyLines.push([`"${SHARED_NAME}"`, `shared-${index}.example`, "United States", "Austin"].join(","));
  }
  writeFileSync(companyPath, `${companyLines.join("\n")}\n`, "utf8");

  const contactLines = [CONTACT_HEADERS.join(",")];
  for (let index = 0; index < contactRows; index += 1) {
    const mode = index % 3;
    // 0 → the contact's own domain names one company of the family (evidence, and a
    //     reassignment whenever it is not the one its row resolved to);
    // 1 → personal address: not evidence at all, so the family stays undecided;
    // 2 → no email and a country every member shares: several candidates remain.
    const email =
      mode === 0 ? `person.${index}@shared-${index % companies}.example` : mode === 1 ? `person.${index}@gmail.com` : "";
    // Every contact is in the same country as every candidate, so country can
    // never separate this family: only a matching corporate domain can.
    contactLines.push([`"${SHARED_NAME}"`, `"Person ${index}"`, "Analyst", email, "United States"].join(","));
  }
  writeFileSync(contactPath, `${contactLines.join("\n")}\n`, "utf8");

  return { companyPath, contactPath };
}

/* ----------------------------------- run ----------------------------------- */

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const number = (value) => Number(value ?? 0).toLocaleString();

const report = {
  mode: "association",
  corpus: { companies, contacts: contactRows, partitions, shards: SHARDS, nameFamily: 1, version },
  memory: null,
  counters: null,
  stages: null,
  throughput: null,
};

let exitCode = 0;
const root = mkdtempSync(join(tmpdir(), "companyintel-assoc-bench-"));

try {
  const sources = writeSources(root);
  const outputDir = join(root, "out");
  const config = {
    datasetVersion: version,
    sources: [
      { id: "csv1", path: sources.companyPath, encoding: "utf8", delimiter: "," },
      { id: "csv2", path: sources.contactPath, encoding: "utf8", delimiter: "," },
    ],
    workDir: join(root, "work"),
    outputDir,
    partitions,
    shards: SHARDS,
  };

  const before = process.memoryUsage();
  const started = Date.now();
  const result = await runIndex(config, {});
  const wallMs = Date.now() - started;
  const after = process.memoryUsage();

  const counters = result.counters;
  report.counters = {
    companies: counters.uniqueCompanies,
    contacts: counters.uniqueContacts,
    highConfidence: counters.contactsHighConfidence ?? 0,
    plausible: counters.contactsPlausible ?? 0,
    conflicting: counters.contactsConflicting ?? 0,
    preservedUnresolved: counters.contactsUnresolved ?? 0,
    moved: counters.contactsMoved ?? 0,
    identifierConflicts: counters.identifierConflicts ?? 0,
    duplicateRowsResolved: counters.duplicateRowsResolved ?? 0,
    ambiguousCompanies: counters.ambiguousCompanies,
  };
  report.stages = result.stages;
  report.throughput = {
    wallMs,
    companiesPerSecond: result.stages.pass2Ms > 0 ? Math.round(counters.uniqueCompanies / (result.stages.pass2Ms / 1000)) : null,
    contactsPerSecond: result.stages.pass2Ms > 0 ? Math.round(counters.uniqueContacts / (result.stages.pass2Ms / 1000)) : null,
  };
  report.memory = {
    rssDeltaBytes: after.rss - before.rss,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssAfterBytes: after.rss,
    heapUsedAfterBytes: after.heapUsed,
  };
  report.objects = result.objects.length;
} catch (error) {
  exitCode = 1;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const bytes = (value) => `${(value / 1024 / 1024).toFixed(1)} MB`;

if (json) console.log(JSON.stringify(report, null, 2));
else if (report.error) {
  console.error(`Association benchmark failed: ${report.error}`);
} else {
  const c = report.counters;
  console.log("\nAssociation benchmark (synthetic, adversarial shared-name family)");
  console.log(
    `  corpus            ${number(report.corpus.companies)} companies of ONE normalized name, ` +
      `${number(report.corpus.contacts)} contacts, ${report.corpus.partitions} partitions`,
  );
  console.log(`  companies         ${number(c.companies)}   contacts ${number(c.contacts)}   objects ${number(report.objects)}`);
  console.log(
    `  association       ${number(c.highConfidence)} high confidence, ${number(c.plausible)} plausible, ` +
      `${number(c.conflicting)} conflicting, ${number(c.preservedUnresolved)} preserved without an employer`,
  );
  console.log(`  moves             ${number(c.moved)} contact(s) reassigned between same-name companies`);
  console.log(`  claims refused    ${number(c.identifierConflicts)} strong identifier claim(s)`);
  console.log(`  duplicates        ${number(c.duplicateRowsResolved)} duplicate row(s) collapsed`);
  console.log(`  stage timings`);
  console.log(`    pass 1          ${seconds(report.stages.pass1Ms)}`);
  console.log(`    pass 2 merge    ${seconds(report.stages.pass2Ms)}  (${number(report.throughput.companiesPerSecond)} companies/s, ${number(report.throughput.contactsPerSecond)} contacts/s)`);
  console.log(`    finalize+index  ${seconds(report.stages.finalizeMs)}`);
  console.log(`    validate        ${seconds(report.stages.validateMs)}`);
  console.log(`  wall clock        ${seconds(report.throughput.wallMs)}`);
  console.log(`  memory            RSS ${bytes(report.memory.rssAfterBytes)} (${bytes(report.memory.rssDeltaBytes)} during the run), heap ${bytes(report.memory.heapUsedAfterBytes)} (${bytes(report.memory.heapUsedDeltaBytes)})`);
  console.log("\n  Synthetic and adversarial: a name family this large is the worst case for Stage B,");
  console.log("  not the average one. Timings are for THIS machine.");
  console.log("");
}

process.exitCode = exitCode;
