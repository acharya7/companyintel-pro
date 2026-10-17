#!/usr/bin/env node
/**
 * CompanyIntel — company ↔ contact association audit (read-only, local files).
 *
 *   bun run index:audit                                  # newest version in .indexer-output
 *   bun run index:audit -- --version v1-bench-1m
 *   bun run index:audit -- --sample 50 --json
 *
 * Answers the question the association rules have to answer before a full
 * production index is built: which contact↔company associations are supported by
 * evidence the index actually holds, which cannot be decided, and which are
 * contradicted by that evidence.
 *
 * Format v3 (association categories, `unassigned/` objects) is read when present;
 * a format-v2 index still audits, with every contact reported as `unclassified`
 * and nothing reported as preserved — "no category" is never read as a category.
 *
 * It reads only the objects a run already wrote — `companies/<version>`,
 * `contacts/<version>`, `unassigned/<version>` and the version's manifest — through the same decode path
 * `scripts/sample-report.mjs` uses. It makes no R2 call, needs no credentials,
 * writes nothing, and never prints a contact name, email, phone or LinkedIn URL:
 * the sample it prints is company ids and names.
 *
 * Exit codes: 0 = audit produced; 1 = no output directory or manifest to audit.
 *
 * Memory: it holds one compact record per distinct normalized company name (plus
 * the current partitions), i.e. roughly the same footprint as `index:sample-report`.
 * For the 1 M benchmark that is a few hundred MB of heap — run it on the machine
 * that holds the index, not on a small container.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { auditAssociations, auditRecommendations, auditStoredAssociations, formatAuditReport } from "./lib/association-audit.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const asJson = Boolean(flag("json"));
const dir = resolve(String(flag("dir", ".indexer-output")));
const sampleLimit = Math.max(0, Number(flag("sample", 25)) || 0);

if (!existsSync(dir)) {
  console.error(
    `No output directory at ${dir}. Run a sample or the benchmark first:\n` +
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
  versions.sort((a, b) => {
    const left = readJson(join(manifests, a, "manifest.json")).generatedAt ?? "";
    const right = readJson(join(manifests, b, "manifest.json")).generatedAt ?? "";
    return right.localeCompare(left);
  });
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
const directoryPath = join(dir, "indexes", version, "directory.json");
const directory = existsSync(directoryPath) ? readJson(directoryPath) : null;
const formatVersion = directory?.formatVersion ?? manifest.indexFormatVersion ?? null;

/* Companies: payload is { firstRef, companies: Company[] }, so the global ref of
   record i is firstRef + i. Contacts are stored per company ref. */
const companiesDir = join(dir, "companies", version);
const companies = [];
if (existsSync(companiesDir)) {
  for (const name of readdirSync(companiesDir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(companiesDir, name));
    const firstRef = payload.firstRef ?? 0;
    (payload.companies ?? []).forEach((company, index) => companies.push({ ref: firstRef + index, company }));
  }
}

/*
 * Format v4 moved `facets` into `details/` with the rest of the record-only
 * fields. The facet reconciliation below must keep checking real values, so the
 * detail record is merged back before it runs — otherwise every company would
 * have no facets, `facets.checked` would be 0, and the audit would report
 * "0 disagree" for a field it never looked at.
 */
const companyDetailsDir = join(dir, "details", version, "companies");
let detailsMerged = 0;
if (typeof formatVersion === "number" && formatVersion >= 4 && existsSync(companyDetailsDir)) {
  const byRef = new Map(companies.map((entry) => [entry.ref, entry]));
  for (const name of readdirSync(companyDetailsDir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(companyDetailsDir, name));
    const firstRef = payload.firstRef ?? 0;
    (payload.records ?? []).forEach((record, index) => {
      if (!record) return;
      const entry = byRef.get(firstRef + index);
      if (!entry) return;
      if (record.facets) entry.company.facets = record.facets;
      if (record.attributes) entry.company.attributes = record.attributes;
      detailsMerged += 1;
    });
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

/* Preserved contacts (format v3). Absent on a v2 index, which is reported as
   "none preserved" rather than as an error — a v2 index never kept them. */
const unassignedDir = join(dir, "unassigned", version);
const unassigned = [];
let unassignedObjects = 0;
if (existsSync(unassignedDir)) {
  for (const name of readdirSync(unassignedDir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(unassignedDir, name));
    unassignedObjects += 1;
    for (const contact of payload.contacts ?? []) unassigned.push(contact);
  }
}

const report = {
  version,
  dir,
  checkedAt: new Date().toISOString(),
  indexFormatVersion: formatVersion,
  detailsMerged,
  ...auditAssociations({ companies, contactsByRef, sampleLimit }),
  ...auditStoredAssociations({ companies, contactsByRef, unassigned, sampleLimit }),
  unassignedObjects,
  manifestCounters: manifest.counters ?? {},
};
report.recommendations = auditRecommendations(report);

if (asJson) console.log(JSON.stringify(report, null, 2));
else console.log(formatAuditReport(report));
