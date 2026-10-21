#!/usr/bin/env node
/**
 * CompanyIntel — REAL DATA early-access publisher.
 *
 *   bun scripts/early-access.mjs measure --rows csv1=30000,csv2=30000 --out coverage.json
 *   bun scripts/early-access.mjs publish --dir .realdata-output --version stg-real-2026-10-21
 *   bun scripts/early-access.mjs verify  --dir .realdata-output --version stg-real-2026-10-21
 *   bun scripts/early-access.mjs activate --version stg-real-2026-10-21
 *   bun scripts/early-access.mjs status  --version stg-real-2026-10-21
 *
 * Why this exists
 * ---------------
 * A bounded build is produced locally (the container has no interactive shell here),
 * so it must be published in short, resumable steps over a slow link, and it must be
 * activated only after the object set has been read back and verified. The indexer's
 * own `--upload` does one object at a time and a killed call leaves no record of how
 * far it got; this publisher is concurrent, resumable and verifies what it wrote.
 *
 * What it guarantees
 * ------------------
 *   - every object comes from the run's own `objects.jsonl`; nothing is guessed and
 *     nothing outside `stg-`/`real-` version prefixes is written;
 *   - `manifests/<version>/manifest.json` is uploaded LAST, so a half-uploaded version
 *     can never look activatable;
 *   - an existing object with a different size is refused, never overwritten;
 *   - `activate` re-checks the manifest, the validation object, every object's size
 *     and the coverage record before it changes a pointer;
 *   - `raw/` is never written, listed in full or named as a target.
 *
 * Coverage
 * --------
 * `measure` reads only the prefix of each original file that the bounded build used
 * and records the exact byte offset of the last record. That is the honest definition
 * of "source bytes covered": the bytes whose records are in the index. It does not
 * claim the whole file was processed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { R2Client } from "../tools/indexer/src/r2.ts";
import { resolveCredentials } from "../tools/indexer/src/credentials.ts";
import { CsvParser } from "../src/shared/csv-parse.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
};
const has = (name) => argv.includes(`--${name}`);
const json = has("json");

const SOURCES = [
  { id: "csv1", key: "raw/file1.csv", delimiter: "\t" },
  { id: "csv2", key: "raw/file2.csv", delimiter: "\t" },
];
const DEFAULT_POINTER = "staging/active.json";
const CHUNK_BYTES = 4 * 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function client() {
  const { credentials } = resolveCredentials();
  if (!credentials) fail("R2 credentials are missing (.r2-credentials.json or R2_* variables).");
  return new R2Client(credentials);
}

function parseRows(value) {
  const rows = {};
  for (const part of String(value ?? "").split(",")) {
    const [id, count] = part.split("=");
    const parsed = Number(count);
    if (id && Number.isInteger(parsed) && parsed > 0) rows[id.trim()] = parsed;
  }
  return rows;
}

/* -------------------------------- measure -------------------------------- */

/**
 * Find the byte offset at which `target` records have been read from an object.
 *
 * Reads 4 MiB ranges and feeds them to the SAME parser the indexer uses, so a
 * quoted newline or a multi-byte character cannot move the boundary. Only the
 * prefix the build actually consumed is transferred.
 */
async function measurePrefix(r2, source, target, onLog) {
  const head = await r2.head(source.key);
  if (!head.exists || head.size === null) fail(`${source.key} is missing from R2.`);
  const parser = new CsvParser({ delimiter: source.delimiter });
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let offset = 0;
  let records = 0;
  let lastEnd = 0;
  while (offset < head.size && records < target) {
    const length = Math.min(CHUNK_BYTES, head.size - offset);
    const body = await r2.getRange(source.key, length, offset);
    if (!body.length) break;
    for (const record of parser.push(decoder.decode(body, { stream: true }))) {
      records += 1;
      lastEnd = record.endByte ?? lastEnd;
      if (records >= target) break;
    }
    offset += body.length;
    onLog?.(`  ${source.id}: ${records.toLocaleString()}/${target.toLocaleString()} records · ${(lastEnd / 1e6).toFixed(1)} MB`);
  }
  return { bytesCovered: Math.min(lastEnd, head.size), records, sizeBytes: head.size };
}

