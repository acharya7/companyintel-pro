#!/usr/bin/env node
/**
 * Phase A — verify and profile the real source files in R2.
 *
 *   # 1. list what is really under raw/ (largest first, at most 25 objects)
 *   bun scripts/profile-raw.mjs --list
 *
 *   # 2. sample + profile both CSVs (default: first 6 MB of each, cut at the last
 *   #    complete record) and print two schema reports + a suggested config
 *   bun scripts/profile-raw.mjs
 *
 *   # 3. narrow to specific objects, and/or emit one share-safe JSON report
 *   bun scripts/profile-raw.mjs --keys raw/part1.csv,raw/part2.csv
 *   bun scripts/profile-raw.mjs --json > raw-schema-reports.json
 *
 * What it does NOT do: it never downloads a whole file (ranged GET only), never
 * writes to the bucket, and never prints credentials. Files copied under raw/ are
 * the originals and the app never writes there.
 *
 * `--json` prints headers, fill rates and the canonical mapping but **no cell
 * values**, so the report can be shared or pasted without leaking contact data.
 * The sampled bytes written to `--out` do contain real records: that directory is
 * gitignored, and must not be committed or shared.
 *
 * Credentials come from the environment (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY) and are read from your shell, not from this repository.
 * Setup for macOS and Windows: docs/r2-connection.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";
import { buildColumnMap, ALL_CANONICAL_FIELDS } from "../tools/indexer/src/mapping.ts";
import { profileCsvFile } from "../tools/indexer/src/csv.ts";
import { formatBytes, planRawListing, truncateAtRecordBoundary } from "./lib/raw-report.mjs";

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
const listOnly = Boolean(flag("list"));
const asJson = Boolean(flag("json"));
/** Bytes to sample per file. 6 MB is enough for headers, delimiters and samples. */
const sampleBytes = positiveInt(flag("bytes", 6_000_000), 6_000_000);
/** Same bound the Worker uses for `/api/dataset/sources` (MAX_RAW_OBJECTS = 25). */
const listLimit = positiveInt(flag("max", 25), 25);
const outDir = String(flag("out", ".raw-samples"));

const credentials = credentialsFromEnv(bucket);
if (!credentials) {
  console.error(
    [
      "R2 credentials are not set for this terminal session, so nothing could be read.",
      "",
      "Set them for the current session only (never commit them, never paste them into chat):",
      "  macOS / Linux:      export R2_ACCOUNT_ID=... ; export R2_ACCESS_KEY_ID=... ; export R2_SECRET_ACCESS_KEY=...",
      '  Windows PowerShell: $env:R2_ACCOUNT_ID="..."',
      "",
      "Without S3 keys you can still see what exists, using rclone:",
      `  rclone lsl r2:${bucket}/raw/`,
      "",
      "Setup details: docs/r2-connection.md",
    ].join("\n"),
  );
  process.exit(2);
}

const client = new R2Client(credentials);

/* -------------------------- 1. bounded raw/ listing ----------------------- */

const explicitKeys = flag("keys")
  ? String(flag("keys"))
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
  : null;

let objects;
let plan;
if (explicitKeys) {
  // Named explicitly: still only a HEAD each, so nothing is downloaded to list them.
  objects = [];
  for (const key of explicitKeys) {
    const head = await client.head(key);
    objects.push({ key, size: head.size, lastModified: null });
  }
  plan = { listed: objects, csvs: objects, others: [], truncated: false, objectsRead: objects.length };
} else {
  if (!asJson) console.log(`Listing ${bucket}/raw/ (at most ${listLimit} objects, largest first) …\n`);
  objects = await client.list("raw/", listLimit + 1);
  if (!objects.length) {
    console.error("No objects found under raw/. Upload your CSV files there before profiling.");
    process.exit(1);
  }
  plan = planRawListing(objects, listLimit);
  objects = plan.listed;
}

if (!explicitKeys && !asJson) {
  console.log(`Objects under raw/ (one bounded LIST returned ${plan.objectsRead})`);
  for (const object of objects) {
    console.log(
      `  ${formatBytes(object.size).padStart(10)}  ${object.key}  ${object.lastModified ?? "unknown mtime"}`,
    );
  }
  if (plan.truncated) console.log(`  … raw/ holds more objects than the ${listLimit}-object bound shows.`);
  if (plan.others?.length) console.log(`  non-CSV objects: ${plan.others.map((o) => o.key).join(", ")}`);
  console.log("");
}

if (listOnly) process.exit(0);

// Only CSV objects are profiled: a stray JSON/log object under raw/ is not a source.
const keys = explicitKeys ?? (plan.csvs ?? []).map((object) => object.key);

if (!keys.length) {
  console.error("No CSV objects were found under raw/. Pass --keys raw/<file>.csv to name them explicitly.");
  process.exit(1);
}

/* -------------------------- 2. sample + schema reports -------------------- */

mkdirSync(outDir, { recursive: true });
// With --json the only thing on stdout is the JSON report, so it can be piped to a file.
if (!asJson) {
  console.log(
    `Sampling up to ${formatBytes(sampleBytes)} from the head of each file (never the whole file).\n`,
  );
}

