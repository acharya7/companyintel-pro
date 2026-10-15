#!/usr/bin/env node
/**
 * Phase A — read-only connection test and inventory of the real R2 bucket.
 *
 *   # credentials exported for this terminal session only (see docs/r2-connection.md)
 *   bun scripts/verify-raw.mjs
 *   bun scripts/verify-raw.mjs --keys raw/<file1>.csv,raw/<file2>.csv
 *   bun scripts/verify-raw.mjs --json > raw-verification.json     # share-safe report
 *
 * What it does — and nothing more:
 *   1. proves the bucket `company-intel-data` is reachable with these credentials
 *   2. lists at most 25 objects under `raw/` (largest first) with real names + sizes
 *   3. confirms both source CSVs are present, by name, rather than assuming names
 *   4. performs a bounded ranged GET (default 1 KB) per source to prove the object
 *      BODY is readable — without downloading a 10 GB or 50 GB file
 *   5. reports the published dataset (manifests/active.json → manifest/validation/
 *      directory) if one exists, and says so if none does
 *
 * It never writes, uploads, deletes, or makes the bucket public, and it never
 * prints or returns a credential value. Exit codes: 2 = no credentials in this
 * session, 1 = an expected object is missing or access was refused, 0 = all good.
 * Nothing is ever assumed: a missing object is reported as missing.
 */

import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";
import { compareExpected, formatBytes, planRawListing } from "./lib/raw-report.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const bucket = String(flag("bucket", "company-intel-data"));
/** The bound the Worker also uses for `/api/dataset/sources` (MAX_RAW_OBJECTS). */
const RAW_LIST_LIMIT = 25;
const listLimit = positiveInt(flag("max", RAW_LIST_LIMIT), RAW_LIST_LIMIT);
/** Bounded body read: enough to prove readability, nowhere near a whole file. */
const readBytes = positiveInt(flag("read-bytes", 1024), 1024);
const asJson = Boolean(flag("json"));
const explicitKeys = flag("keys")
  ? String(flag("keys"))
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
  : null;

const credentials = credentialsFromEnv(bucket);
if (!credentials) {
  console.error(
    [
      "R2 credentials are not set for this terminal session, so nothing could be verified.",
      "",
      "Set them for the current session only (never commit them, never paste them into chat):",
      "  macOS / Linux:      export R2_ACCOUNT_ID=... ; export R2_ACCESS_KEY_ID=... ; export R2_SECRET_ACCESS_KEY=...",
      '  Windows PowerShell: $env:R2_ACCOUNT_ID="..."',
      "",
      "Or name the bucket contents with rclone, which needs no S3 keys in this shell:",
      `  rclone lsl r2:${bucket}/raw/`,
      "",
      "Setup details: docs/r2-connection.md",
    ].join("\n"),
  );
  process.exit(2);
}

const client = new R2Client(credentials);
const problems = [];
const notices = [];
const report = {
  bucket,
  checkedAt: new Date().toISOString(),
  access: "unknown",
  rawPrefix: {
    listed: [],
    csvObjects: [],
    otherObjects: [],
    truncated: false,
    objectsRead: 0,
    max: listLimit,
  },
  selection: null,
  sources: [],
  dataset: null,
  problems,
  notices,
};

const lines = [];
const say = (line = "") => lines.push(line);

/* ---------------------- 1–2. access probe + bounded list ------------------ */

let listing;
try {
  // maxKeys = limit + 1 so truncation is detected rather than assumed.
  listing = await client.list("raw/", listLimit + 1);
} catch (error) {
  report.access = "denied";
  const detail = error instanceof Error ? error.message : String(error);
  problems.push(`raw/ could not be listed: ${detail}`);
  report.problems = problems;
  report.notices = notices;
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(`Cannot read ${bucket}/raw/ with these credentials.\n  ${detail}`);
    console.error(
      [
        "",
        "Check that: the access key belongs to this account, it has R2 read permission,",
        "the bucket name is exactly company-intel-data, and the objects are under raw/.",
        "Nothing was written, uploaded or deleted.",
      ].join("\n"),
    );
  }
  process.exit(1);
}