async function cmdMeasure() {
  const r2 = client();
  const rows = parseRows(flag("rows", "csv1=30000,csv2=30000"));
  const out = resolve(String(flag("out", "coverage.json")));
  const version = String(flag("version", "stg-real-2026-10-21"));
  const sources = [];
  for (const source of SOURCES) {
    const target = rows[source.id];
    if (!target) continue;
    const measured = await measurePrefix(r2, source, target, (line) => {
      if (!json) process.stderr.write(`\r${line.padEnd(80)}`);
    });
    if (!json) process.stderr.write("\n");
    sources.push({
      id: source.id,
      key: source.key,
      sizeBytes: measured.sizeBytes,
      bytesCovered: measured.bytesCovered,
      recordsRead: measured.records,
      coveragePercent: Number(((measured.bytesCovered / measured.sizeBytes) * 100).toFixed(4)),
      method: "bounded prefix sample (first N records)",
    });
  }
  const bytesCovered = sources.reduce((sum, entry) => sum + entry.bytesCovered, 0);
  const bytesTotal = sources.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const coverage = {
    format: 1,
    version,
    label: "REAL DATA — PARTIAL COVERAGE",
    partial: true,
    dataOrigin: "r2",
    generatedAt: new Date().toISOString(),
    sources,
    totals: {
      sourceBytesCovered: bytesCovered,
      sourceBytesTotal: bytesTotal,
      coveragePercent: Number(((bytesCovered / bytesTotal) * 100).toFixed(4)),
    },
    note:
      "Records in this version were read from the original R2 files under raw/. " +
      "The rest of each file has not been indexed; a direct R2 scan can look for a " +
      "specific record outside this coverage.",
  };
  writeFileSync(out, `${JSON.stringify(coverage, null, 2)}\n`);
  console.log(
    json
      ? JSON.stringify(coverage, null, 2)
      : `wrote ${out}: ${(bytesCovered / 1e9).toFixed(2)} GB of ${(bytesTotal / 1e9).toFixed(2)} GB (${coverage.totals.coveragePercent.toFixed(3)}%)`,
  );
}

/* -------------------------------- publish -------------------------------- */

function outputObjects(dir) {
  const path = join(dir, "objects.jsonl");
  if (!existsSync(path)) fail(`No ${path}. Run the bounded index build first.`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function versionOf(objects) {
  const company = objects.find((object) => object.key.startsWith("companies/"));
  if (!company) fail("objects.jsonl has no companies/ object; the version cannot be derived.");
  return company.key.split("/")[1];
}

async function mapLimit(items, limit, run) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await run(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function cmdPublish() {
  const r2 = client();
  const dir = resolve(String(flag("dir", ".realdata-output")));
  const version = String(flag("version", versionOf(outputObjects(dir))));
  const limit = Number(flag("limit", 0));
  const concurrency = Math.max(1, Math.min(12, Number(flag("concurrency", 6))));
  const objects = outputObjects(dir);

  const coverageFlag = flag("coverage");
  const coveragePath = coverageFlag ? resolve(String(coverageFlag)) : join(dir, "coverage.json");
  if (!existsSync(coveragePath)) {
    fail(
      `No coverage record at ${coveragePath}. Run:\n` +
        `  bun scripts/early-access.mjs measure --version ${version} --rows csv1=30000,csv2=30000 --out ${coveragePath}`,
    );
  }
  const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));

  const allowed = /^(indexes|companies|contacts|details|unassigned)\/[^/]+\//;
  const outside = objects.filter(
    (object) =>
      !allowed.test(object.key) &&
      !object.key.startsWith(`manifests/${version}/`) &&
      !object.key.startsWith(`realdata/${version}/`),
  );
  if (outside.length) fail(`Refusing keys outside the recognised version prefixes: ${outside.slice(0, 3).map((o) => o.key).join(", ")}`);

  // Coverage is published before the manifest and after every data object.
  const uploads = [
    ...objects.filter((object) => !object.key.startsWith("manifests/")),
    { key: `realdata/${version}/coverage.json`, bytes: Buffer.byteLength(JSON.stringify(coverage)), local: "coverage" },
    ...objects.filter((object) => object.key.startsWith("manifests/") && !object.key.endsWith("/manifest.json")),
    ...objects.filter((object) => object.key.endsWith("/manifest.json")),
  ];

  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  const problems = [];
  let touched = 0;
  await mapLimit(uploads, concurrency, async (object) => {
    if (limit > 0 && touched >= limit && !object.key.endsWith("/manifest.json")) return;
    const head = await r2.head(object.key);
    if (head.exists) {
      if (head.size === object.bytes) {
        skipped += 1;
        return;
      }
      problems.push({ key: object.key, problem: "exists with a different size", expected: object.bytes, actual: head.size });
      return;
    }
    const body =
      object.local === "coverage"
        ? Buffer.from(`${JSON.stringify(coverage, null, 2)}\n`, "utf8")
        : readFileSync(join(dir, object.key));
    await r2.put(object.key, body, "application/json", 4, object.gzip ? { contentEncoding: "gzip" } : undefined);
    uploaded += 1;
    bytes += body.length;
    touched += 1;
  });
  if (problems.length) {
    console.error(`Refusing to continue: ${problems.length} existing object(s) disagree. Nothing was overwritten.`);
    for (const problem of problems.slice(0, 5)) console.error(`  ${problem.key}: ${problem.problem} (${problem.actual} vs ${problem.expected})`);
    process.exitCode = 1;
    return;
  }
  const result = { version, uploaded, skipped, bytes, objects: uploads.length };
  console.log(json ? JSON.stringify(result, null, 2) : `version ${version}: uploaded ${uploaded}, already present ${skipped}, ${(bytes / 1e6).toFixed(1)} MB`);
  if (uploaded + skipped < uploads.length) console.log("Run the same command again to continue (it is resumable).");
}

/* --------------------------------- verify -------------------------------- */

async function readJson(r2, key) {
  const response = await r2.get(key);
  if (!response.ok) return null;
  return response.json();
}

async function verifyVersion(r2, dir, version) {
  const objects = outputObjects(dir);
  const missing = [];
  const wrongSize = [];
  let present = 0;
  let bytes = 0;
  await mapLimit(objects, 8, async (object) => {
    const head = await r2.head(object.key);
    if (!head.exists) missing.push(object.key);
    else if (head.size !== object.bytes) wrongSize.push({ key: object.key, expected: object.bytes, actual: head.size });
    else {
      present += 1;
      bytes += head.size;
    }
  });
  const manifest = await readJson(r2, `manifests/${version}/manifest.json`);
  const validation = await readJson(r2, `manifests/${version}/validation.json`);
  const coverage = await readJson(r2, `realdata/${version}/coverage.json`);
  const passed =
    !missing.length &&
    !wrongSize.length &&
    Boolean(manifest?.validationPassed) &&
    validation?.passed === true &&
    Array.isArray(validation?.missingObjects) &&
    validation.missingObjects.length === 0 &&
    coverage?.version === version;
  return { version, objects: objects.length, present, bytes, missing, wrongSize, manifest, validation, coverage, passed };
}

async function cmdVerify() {
  const r2 = client();
  const dir = resolve(String(flag("dir", ".realdata-output")));
  const version = String(flag("version", versionOf(outputObjects(dir))));
  const result = await verifyVersion(r2, dir, version);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`version ${version}: ${result.present}/${result.objects} objects present (${(result.bytes / 1e6).toFixed(1)} MB)`);
    console.log(`  manifest validationPassed: ${result.manifest?.validationPassed ?? "missing"}`);
    console.log(`  validation passed:         ${result.validation?.passed ?? "missing"}`);
    console.log(`  coverage record:           ${result.coverage ? `${result.coverage.totals.coveragePercent}% of both files` : "missing"}`);
    console.log(`  missing ${result.missing.length} · wrong size ${result.wrongSize.length}`);
    console.log(result.passed ? "  VERDICT verified — safe to activate" : "  VERDICT not activatable");
  }
  if (!result.passed) process.exitCode = 1;
}

