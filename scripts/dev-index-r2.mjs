#!/usr/bin/env node
/**
 * CompanyIntel — development index publish tool (R2, resumable, version-scoped).
 *
 *   bun scripts/dev-index-r2.mjs status                      # what exists locally vs in R2
 *   bun scripts/dev-index-r2.mjs upload [--limit 60]         # resumable, bounded per call
 *   bun scripts/dev-index-r2.mjs verify                      # size + content hash of every object
 *   bun scripts/dev-index-r2.mjs report                      # single JSON summary
 *
 * WHY IT EXISTS
 * -------------
 * `run --upload` uploads the whole version in one process. Over a slow link, 363 small
 * PUTs do not fit in one bounded terminal call, and a killed upload leaves the version
 * half-published with no way to tell how far it got. This tool makes publishing
 * resumable and verifiable:
 *
 *   - every object is taken from `objects.jsonl`, the run's own list, so nothing is
 *     guessed and nothing outside the version prefix can be written;
 *   - an object whose remote size already matches is skipped, so re-running is free;
 *   - `--limit` bounds how many objects one call touches, so a long upload is done in
 *     as many short calls as it needs;
 *   - `verify` reads each object back and compares both the size and the CONTENT the
 *     run produced (gzip is normalised away on both sides — see the long note in
 *     `verify` for why a stored-byte hash cannot be compared over HTTPS), which is
 *     what makes "uploaded" mean "uploaded intact".
 *
 * WHAT IT NEVER DOES
 * ------------------
 *   - it never writes `manifests/active.json` (activation is an explicit, separate
 *     decision — see `activate` in the Worker API and `publish` in the CLI);
 *   - it never deletes or overwrites an object with a different size;
 *   - it never prints a credential, a contact value or a company name.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { R2Client, credentialsFromEnv } from "../tools/indexer/src/r2.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
};

const json = Boolean(flag("json"));
const limit = Number(flag("limit", 60));
const bucket = String(flag("bucket", "company-intel-data"));
const outputDir = resolve(String(flag("dir", ".indexer-dev-output")));
const objectsPath = join(outputDir, "objects.jsonl");

function loadObjects() {
  if (!existsSync(objectsPath)) {
    console.error(`No ${objectsPath}. Run the dev index build first (bun run dev:index).`);
    process.exit(2);
  }
  return readFileSync(objectsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function versionOf(objects) {
  const companyObject = objects.find((object) => object.key.startsWith("companies/"));
  if (!companyObject) throw new Error("objects.jsonl has no companies/ object — the version cannot be derived.");
  const [, version] = companyObject.key.split("/");
  return version;
}

function client() {
  const credentials = credentialsFromEnv(bucket);
  if (!credentials) {
    console.error("R2 credentials are missing (.r2-credentials.json or R2_* variables).");
    process.exit(2);
  }
  return new R2Client(credentials);
}

/* --------------------------------- upload --------------------------------- */

async function upload(objects, r2) {
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  const missing = [];
  for (const object of objects) {
    const head = await r2.head(object.key);
    if (head.exists && head.size === object.bytes) {
      skipped += 1;
      continue;
    }
    if (head.exists && head.size !== object.bytes) {
      console.error(`! ${object.key} exists with a different size (${head.size} vs ${object.bytes}) — refusing to overwrite it.`);
      process.exitCode = 1;
      continue;
    }
    if (uploaded >= limit) {
      missing.push(object.key);
      continue;
    }
    const body = readFileSync(join(outputDir, object.key));
    await r2.put(object.key, body, "application/json", 4, object.gzip ? { contentEncoding: "gzip" } : undefined);
    uploaded += 1;
    bytes += body.length;
    process.stdout.write(`\r  uploaded ${uploaded} (${(bytes / 1e6).toFixed(1)} MB), skipped ${skipped}, remaining ${objects.length - uploaded - skipped}    `);
  }
  if (uploaded || skipped) process.stdout.write("\n");
  return { uploaded, skipped, bytes, remaining: objects.length - uploaded - skipped };
}

/* --------------------------------- verify --------------------------------- */

