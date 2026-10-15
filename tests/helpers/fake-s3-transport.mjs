/**
 * Stub S3/R2 transport for tests.
 *
 * Loaded with `bun --preload` before a verification script, it replaces
 * `globalThis.fetch` with an in-memory object store that speaks the small subset
 * of the S3 API those scripts use (ListObjectsV2, HEAD, ranged GET, PUT/DELETE
 * refusal) and records every request to `FAKE_S3_LOG`.
 *
 * This lets a test prove how the SCRIPT behaves — bounded listing, bounded read,
 * exit codes, no writes, no credential leakage — without claiming anything about
 * the real bucket, which stays unverified until it is actually read.
 *
 * Scenario is chosen with `FAKE_S3_SCENARIO`:
 *   default        both source CSVs present, a published dataset, 33 objects
 *   small          only two CSVs and one small non-CSV object under raw/
 *   missing-source raw/companies_part1.csv is absent
 *   denied         every request fails with 403 (bad/insufficient credentials)
 */

import { writeFileSync } from "node:fs";

const BUCKET = "company-intel-data";
const scenario = process.env.FAKE_S3_SCENARIO ?? "default";

const objects = [
  { key: "raw/companies_part2.csv", size: 50_000_000_000, lastModified: "2026-09-12T10:00:00.000Z" },
  { key: "raw/companies_part1.csv", size: 10_000_000_000, lastModified: "2026-09-12T09:00:00.000Z" },
  { key: "raw/notes.txt", size: 512, lastModified: "2026-09-10T08:00:00.000Z" },
  ...Array.from({ length: 30 }, (_, index) => ({
    key: `raw/incremental_${String(index).padStart(2, "0")}.csv`,
    size: 1_000 + index,
    lastModified: "2026-09-01T00:00:00.000Z",
  })),
]
  .filter((object) => !(scenario === "missing-source" && object.key === "raw/companies_part1.csv"))
  .filter((_, index) => scenario !== "small" || index < 3);

const jsonObjects = {
  "manifests/active.json": {
    version: "v1",
    publishedAt: "2026-09-20T12:00:00.000Z",
    previousVersion: "v0-staging",
  },
  "manifests/v1/manifest.json": {
    counters: {
      uniqueCompanies: 1_234_567,
      uniqueContacts: 2_345_678,
      rowsRejected: 42,
      perSource: { csv1: { rowsRead: 1000 }, csv2: { rowsRead: 2000 } },
    },
  },
  "manifests/v1/validation.json": { passed: true },
  "indexes/v1/directory.json": {
    shards: { exact: 512, prefix: 256, token: 256, trigram: 512, ids: 256 },
    bytes: { total: 12_345_678_901 },
  },
};

const requests = [];

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url));
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = init.headers ?? {};
  const range = headers.range ?? headers.Range ?? null;
  requests.push({
    method,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    range,
    authPresent: Boolean(headers.authorization),
  });

  if (scenario === "denied") {
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  }
  // A verification or profiling run must never write: fail loudly if it tries.
  if (method !== "GET" && method !== "HEAD") {
    return new Response("<Error><Code>MethodNotAllowed</Code></Error>", { status: 405 });
  }

  if (parsed.searchParams.get("list-type") === "2") {
    const prefix = parsed.searchParams.get("prefix") ?? "";
    const maxKeys = Number(parsed.searchParams.get("max-keys") ?? 1000);
    const matched = objects.filter((object) => object.key.startsWith(prefix));
    const page = matched.slice(0, maxKeys);
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
      page
        .map(
          (object) =>
            `<Contents><Key>${object.key}</Key><LastModified>${object.lastModified}</LastModified><Size>${object.size}</Size></Contents>`,
        )
        .join("") +
      `<IsTruncated>${page.length < matched.length}</IsTruncated></ListBucketResult>`;
    return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
  }

  const key = decodeURIComponent(parsed.pathname.replace(new RegExp(`^/${BUCKET}/`), ""));
  const object = objects.find((candidate) => candidate.key === key);

  if (method === "HEAD") {
    return object
      ? new Response(null, {
          status: 200,
          headers: { "content-length": String(object.size), etag: '"stub-etag-1"' },
        })
      : new Response(null, { status: 404 });
  }

  if (jsonObjects[key]) {
    return new Response(JSON.stringify(jsonObjects[key]), { status: 200 });
  }
  if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });

  // Ranged GET: return at most what was asked for, never the whole 50 GB object.
  if (range) {
    const match = /bytes=(\d+)-(\d+)/.exec(String(range));
    const offset = match ? Number(match[1]) : 0;
    const last = match ? Number(match[2]) : offset + 1023;
    const length = Math.max(1, Math.min(last - offset + 1, 1024));
    return new Response(Buffer.alloc(length, 0x41), {
      status: 206,
      headers: { "content-range": `bytes ${offset}-${offset + length - 1}/${object.size}` },
    });
  }
  return new Response(Buffer.alloc(1024, 0x41), { status: 200 });
};

const logPath = process.env.FAKE_S3_LOG;
if (logPath) {
  process.on("exit", () => {
    try {
      writeFileSync(logPath, JSON.stringify(requests, null, 2), "utf8");
    } catch {
      // A missing log only affects the test's assertions, never the script.
    }
  });
}