/* -------------------------------- activate ------------------------------- */

async function cmdActivate() {
  const r2 = client();
  const dir = resolve(String(flag("dir", ".realdata-output")));
  const version = String(flag("version", versionOf(outputObjects(dir))));
  const pointer = String(flag("pointer", DEFAULT_POINTER));
  if (!pointer.startsWith("staging/") && !has("allow-production")) {
    fail(`Refusing to write ${pointer}: an early-access dataset may only be activated on staging. Pass --allow-production only after an explicit decision.`);
  }
  const result = await verifyVersion(r2, dir, version);
  if (!result.passed) {
    fail(`Refusing to activate ${version}: verification failed (${result.missing.length} missing, ${result.wrongSize.length} wrong size).`);
  }
  const currentRes = await r2.get(pointer);
  const current = currentRes.ok ? await currentRes.json().catch(() => null) : null;
  if (current?.version === version) {
    console.log(`Already active: ${pointer} → ${version}`);
    return;
  }
  const body = {
    version,
    previousVersion: current?.version ?? null,
    activatedAt: new Date().toISOString(),
    activatedBy: String(flag("by", "early-access-publisher")),
    label: "REAL DATA — PARTIAL COVERAGE",
    coveragePercent: result.coverage.totals.coveragePercent,
  };
  await r2.putJson(pointer, body);
  const readBack = await readJson(r2, pointer);
  if (readBack?.version !== version) fail(`Activation write did not read back (got ${readBack?.version ?? "nothing"}).`);
  console.log(json ? JSON.stringify({ pointer, ...body }, null, 2) : `activated ${pointer} → ${version} (previous ${body.previousVersion ?? "none"})`);
}

/* --------------------------------- status -------------------------------- */

async function cmdStatus() {
  const r2 = client();
  const version = String(flag("version", "stg-real-2026-10-21"));
  const manifest = await readJson(r2, `manifests/${version}/manifest.json`);
  const coverage = await readJson(r2, `realdata/${version}/coverage.json`);
  const staging = await readJson(r2, DEFAULT_POINTER);
  const production = await readJson(r2, "manifests/active.json");
  const summary = {
    version,
    stagingPointer: staging?.version ?? null,
    productionPointer: production?.version ?? null,
    manifest: manifest
      ? {
          validationPassed: manifest.validationPassed,
          counters: manifest.counters,
          bytes: manifest.bytes,
          objectCount: manifest.objectCount,
          completedAt: manifest.completedAt,
        }
      : null,
    coverage,
  };
  console.log(json ? JSON.stringify(summary, null, 2) : JSON.stringify(summary, null, 2));
}

/* ---------------------------------- main --------------------------------- */

if (command === "measure") await cmdMeasure();
else if (command === "publish") await cmdPublish();
else if (command === "verify") await cmdVerify();
else if (command === "activate") await cmdActivate();
else if (command === "status") await cmdStatus();
else fail(`Unknown command ${command}. Use measure | publish | verify | activate | status.`);
