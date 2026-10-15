#!/usr/bin/env node
/**
 * Verify what is really in R2 — no guessing, no fabrication.
 *
 *   # with rclone/S3 credentials exported for this terminal session
 *   bun scripts/verify-raw.mjs
 *   bun scripts/verify-raw.mjs --keys raw/companies_part1.csv,raw/companies_part2.csv
 *
 * Reads (never writes) and reports:
 *   - each original CSV object under raw/: present? size? etag?
 *   - manifests/active.json: which dataset version is published
 *   - manifests/<active>/manifest.json + validation.json: counts and verdict
 *   - indexes/<active>/directory.json: shard counts and object sizes
 *
 * Credentials come from the environment only (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY) and are never printed. Exit code 1 if a required object
 * is missing, so this can gate a deployment.
 */

import { credentialsFromEnv, R2Client } from "../tools/indexer/src/r2.ts";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const bucket = String(flag("bucket", "company-intel-data"));
const defaultKeys = ["raw/companies_part1.csv", "raw/companies_part2.csv"];
const rawKeys = flag("keys")
  ? String(flag("keys")).split(",").map((key) => key.trim()).filter(Boolean)
  : defaultKeys;

const credentials = credentialsFromEnv(bucket);
if (!credentials) {
  console.error(
    [
      "R2 credentials are not set for this terminal session, so nothing could be verified.",
      "",
      "Set them (PowerShell) and run again:",
      '  $env:R2_ACCOUNT_ID="<account id>"',
      '  $env:R2_ACCESS_KEY_ID="<access key id>"',
      '  $env:R2_SECRET_ACCESS_KEY="<secret access key>"',
      "",
      `Alternatively list the bucket with wrangler:  bunx wrangler r2 object list ${bucket} --prefix raw/`,
    ].join("\n"),
  );
  process.exit(2);
}

const client = new R2Client(credentials);
const megabytes = (bytes) => (bytes === null ? "unknown" : `${(bytes / 1e6).toFixed(2)} MB`);
let missing = 0;

console.log(`Bucket: ${bucket}\n`);

console.log("Original source files (raw/ — the app never writes here)");
for (const key of rawKeys) {
  const head = await client.head(key);
  if (!head.exists) {
    missing += 1;
    console.log(`  MISSING  ${key}`);
    continue;
  }
  console.log(`  ok       ${key}  ${megabytes(head.size)}  etag=${head.etag ?? "n/a"}`);
}

async function readJson(key) {
  const response = await client.get(key);
  if (!response.ok) return { ok: false, status: response.status, value: null };
  const text = await response.text();
  try {
    return { ok: true, status: response.status, value: JSON.parse(text) };
  } catch {
    return { ok: true, status: response.status, value: null, text };
  }
}

console.log("\nPublished dataset");
const pointer = await readJson("manifests/active.json");
if (!pointer.ok || !pointer.value?.version) {
  console.log("  No active dataset version (the app will report 'Dataset not indexed').");
} else {
  const version = pointer.value.version;
  console.log(`  active version   ${version}   published ${pointer.value.publishedAt ?? "unknown"}`);
  if (pointer.value.previous) console.log(`  previous version ${pointer.value.previous} (available for rollback)`);

  const manifest = await readJson(`manifests/${version}/manifest.json`);
  const validation = await readJson(`manifests/${version}/validation.json`);
  const directory = await readJson(`indexes/${version}/directory.json`);

  if (manifest.ok && manifest.value) {
    const counts = manifest.value.counters ?? manifest.value.counts ?? {};
    console.log(`  companies        ${counts.uniqueCompanies ?? "unknown"}`);
    console.log(`  contacts         ${counts.uniqueContacts ?? "unknown"}`);
    console.log(`  rows rejected    ${counts.rowsRejected ?? "unknown"}`);
    const perSource = counts.perSource ?? {};
    for (const [id, stats] of Object.entries(perSource)) {
      console.log(`  ${id.padEnd(16)} ${stats.rowsRead ?? "?"} rows read, ${stats.companies ?? "?"} companies, ${stats.contacts ?? "?"} contacts`);
    }
    if (!Object.keys(perSource).length) console.log("  ! manifest does not record per-source coverage — re-index with this version of the indexer");
  } else {
    missing += 1;
    console.log(`  MISSING  manifests/${version}/manifest.json (HTTP ${manifest.status})`);
  }

  console.log(`  validation       ${validation.ok && validation.value?.passed ? "passed" : "FAILED or missing"}`);
  if (directory.ok && directory.value) {
    const shards = directory.value.shards ?? {};
    console.log(`  shards           exact=${shards.exact} prefix=${shards.prefix} token=${shards.token} trigram=${shards.trigram} ids=${shards.ids}`);
    console.log(`  index bytes      ${megabytes(directory.value.bytes?.total ?? null)}`);
  } else {
    missing += 1;
    console.log(`  MISSING  indexes/${version}/directory.json (HTTP ${directory.status})`);
  }
}

console.log("");
if (missing > 0) {
  console.log(`${missing} expected object(s) missing — this is reported as missing rather than assumed present.`);
  process.exitCode = 1;
} else {
  console.log("All checked objects are present and readable.");
}
