#!/usr/bin/env node
/**
 * Phase A — verify and profile the real source files in R2.
 *
 *   # 1. list what is really under raw/ (no credentials printed)
 *   bun scripts/profile-raw.mjs --list
 *
 *   # 2. sample + profile both CSVs (default: first 6 MB of each, then cut at the
 *   #    last complete record) and print two schema reports + a suggested config
 *   bun scripts/profile-raw.mjs
 *
 *   # 3. narrow to specific objects
 *   bun scripts/profile-raw.mjs --keys raw/part1.csv,raw/part2.csv
 *
 * What it does NOT do: it never downloads a whole file (ranged GET only), never
 * writes to the bucket, and never prints credentials. Files copied under raw/
 * are the originals and the app never writes there.
 *
 * Credentials come from the environment (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY) and are read from your shell, not from this repository:
 *
 *   PowerShell (current session only):
 *     $env:R2_ACCOUNT_ID="<account id>"
 *     $env:R2_ACCESS_KEY_ID="<access key id>"
 *     $env:R2_SECRET_ACCESS_KEY="<secret access key>"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";
import { buildColumnMap, ALL_CANONICAL_FIELDS } from "../tools/indexer/src/mapping.ts";
import { profileCsvFile } from "../tools/indexer/src/csv.ts";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const bucket = String(flag("bucket", "company-intel-data"));
const listOnly = Boolean(flag("list"));
/** Bytes to sample per file. 6 MB is enough for headers, delimiters and samples. */
const sampleBytes = Number(flag("bytes", 6_000_000));
const outDir = String(flag("out", ".raw-samples"));

const credentials = credentialsFromEnv(bucket);
if (!credentials) {
  console.error(
    [
      "R2 credentials are not set for this terminal session, so nothing could be read.",
      "",
      "Set them for the current session only (never commit them, never paste them into chat):",
      '  $env:R2_ACCOUNT_ID="<account id>"',
      '  $env:R2_ACCESS_KEY_ID="<access key id>"',
      '  $env:R2_SECRET_ACCESS_KEY="<secret access key>"',
      "",
      "Alternatively verify presence with wrangler (no keys needed in this shell):",
      `  bunx wrangler r2 object list ${bucket} --prefix raw/`,
    ].join("\n"),
  );
  process.exit(2);
}

const client = new R2Client(credentials);
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

/* ---------------------------------- list ---------------------------------- */

let keys;
if (flag("keys")) {
  keys = String(flag("keys"))
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
} else {
  console.log(`Listing ${bucket}/raw/ …\n`);
  const objects = await client.list("raw/", 50);
  if (!objects.length) {
    console.error("No objects found under raw/. Upload your CSV files there before profiling.");
    process.exitCode = 1;
    process.exit();
  }
  keys = objects.map((object) => object.key);
  console.log("Objects under raw/");
  for (const object of objects) {
    console.log(`  ${object.key}  ${mb(object.size)}  ${object.lastModified ?? "unknown mtime"}`);
  }
  console.log("");
  if (listOnly) process.exit(0);
}

/* -------------------------- sample + schema reports ----------------------- */

mkdirSync(outDir, { recursive: true });

const reports = [];
for (const key of keys) {
  const head = await client.head(key);
  if (!head.exists) {
    reports.push({ key, error: "object not found" });
    console.log(`${key}\n  MISSING — nothing was read or assumed.\n`);
    continue;
  }

  // Sample the head of the file, then cut the last (possibly partial) line so a
  // truncated record cannot distort the profile. A quote-count check drops a
  // trailing record that ends inside a quoted field.
  const raw = await client.getRange(key, Math.min(sampleBytes, head.size ?? sampleBytes));
  let text = raw.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline > 0) text = text.slice(0, lastNewline + 1);
  const lastQuoteIndex = text.lastIndexOf('"');
  if (lastQuoteIndex > text.lastIndexOf("\n") - 1) {
    text = text.slice(0, text.lastIndexOf("\n") > 0 ? text.lastIndexOf("\n") + 1 : text.length);
  }

  const localPath = join(outDir, key.replace(/[\\/]/g, "_"));
  writeFileSync(localPath, text, "utf8");

  const profile = await profileCsvFile(localPath, {
    sampleRows: 400,
    knownFields: [...ALL_CANONICAL_FIELDS],
  });
  const mapping = buildColumnMap(profile.headers);

  console.log(`${key}  (${mb(head.size ?? 0)} in R2, sampled ${mb(text.length)})`);
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

  reports.push({
    key,
    bytes: head.size,
    delimiter: profile.delimiter,
    encoding: profile.encoding,
    headers: profile.headers,
    mapping,
    absent: profile.missingCanonicalFields,
    unmapped: profile.unmappedHeaders,
    samplePath: localPath,
  });
}

/* ------------------------- suggested indexer config ----------------------- */

if (reports.length === 2 && !reports.some((report) => report.error)) {
  const [first, second] = reports;
  const sources = [first, second].map((report, index) => ({
    id: `csv${index + 1}`,
    path: `D:/company-intel/raw/${report.key.replace(/^raw\//, "")}`,
    encoding: report.encoding,
    delimiter: report.delimiter,
    note: "Set this path to the local copy of the file (keep the header check honest by re-running profile).",
  }));

  console.log("Suggested sources block for tools/indexer/indexer.config.json:");
  console.log(JSON.stringify({ sources }, null, 2));
  console.log(
    "\nReview the two mappings above. If a canonical field was mapped from the wrong column,\n" +
      "add an explicit override for that source, e.g.\n" +
      '  "columns": { "companyname": "Organization Name", "email": "Work Email" }\n',
  );
  console.log("Sampled files were written to:", outDir);
  console.log(
    "They are the only bytes read from R2 (no full download). The originals under raw/ were not modified.",
  );
} else {
  console.log(
    "Two readable objects are required for a suggested config. Re-run with --list to see what exists under raw/.",
  );
}