const reports = [];
for (const key of keys) {
  const head = await client.head(key);
  if (!head.exists) {
    reports.push({ key, error: "object not found" });
    if (!asJson) console.log(`${key}\n  MISSING — nothing was read or assumed.\n`);
    continue;
  }

  const raw = await client.getRange(key, Math.min(sampleBytes, head.size ?? sampleBytes));
  // Cut the sample back to the last complete record: a range boundary can land in
  // the middle of a quoted, multiline row, and a schema report computed from half
  // a record would be wrong. See scripts/lib/raw-report.mjs.
  const text = truncateAtRecordBoundary(raw.toString("utf8"));
  const partial = text.length < raw.length;

  const localPath = join(outDir, key.replace(/[\\/]/g, "_"));
  writeFileSync(localPath, text, "utf8");

  const profile = await profileCsvFile(localPath, {
    sampleRows: 400,
    knownFields: [...ALL_CANONICAL_FIELDS],
  });
  const mapping = buildColumnMap(profile.headers);

  if (!asJson) {
    console.log(`${key}  (${formatBytes(head.size ?? 0)} in R2, sampled ${formatBytes(text.length)}${partial ? ", trimmed to the last complete record" : ""})`);
    console.log(`  header line       ${profile.headerLine}`);
    console.log(`  delimiter         ${JSON.stringify(profile.delimiter)}   encoding ${profile.encoding}`);
    console.log(`  sampled records   ${profile.sampledRows.toLocaleString()}`);
    console.log("  columns:");
    for (const column of profile.columns) {
      console.log(
        `    ${String(column.index).padStart(3)}  ${column.header.slice(0, 32).padEnd(32)} ${column.looksLike.padEnd(6)} ` +
          `fill=${column.nonEmptyCount}/${column.nonEmptyCount + column.emptyCount}  e.g. ${(column.samples[0] ?? "—").slice(0, 38)}`,
      );
    }
    console.log("  canonical mapping:");
    for (const field of ALL_CANONICAL_FIELDS) {
      const index = mapping[field];
      console.log(
        `    ${field.padEnd(18)} ${index === undefined ? "— not mapped" : `→ column ${index} (${profile.headers[index]})`}`,
      );
    }
    if (profile.unmappedHeaders.length) console.log(`  unmapped headers: ${profile.unmappedHeaders.join(", ")}`);
    if (profile.missingCanonicalFields.length) {
      console.log(`  canonical fields absent: ${profile.missingCanonicalFields.join(", ")}`);
    }
    console.log("");
  }

  reports.push({
    key,
    bytes: head.size,
    sampledBytes: text.length,
    trimmedToLastCompleteRecord: partial,
    delimiter: profile.delimiter,
    encoding: profile.encoding,
    sampledRecords: profile.sampledRows,
    headerLine: profile.headerLine,
    headers: profile.headers,
    // Column metadata only — deliberately no cell values, so this can be shared.
    columns: profile.columns.map((column) => ({
      index: column.index,
      header: column.header,
      looksLike: column.looksLike,
      nonEmpty: column.nonEmptyCount,
      empty: column.emptyCount,
    })),
    mapping,
    absent: profile.missingCanonicalFields,
    unmapped: profile.unmappedHeaders,
    samplePath: localPath,
  });
}

/* ------------------------- 3. suggested indexer config -------------------- */

let suggestedSources = null;
if (reports.length === 2 && !reports.some((report) => report.error)) {
  const [first, second] = reports;
  suggestedSources = [first, second].map((report, index) => ({
    id: `csv${index + 1}`,
    path: `D:/company-intel/raw/${report.key.replace(/^raw\//, "")}`,
    encoding: report.encoding,
    delimiter: report.delimiter,
    note: "Set this path to the local copy of the file (keep the header check honest by re-running profile).",
  }));

  if (!asJson) {
    console.log("Suggested sources block for tools/indexer/indexer.config.json:");
    console.log(JSON.stringify({ sources: suggestedSources }, null, 2));
    console.log(
      "\nReview the two mappings above. If a canonical field was mapped from the wrong column,\n" +
        "add an explicit override for that source, e.g.\n" +
        '  "columns": { "companyname": "Organization Name", "email": "Work Email" }\n',
    );
    console.log(
      `Sampled bytes were written to ${outDir} — they contain real records: that directory is\n` +
        "gitignored. Do not commit or share it. The originals under raw/ were not modified.",
    );
  }
} else if (!asJson) {
  console.log(
    "Two readable CSV objects are required for a suggested config. Re-run with --list to see what exists under raw/.",
  );
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        bucket,
        checkedAt: new Date().toISOString(),
        sampledBytesPerFile: sampleBytes,
        objects: objects.map((object) => ({
          key: object.key,
          sizeBytes: typeof object.size === "number" ? object.size : null,
          lastModified: object.lastModified ?? null,
        })),
        reports,
        suggestedSources,
        note: "Headers, fill rates and mappings only — no cell values are included in this report.",
      },
      null,
      2,
    ),
  );
}