report.access = "ok";
const plan = planRawListing(listing, listLimit);
report.rawPrefix = {
  listed: plan.listed.map((object) => ({
    key: object.key,
    sizeBytes: typeof object.size === "number" ? object.size : null,
    lastModified: object.lastModified ?? null,
  })),
  csvObjects: plan.csvs.map((object) => object.key),
  otherObjects: plan.others.map((object) => object.key),
  truncated: plan.truncated,
  objectsRead: plan.objectsRead,
  max: listLimit,
};

/* ---------------------- 3. which objects are the sources ------------------ */

// Explicit keys win. Otherwise the two largest `.csv` objects under raw/ are taken
// to be the two source files — the 50 GB and 10 GB uploads — because a bounded,
// size-ordered LIST puts them first. Nothing is hardcoded, and when more than two
// CSV objects exist the choice is flagged as automatic rather than presented as fact.
const expected = explicitKeys ?? plan.csvs.slice(0, 2).map((object) => object.key);
report.selection = {
  mode: explicitKeys ? "explicit" : "two-largest-csv",
  ambiguous: !explicitKeys && plan.csvs.length > 2,
  csvCandidates: plan.csvs.map((object) => object.key),
  chosen: expected,
};

if (!explicitKeys && plan.csvs.length < 2) {
  problems.push(
    `raw/ contains ${plan.csvs.length} .csv object(s) within the ${listLimit}-object bound${
      plan.truncated ? ", and the LIST returned more objects than it could show" : ""
    }; pass --keys raw/<file1>.csv,raw/<file2>.csv to name the sources explicitly.`,
  );
} else if (report.selection.ambiguous) {
  notices.push(
    `Auto-selection chose the two largest .csv objects: ${expected.join(", ")}. ` +
      `raw/ also holds ${plan.csvs.length - 2} other .csv object(s) within the bound; ` +
      "pass --keys to name the sources explicitly if that is wrong.",
  );
}

const presence = compareExpected(expected, plan.listed);
for (const entry of presence) {
  if (!entry.present) problems.push(`expected object is not present in the raw/ listing: ${entry.key}`);
}

/* --------------------- 4. presence, size and bounded read ----------------- */

for (const entry of presence) {
  const source = {
    key: entry.key,
    present: entry.present,
    sizeBytes: null,
    etag: null,
    lastModified: entry.object?.lastModified ?? null,
    readBytes: null,
    readable: false,
    error: null,
  };

  if (!entry.present) {
    report.sources.push(source);
    continue;
  }

  try {
    const head = await client.head(entry.key);
    source.sizeBytes = head.size;
    source.etag = head.etag;
    if (!head.exists) {
      source.error = "HEAD returned no metadata";
      problems.push(`${entry.key}: HEAD returned no metadata.`);
      report.sources.push(source);
      continue;
    }
    // Bounded read: proves the body is really readable, downloads at most `readBytes`.
    const sample = await client.getRange(entry.key, readBytes);
    source.readBytes = sample.length;
    source.readable = sample.length > 0;
    if (!source.readable) problems.push(`${entry.key}: the ranged GET returned 0 bytes.`);
  } catch (error) {
    source.error = error instanceof Error ? error.message : String(error);
    problems.push(`${entry.key}: ${source.error}`);
  }

  report.sources.push(source);
}

/* --------------------------- 5. published dataset ------------------------- */

async function readJson(key) {
  const response = await client.get(key);
  if (!response.ok) return { ok: false, status: response.status, value: null };
  const text = await response.text();
  try {
    return { ok: true, status: response.status, value: JSON.parse(text) };
  } catch {
    return { ok: true, status: response.status, value: null, unparsable: true };
  }
}

