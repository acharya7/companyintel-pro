#!/usr/bin/env node
/**
 * CompanyIntel — sample index report (read-only, local files only).
 *
 *   bun run index:sample-report                                  # newest version in .indexer-output
 *   bun run index:sample-report -- --version v1-dry2-20k
 *   bun run index:sample-report -- --json
 *
 * Answers the association questions the specification asks after a sample run:
 * how many companies carry real identity, how many have contacts, how many
 * contacts sit on a company that was matched from the organization file, and how
 * many companies/contacts the runs rejected. Everything is measured from the
 * objects the run actually wrote — nothing is estimated, and nothing is inferred
 * from the source CSVs.
 *
 * Reads only the local output directory: no R2 call, no credentials, no writes.
 * Only counts are printed; contact names, emails and phones are never read into
 * the report.
 *
 * Exit codes: 0 = report produced; 1 = no output directory or manifest found.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { formatSampleReport, summariseAssociation } from "./lib/sample-report.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const asJson = Boolean(flag("json"));
const dir = resolve(String(flag("dir", ".indexer-output")));

if (!existsSync(dir)) {
  console.error(
    `No output directory at ${dir}. Run a sample first:\n` +
      "  bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 20000 --version v1-sample-20k",
  );
  process.exit(1);
}

function readJson(path) {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text);
}

/** Newest version directory under manifests/, so no argument is required. */
function newestVersion() {
  const manifests = join(dir, "manifests");
  if (!existsSync(manifests)) return null;
  const versions = readdirSync(manifests, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(manifests, name, "manifest.json")));
  if (!versions.length) return null;
  versions.sort(
    (a, b) =>
      Number(readJson(join(manifests, b, "manifest.json")).generatedAt?.localeCompare(readJson(join(manifests, a, "manifest.json")).generatedAt ?? "") ?? 0),
  );
  return versions[0];
}

const version = String(flag("version") || newestVersion() || "");
if (!version) {
  console.error(`No manifest found under ${join(dir, "manifests")}. Run a sample first (see docs/indexing.md).`);
  process.exit(1);
}

const manifestPath = join(dir, "manifests", version, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`No manifest for version ${version} at ${manifestPath}.`);
  process.exit(1);
}
const manifest = readJson(manifestPath);

/* Companies: payload is { firstRef, companies: Company[] }, so the global ref of
   record i is firstRef + i. Contacts are stored per company ref. */
const companiesDir = join(dir, "companies", version);
const companies = [];
const refsByPartition = new Map();
if (existsSync(companiesDir)) {
  for (const name of readdirSync(companiesDir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(companiesDir, name));
    const firstRef = payload.firstRef ?? 0;
    refsByPartition.set(name, firstRef);
    (payload.companies ?? []).forEach((company, index) => companies.push({ ref: firstRef + index, company }));
  }
}

const contactsDir = join(dir, "contacts", version);
const contactsByRef = new Map();
if (existsSync(contactsDir)) {
  for (const name of readdirSync(contactsDir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(contactsDir, name));
    for (const [ref, contacts] of Object.entries(payload.byCompany ?? {})) {
      contactsByRef.set(Number(ref), contacts);
    }
  }
}

const statsPath = join(dir, "manifests", version, "stats.json");
const stats = existsSync(statsPath) ? readJson(statsPath) : null;

const association = summariseAssociation({
  companies,
  contactsByRef,
  duplicateContactRows: manifest.counters?.duplicateRowsResolved ?? 0,
});

let objects = 0;
let bytes = { companies: 0, contacts: 0, indexes: 0 };
for (const bucket of ["companies", "contacts", "indexes"]) {
  const base = join(dir, bucket, version);
  if (!existsSync(base)) continue;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        objects += 1;
        bytes[bucket] += readFileSync(child).length;
      }
    }
  };
  walk(base);
}

const directoryPath = join(dir, "indexes", version, "directory.json");
const directory = existsSync(directoryPath) ? readJson(directoryPath) : null;

const report = {
  version,
  dir,
  checkedAt: new Date().toISOString(),
  counters: manifest.counters ?? {},
  coverage: stats?.contactCoverage ?? null,
  association,
  shards: directory?.shards ?? null,
  sizes: { objects, ...bytes },
  notes: [],
};

if (!companies.length) report.notes.push("No company objects were found for this version — nothing to associate.");
if (association.contacts.total && association.associationRate < 0.5) {
  report.notes.push(
    "Fewer than half of the contacts are attached to a company with a domain or LinkedIn page. That is the " +
      "signal to check the two files' company-name columns (see docs/schema-mapping.md) before a full run.",
  );
}
if (manifest.validationPassed === false) report.notes.push("The run's own validation did NOT pass — investigate before trusting these numbers.");

if (asJson) console.log(JSON.stringify(report, null, 2));
else console.log(formatSampleReport(report));
