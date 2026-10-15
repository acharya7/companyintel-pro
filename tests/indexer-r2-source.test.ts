/**
 * Indexer MODE B — streaming a source object straight out of R2.
 *
 * The network is stubbed (global `fetch`) but everything else is the real code
 * path: SigV4 signing, ranged requests, the shared CSV parser, the profiler and
 * the on-disk cache. That makes these assertions meaningful without credentials:
 *
 *   - a whole object streams through in bounded chunks and parses identically to
 *     reading the same bytes from a local file (Mode A/Mode B parity);
 *   - every request is a bounded range read, never a whole-object GET;
 *   - the local cache is written once and reused on the next run (resume), and an
 *     incomplete download never leaves a cache file that looks complete;
 *   - a missing object, a refused request and a missing credential each fail with
 *     an actionable message instead of silently indexing nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { profileCsvFile } from "../tools/indexer/src/csv";
import {
  cachePathFor,
  createSourceContext,
  credentialsHelp,
  missingCredentialBuckets,
  parseR2Source,
  sourceBytes,
  sourceProfile,
  sourceRecords,
  type SourceContext,
} from "../tools/indexer/src/source";

/* -------------------------------------------------------------------------- */
/* Stub S3 transport                                                          */
/* -------------------------------------------------------------------------- */

const BUCKET = "company-intel-data";
const objectText = [
  "organization,domain,Email,Notes",
  '"Acme, Inc.",acme.example,ada@acme.example,"line one',
  'line two"',
  "Beta Ltd,beta.example,alan@beta.example,café — ünïcode",
  "Gamma LLC,gamma.example,grace@gamma.example,plain",
].join("\n");
const objectBytes = Buffer.from(objectText, "utf8");
/** Body the stub serves; some tests swap in a larger object. */
let served = objectBytes;

interface Request {
  method: string;
  key: string;
  range: string | null;
}

let requests: Request[] = [];
let servedBytes = 0;
let scenario: "ok" | "missing" | "denied" | "short-read" = "ok";
const realFetch = globalThis.fetch;