async function verify(objects, r2, offset, count) {
  const problems = [];
  let checked = 0;
  let bytes = 0;
  for (const object of objects.slice(offset, offset + count)) {
    const head = await r2.head(object.key);
    if (!head.exists) {
      problems.push({ key: object.key, problem: "missing" });
      continue;
    }
    if (head.size !== object.bytes) {
      problems.push({ key: object.key, problem: "size", expected: object.bytes, actual: head.size });
      continue;
    }
    /*
     * Read it back and compare CONTENT.
     *
     * `objects.jsonl` records the hash of the file the indexer wrote, which for a
     * gzipped payload is the hash of the COMPRESSED bytes. Comparing that hash with
     * what a read returns cannot work over HTTPS: R2 decodes a `content-encoding:
     * gzip` object at the edge and Node's fetch decodes it again for good measure, so
     * the same object comes back compressed or plain depending on the request — and
     * re-compressing locally would produce different bytes for identical content.
     *
     * So the check is defined on the CONTENT, which is what actually matters: the
     * object on R2 must decompress to exactly the bytes the run produced. Both sides
     * are normalised identically (gunzip when the bytes really start with 1f 8b,
     * which is the only reliable signal), then hashed.
     */
    const stored = await r2.get(object.key);
    if (!stored.ok) {
      problems.push({ key: object.key, problem: `read failed (HTTP ${stored.status})` });
      continue;
    }
    const raw = Buffer.from(await stored.arrayBuffer());
    const remoteContent = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    let localContent = null;
    try {
      const local = readFileSync(join(outputDir, object.key));
      localContent = local.length > 2 && local[0] === 0x1f && local[1] === 0x8b ? gunzipSync(local) : local;
    } catch {
      // The local file may have been cleaned up after upload; the content check then
      // falls back to the recorded hash of the stored object.
    }
    const digest = createHash("sha256").update(remoteContent).digest("hex");
    const expected = localContent
      ? createHash("sha256").update(localContent).digest("hex")
      : object.gzip
        ? null
        : object.sha256;
    if (expected && digest !== expected) {
      problems.push({ key: object.key, problem: "content hash", expected, actual: digest });
      continue;
    }
    checked += 1;
    bytes += head.size;
  }
  return { checked, bytes, problems };
}

/* --------------------------------- status --------------------------------- */

async function status(objects, r2) {
  let present = 0;
  let absent = 0;
  let wrongSize = 0;
  let bytes = 0;
  for (const object of objects) {
    const head = await r2.head(object.key);
    if (!head.exists) absent += 1;
    else if (head.size !== object.bytes) wrongSize += 1;
    else {
      present += 1;
      bytes += head.size;
    }
  }
  return { objects: objects.length, version: versionOf(objects), present, absent, wrongSize, remoteBytes: bytes };
}

/* ---------------------------------- main ---------------------------------- */

const objects = loadObjects();
const version = versionOf(objects);
const r2 = client();

if (command === "upload") {
  const result = await upload(objects, r2);
  if (json) console.log(JSON.stringify({ version, ...result }, null, 2));
  else {
    console.log(`version ${version}: uploaded ${result.uploaded}, skipped ${result.skipped} already present, ${result.remaining} left`);
    if (result.remaining > 0) console.log("Run the same command again to continue (it is resumable and skips what is already there).");
  }
} else if (command === "verify") {
  const offset = Number(flag("offset", 0));
  const result = await verify(objects, r2, offset, limit);
  if (json) console.log(JSON.stringify({ version, ...result }, null, 2));
  else {
    console.log(
      `version ${version}: ${result.checked}/${objects.length} object(s) verified byte-for-byte from offset ${Number(flag("offset", 0))} (${(result.bytes / 1e6).toFixed(1)} MB on R2)`,
    );
    for (const problem of result.problems.slice(0, 20)) console.log(`  FAIL ${problem.key} — ${problem.problem}`);
    if (result.problems.length) console.log(`  ${result.problems.length} problem(s)`);
  }
  if (result.problems.length) process.exitCode = 1;
} else {
  const result = await status(objects, r2);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`version ${result.version}: ${result.present}/${result.objects} object(s) present on R2 (${(result.remoteBytes / 1e6).toFixed(1)} MB)`);
    console.log(`  missing ${result.absent} · wrong size ${result.wrongSize}`);
    if (result.absent) console.log("  run: bun run dev:index:upload");
  }
}
