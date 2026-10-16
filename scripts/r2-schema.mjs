#!/usr/bin/env node
/**
 * CompanyIntel — real schema report for the two R2 source objects (read-only).
 *
 *   bun run r2:schema                       # both CSVs: columns, fill rates, mappings
 *   bun run r2:schema --json                # one share-safe JSON report
 *   bun run r2:schema --list                # inventory only, no sampling
 *   bun run r2:schema --keys raw/a.csv,raw/b.csv
 *   bun run r2:schema --bytes 8000000       # sample size per object (default 6 MB)
 *
 * For each source it prints the mapping the specification asks for —
 * **original column → normalized header → canonical field → confidence** — with
 * the evidence, every ambiguous case flagged for a human decision, and a
 * ready-to-paste `sources[]` block (MODE B) for `tools/indexer/indexer.config.json`.
 *
 * Guarantees:
 *   - bounded: one HEAD plus ONE ranged GET per object (default 6 MB), never a
 *     whole 10 GB/50 GB download;
 *   - read-only: the only requests it can make are a listing, a HEAD and a ranged
 *     GET — no put/delete/copy, no manifest, no publish;
 *   - no cell values: the report is built with `maxSamplesPerColumn: 0`, so no
 *     contact record can reach the output. Nothing is written to disk either,
 *     not even the sample;
 *   - nothing invented: a column with no header alias and no value shape is
 *     reported as unmapped.
 *
 * Credentials come from the private local file automatically
 * (`tools/indexer/src/credentials.ts`); `bun run r2:doctor` explains the setup.
 * Exit codes: 0 = report produced; 1 = a source was unreadable/empty; 2 = no
 * credentials configured.
 */

import { DEFAULT_BUCKET, assertNoSecretsOnCommandLine, resolveCredentials } from "../tools/indexer/src/credentials.ts";
import { R2Client } from "../tools/indexer/src/r2.ts";
import { buildSchemaReport, recommendedColumnOverride } from "../src/shared/r2/schema.ts";
import { formatBytes, planRawListing } from "./lib/raw-report.mjs";
import { formatSchemaReport } from "./lib/schema-report.mjs";

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

try {
  assertNoSecretsOnCommandLine(argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const asJson = Boolean(flag("json"));
const listOnly = Boolean(flag("list"));
const sampleBytes = positiveInt(flag("bytes", 6_000_000), 6_000_000);
const maxRows = positiveInt(flag("rows", 2000), 2000);
const listLimit = positiveInt(flag("max", 25), 25);

let resolved;
try {
  resolved = resolveCredentials(
    typeof flag("bucket") === "string" ? String(flag("bucket")) : DEFAULT_BUCKET,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { credentials, status } = resolved;
if (!credentials) {
  console.error(
    [
      "No R2 credentials are configured for the server-side tools.",
      "",
      "Run `bun run r2:doctor` for the exact setup, or create the private file",
      `${status.filePath ?? ".r2-credentials.json"} (git-ignored) and re-run this command.`,
    ].join("\n"),
  );
  process.exit(2);
}

const client = new R2Client(credentials);
const problems = [];
const notices = [];
const prefix = String(flag("prefix", status.rawPrefix || "raw/"));

/* --------------------------------- listing -------------------------------- */

let listing;
try {
  // One bounded LIST: limit + 1 so truncation is observed, not assumed.
  listing = await client.list(prefix, listLimit + 1);
} catch (error) {
  console.error(`Cannot list ${credentials.bucket}/${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Nothing was read or modified. Run `bun run r2:doctor` to check the credentials.");
  process.exit(1);
}

const plan = planRawListing(listing, listLimit);
const explicitKeys = flag("keys")
  ? String(flag("keys"))
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
  : null;

if (plan.truncated) {
  notices.push(
    `${prefix} holds more objects than the ${listLimit}-object bound shows; the two largest .csv objects were selected. ` +
      "Pass --keys to name the sources explicitly.",
  );
}

if (listOnly) {
  const objects = plan.listed.map((object) => ({
    key: object.key,
    sizeBytes: typeof object.size === "number" ? object.size : null,
    lastModified: object.lastModified ?? null,
  }));
  if (asJson) {
    console.log(JSON.stringify({ bucket: credentials.bucket, prefix, objects, truncated: plan.truncated }, null, 2));
  } else {
    console.log(`Objects under ${prefix} (one bounded LIST returned ${plan.objectsRead}, showing up to ${listLimit}, largest first)`);
    for (const object of objects) {
      console.log(`  ${formatBytes(object.sizeBytes).padStart(10)}  ${object.key}${object.lastModified ? `   ${object.lastModified}` : ""}`);
    }
    for (const notice of notices) console.log(`  note: ${notice}`);
  }
  process.exit(0);
}

const keys = explicitKeys ?? plan.csvs.slice(0, 2).map((object) => object.key);
if (!keys.length) {
  console.error(`No .csv objects were found under ${prefix}. Pass --keys ${prefix}<file>.csv to name the sources.`);
  process.exit(1);
}
if (!explicitKeys && plan.csvs.length < 2) {
  problems.push(`only ${plan.csvs.length} .csv object(s) are visible under ${prefix}; two sources are expected`);
}

/* --------------------------------- sampling ------------------------------- */

const objects = [];
for (const key of keys) {
  try {
    const head = await client.head(key);
    if (!head.exists) {
      objects.push({ key, error: "not found under the prefix (HEAD returned no metadata)" });
      problems.push(`${key} was not found — check the key against --list; nothing was assumed.`);
      continue;
    }
    const want = head.size === null ? sampleBytes : Math.min(sampleBytes, head.size);
    const bytes = new Uint8Array(await client.getRange(key, want));
    const report = buildSchemaReport({
      key,
      bytes,
      objectBytes: head.size,
      truncatedByBound: head.size !== null && head.size > bytes.length,
      maxRows,
    });
    objects.push(report);
    for (const problem of report.problems ?? []) problems.push(`${key}: ${problem}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    objects.push({ key, error: message });
    problems.push(`${key}: ${message}`);
  }
}

/* ------------------------- suggested indexer config ----------------------- */

let suggestedSources = null;
if (objects.length === 2 && !objects.some((object) => object.error)) {
  suggestedSources = objects.map((object, index) => {
    const override = recommendedColumnOverride(object);
    return {
      id: `csv${index + 1}`,
      path: `r2://${credentials.bucket}/${object.key}`,
      encoding: object.encoding.encoding,
      delimiter: object.delimiter.delimiter,
      ...(Object.keys(override).length ? { columns: override } : {}),
    };
  });
}

const bundle = {
  bucket: credentials.bucket,
  checkedAt: new Date().toISOString(),
  sampledBytesPerFile: sampleBytes,
  credentials: status,
  objects,
  suggestedSources,
  notices,
  problems,
  redaction: "Headers, fill rates and mappings only — no cell values are included in this report.",
};

if (asJson) {
  console.log(JSON.stringify(bundle, null, 2));
} else {
  console.log(formatSchemaReport(bundle));
}
process.exitCode = problems.length > 0 ? 1 : 0;