function stubTransport(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.range ?? headers.Range ?? null;
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/`), ""));
    requests.push({ method, key, range });

    if (scenario === "denied") return new Response("<Error>AccessDenied</Error>", { status: 403 });
    if (scenario === "missing") return new Response("<Error>NoSuchKey</Error>", { status: 404 });

    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(served.length), etag: '"stub"' } });
    }

    const match = /bytes=(\d+)-(\d+)/.exec(String(range ?? ""));
    if (!match) {
      // A whole-object GET would be a bug: the indexer must always bound its reads.
      return new Response(served, { status: 200 });
    }
    const offset = Number(match[1]);
    const last = Number(match[2]);
    const slice = served.subarray(offset, Math.min(last + 1, served.length));
    servedBytes += slice.length;
    return new Response(new Uint8Array(slice), { status: 206, headers: { "content-range": `bytes ${offset}-${offset + slice.length - 1}/${served.length}` } });
  }) as typeof fetch;
}

const credentials = { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucket: BUCKET };

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return createSourceContext({
    cacheDir: null,
    credentialsFor: () => credentials,
    attempts: 1,
    ...overrides,
  });
}

const source = { id: "csv1", path: `r2://${BUCKET}/raw/companies_part1.csv` };

beforeEach(() => {
  requests = [];
  servedBytes = 0;
  scenario = "ok";
  stubTransport();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function collect(generator: AsyncGenerator<{ fields: string[]; line: number }>) {
  const records: { fields: string[]; line: number }[] = [];
  for await (const record of generator) records.push(record);
  return records;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("source paths", () => {
  test("r2:// is parsed and a traversal attempt is refused", () => {
    expect(parseR2Source(`r2://${BUCKET}/raw/a.csv`)).toEqual({ bucket: BUCKET, key: "raw/a.csv" });
    expect(parseR2Source("/home/me/a.csv")).toBeNull();
    expect(() => parseR2Source("r2://bucket")).toThrow(/Expected r2:\/\/<bucket>\/<key>/);
    expect(() => parseR2Source("r2://bucket/../../etc/passwd")).toThrow(/Invalid R2 source key/);
  });

  test("Mode B without credentials names the bucket and explains why", () => {
    const noCreds = createSourceContext({ cacheDir: null, credentialsFor: () => null });
    expect(missingCredentialBuckets([source], noCreds)).toEqual([BUCKET]);
    const help = credentialsHelp([BUCKET]);
    expect(help).toContain("Object Read");
    expect(help).toContain("company-intel-data");
    expect(help).toContain("Wrangler's login");
    expect(help).toContain("R2_SECRET_ACCESS_KEY");
  });
});

describe("Mode B streaming", () => {
  test("the object size comes from a bounded HEAD", async () => {
    expect(await sourceBytes(source, context())).toBe(objectBytes.length);
    expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
  });

  test("a chunk smaller than the object is read in bounded ranges", async () => {
    const chunk = 1024;
    const records = await collect(sourceRecords(source, { delimiter: "," }, context({ chunkBytes: chunk })));
    expect(records.map((record) => record.fields[0])).toEqual(["organization", "Acme, Inc.", "Beta Ltd", "Gamma LLC"]);
    // Quoted multiline field survived the chunk boundary, and the unicode row too.
    expect(records[1].fields[3]).toBe("line one\nline two");
    expect(records[2].fields[3]).toBe("café — ünïcode");

    const ranges = requests.filter((request) => request.range);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    for (const request of ranges) {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(String(request.range))!;
      expect(Number(to) - Number(from) + 1).toBeLessThanOrEqual(chunk);
    }
    // The full object was read (that is the point of indexing), but never in one
    // unbounded request.
    expect(servedBytes).toBe(objectBytes.length);
    expect(requests.every((request) => request.method === "HEAD" || request.range !== null)).toBe(true);
  });

  test("Mode B parses exactly what Mode A parses for the same bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-modeb-"));
    const path = join(dir, "source.csv");
    await writeFile(path, objectBytes);
    try {
      const modeA = await collect(sourceRecords({ id: "local", path }, { delimiter: "," }, context()));
      const modeB = await collect(sourceRecords(source, { delimiter: "," }, context({ chunkBytes: 700 })));
      expect(modeB).toEqual(modeA);

      const fromFile = await profileCsvFile(path, { delimiter: ",", sampleRows: 500 });
      const fromR2 = await sourceProfile(source, { delimiter: ",", sampleRows: 500, sampleBytes: 1024 * 1024 }, context({ chunkBytes: 700 }));
      expect(fromR2.headers).toEqual(fromFile.headers);
      expect(fromR2.sampledRows).toBe(fromFile.sampledRows);
      expect(fromR2.columns.map((column) => [column.header, column.looksLike, column.nonEmptyCount])).toEqual(
        fromFile.columns.map((column) => [column.header, column.looksLike, column.nonEmptyCount]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("profiling reads one bounded sample, not the whole object", async () => {
    const big = Buffer.concat([objectBytes, Buffer.from("\nrow,pad,pad,pad".repeat(4000), "utf8")]);
    served = big;
    try {
      const profile = await sourceProfile(source, { delimiter: ",", sampleRows: 500, sampleBytes: 2048 }, context({ chunkBytes: 1024 }));
      expect(profile.headers).toEqual(["organization", "domain", "Email", "Notes"]);
      expect(servedBytes).toBeLessThanOrEqual(2048);
      expect(servedBytes).toBeLessThan(big.length);
    } finally {
      served = objectBytes;
    }
  });

  test("a full read is cached whole, with no leftover .part file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-modeb-cache-"));
    try {
      const target = cachePathFor(context({ cacheDir: dir }), BUCKET, "raw/companies_part1.csv")!;
      const records = await collect(sourceRecords(source, { delimiter: "," }, context({ cacheDir: dir, chunkBytes: 4096 })));
      expect(records).toHaveLength(4);
      expect(existsSync(target)).toBe(true);
      expect(await readFile(target)).toEqual(objectBytes);
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Mode B cache and resume", () => {
  test("the second run reads the cache and makes no range request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-modeb-resume-"));
    try {
      const ctx = context({ cacheDir: dir, chunkBytes: 512 });
      const first = await collect(sourceRecords(source, { delimiter: "," }, ctx));
      expect(first).toHaveLength(4);
      const firstRangeRequests = requests.filter((request) => request.range).length;
      expect(firstRangeRequests).toBeGreaterThanOrEqual(1);

      requests = [];
      servedBytes = 0;
      const second = await collect(sourceRecords(source, { delimiter: "," }, ctx));
      expect(second).toEqual(first);
      expect(requests.filter((request) => request.range)).toHaveLength(0);
      expect(servedBytes).toBe(0);
      expect(requests.some((request) => request.method === "HEAD")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an incomplete download never becomes a cache hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-modeb-partial-"));
    try {
      const ctx = context({ cacheDir: dir, chunkBytes: 4096 });
      const target = cachePathFor(ctx, BUCKET, "raw/companies_part1.csv")!;
      // A leftover cache file that is not byte-complete must be re-downloaded.
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, objectBytes.subarray(0, 20));
      requests = [];
      const records = await collect(sourceRecords(source, { delimiter: "," }, ctx));
      expect(records).toHaveLength(4);
      expect(requests.filter((request) => request.range).length).toBeGreaterThan(0);
      expect(await readFile(target)).toEqual(objectBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a sample run stops early and does not leave a cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-modeb-sample-"));
    try {
      const ctx = context({ cacheDir: dir, chunkBytes: 4096 });
      const target = cachePathFor(ctx, BUCKET, "raw/companies_part1.csv")!;
      const records = await collect(sourceRecords(source, { delimiter: ",", maxRecords: 2 }, ctx));
      expect(records).toHaveLength(2);
      // The header plus one row is not the whole object, so nothing is cached.
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Mode B failure modes", () => {
  test("a missing object names the key and fails the run", async () => {
    scenario = "missing";
    await expect(collect(sourceRecords(source, { delimiter: "," }, context()))).rejects.toThrow(/does not exist/);
  });

  test("refused credentials surface as an HTTP status, not as empty data", async () => {
    scenario = "denied";
    await expect(collect(sourceRecords(source, { delimiter: "," }, context()))).rejects.toThrow(/HTTP 403/);
  });

  test("credentials are demanded before anything is read", async () => {
    const noCreds = createSourceContext({ cacheDir: null, credentialsFor: () => null });
    await expect(collect(sourceRecords(source, { delimiter: "," }, noCreds))).rejects.toThrow(/Object Read/);
    expect(requests).toHaveLength(0);
  });
});