const pointer = await readJson("manifests/active.json");
if (!pointer.ok || !pointer.value?.version) {
  report.dataset = { activeVersion: null, note: "No dataset version is published yet." };
} else {
  const version = pointer.value.version;
  const manifest = await readJson(`manifests/${version}/manifest.json`);
  const validation = await readJson(`manifests/${version}/validation.json`);
  const directory = await readJson(`indexes/${version}/directory.json`);
  const counters = manifest.value?.counters ?? manifest.value?.counts ?? {};

  report.dataset = {
    activeVersion: version,
    previousVersion: pointer.value.previousVersion ?? pointer.value.previous ?? null,
    publishedAt: pointer.value.publishedAt ?? pointer.value.activatedAt ?? null,
    manifestPresent: Boolean(manifest.ok && manifest.value),
    validationPassed: Boolean(validation.ok && validation.value?.passed),
    counters: {
      uniqueCompanies: counters.uniqueCompanies ?? null,
      uniqueContacts: counters.uniqueContacts ?? null,
      rowsRejected: counters.rowsRejected ?? null,
      perSource: counters.perSource ?? null,
    },
    indexShards: directory.value?.shards ?? null,
    indexBytes: directory.value?.bytes?.total ?? null,
  };

  if (!report.dataset.manifestPresent) problems.push(`manifests/${version}/manifest.json is missing.`);
  if (!report.dataset.validationPassed) problems.push(`Version ${version} has no passing validation record.`);
  if (!directory.ok || !directory.value) problems.push(`indexes/${version}/directory.json is missing.`);
  if (counters.perSource && Object.keys(counters.perSource).length < 2) {
    problems.push("The manifest records fewer than two contributing sources — verify both files were indexed.");
  }
}

/* --------------------------------- output -------------------------------- */

report.problems = problems;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  say(`Bucket ${bucket} — readable with these credentials (no writes performed).\n`);
  say(
    `Objects under raw/ (one bounded LIST returned ${plan.objectsRead}, showing up to ${listLimit}, largest first)`,
  );
  for (const object of plan.listed) {
    say(
      `  ${formatBytes(object.size).padStart(10)}  ${object.key}${object.lastModified ? `   ${object.lastModified}` : ""}`,
    );
  }
  if (!plan.listed.length) say("  (none — is the prefix really raw/ ?)");
  if (plan.truncated) say(`  … raw/ holds more objects than the ${listLimit}-object bound shows.`);
  if (plan.others.length) say(`  non-CSV objects under raw/: ${plan.others.map((o) => o.key).join(", ")}`);

  say("\nSource files");
  for (const source of report.sources) {
    if (!source.present) {
      say(`  MISSING   ${source.key}`);
      continue;
    }
    say(
      `  ok        ${source.key}  ${formatBytes(source.sizeBytes)}  etag=${source.etag ?? "n/a"}` +
        `  read ${formatBytes(source.readBytes)} of the body`,
    );
  }
  if (!report.sources.length) say("  No expected source could be identified; pass --keys to name them.");

  say("\nPublished dataset");
  if (!report.dataset?.activeVersion) {
    say("  none — the app will report \"Dataset not indexed\" until a version is published");
  } else {
    const dataset = report.dataset;
    say(`  active version    ${dataset.activeVersion}${dataset.publishedAt ? `   published ${dataset.publishedAt}` : ""}`);
    if (dataset.previousVersion) say(`  previous version  ${dataset.previousVersion} (rollback target)`);
    say(`  companies         ${dataset.counters.uniqueCompanies ?? "unknown"}`);
    say(`  contacts          ${dataset.counters.uniqueContacts ?? "unknown"}`);
    say(`  rows rejected     ${dataset.counters.rowsRejected ?? "unknown"}`);
    say(`  validation        ${dataset.validationPassed ? "passed" : "FAILED or missing"}`);
    if (dataset.indexShards) {
      const shards = dataset.indexShards;
      say(`  shards            exact=${shards.exact} prefix=${shards.prefix} token=${shards.token} trigram=${shards.trigram} ids=${shards.ids}`);
    }
    say(`  index size        ${formatBytes(dataset.indexBytes)}`);
  }

  say("");
  for (const notice of notices) say(`  note: ${notice}`);
  if (notices.length) say("");
  if (problems.length) {
    say(`${problems.length} problem(s) found — reported as problems, never assumed away:`);
    for (const problem of problems) say(`  ! ${problem}`);
  } else {
    say("All expected objects are present, readable, and the published dataset is intact.");
  }
  console.log(lines.join("\n"));
}

process.exitCode = problems.length > 0 ? 1 : 0;
