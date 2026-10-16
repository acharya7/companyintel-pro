/**
 * R2 S3 client signing tests.
 *
 * These stub only the network. Everything else — canonical request construction,
 * query encoding, header signing and XML parsing — is the real code, so a
 * regression in the signing path fails here instead of at upload time with a
 * 403 in the middle of a 5-hour indexing run.
 *
 * The specific regression these cover: `content-encoding: gzip` MUST be part of
 * the signed headers, because the Worker relies on that metadata to gunzip
 * shards. Omitting it uploads fine but makes every index object unreadable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { R2Client, credentialsFromEnv } from "../tools/indexer/src/r2";
import { resetCredentialCache } from "../tools/indexer/src/credentials";

const credentials = { accountId: "acct", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", bucket: "company-intel-data" };

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let captured: Captured[] = [];
const realFetch = globalThis.fetch;

function stubFetch(response: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = String(value);
    }
    captured.push({ url: String(input), method: init?.method ?? "GET", headers });
    return response();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  captured = [];
});

describe("R2 client credentials", () => {
  test("credentials are read from the environment or the private file, and never partially", () => {
    const original = { ...process.env };
    // Point the lookup at a path that does not exist so this test is hermetic: the
    // developer's real .r2-credentials.json (if present) must not leak into it.
    process.env.COMPANYINTEL_R2_CREDENTIALS = join(tmpdir(), "companyintel-no-such-credentials.json");
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.R2_ENDPOINT_URL;
    delete process.env.R2_BUCKET_NAME;
    resetCredentialCache();
    expect(credentialsFromEnv("company-intel-data")).toBeNull();

    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    // Missing secret ⇒ no credentials, and an incomplete environment is refused
    // rather than silently falling back to the private file.
    expect(() => credentialsFromEnv()).toThrow(/Incomplete R2 environment credentials/);
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    expect(credentialsFromEnv("company-intel-data")?.bucket).toBe("company-intel-data");
    expect(credentialsFromEnv("company-intel-data")?.secretAccessKey).toBe("secret");

    process.env = original;
    resetCredentialCache();
  });
});

describe("R2 client signing", () => {
  test("PUT signs the gzip content-encoding header", async () => {
    stubFetch(() => new Response("", { status: 200, headers: { etag: '"e1"' } }));
    const client = new R2Client(credentials);
    const result = await client.put(
      "indexes/v1/exact/0000.json.gz",
      Buffer.from("{}"),
      "application/json",
      1,
      { contentEncoding: "gzip" },
    );

    expect(result.attempts).toBe(1);
    const request = captured[0];
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://acct.r2.cloudflarestorage.com/company-intel-data/indexes/v1/exact/0000.json.gz");
    expect(request.headers["content-encoding"]).toBe("gzip");
    // Signing is only valid if the header is listed in SignedHeaders.
    expect(request.headers.authorization).toContain("content-encoding");
    expect(request.headers.authorization).toContain("Credential=AKIDEXAMPLE/");
    expect(request.headers["x-amz-content-sha256"]).toHaveLength(64);
  });

  test("PUT omits content-encoding when the object is not compressed", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    const client = new R2Client(credentials);
    await client.put("manifests/v1/manifest.json", Buffer.from("{}"), "application/json", 1);
    expect(captured[0].headers["content-encoding"]).toBeUndefined();
    expect(captured[0].headers.authorization).not.toContain("content-encoding");
  });

  test("retries on 5xx and reports the attempt count", async () => {
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      return attempt < 3 ? new Response("boom", { status: 500 }) : new Response("", { status: 200 });
    });
    const client = new R2Client(credentials);
    const result = await client.put("indexes/v1/token/0001.json.gz", Buffer.from("{}"), "application/json", 3);
    expect(result.attempts).toBe(3);
    expect(captured).toHaveLength(3);
  });

  test("a 4xx (other than 429) is not retried", async () => {
    stubFetch(() => new Response("denied", { status: 403 }));
    const client = new R2Client(credentials);
    await expect(client.put("manifests/v1/manifest.json", Buffer.from("{}"), "application/json", 4)).rejects.toThrow(
      /HTTP 403/,
    );
    expect(captured).toHaveLength(1);
  });

  test("list() signs ListObjectsV2 parameters and parses the XML", async () => {
    stubFetch(
      () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>
            <Contents><Key>raw/part1.csv</Key><Size>10737418240</Size><LastModified>2026-09-01T10:00:00.000Z</LastModified></Contents>
            <Contents><Key>raw/part2.csv</Key><Size>53687091200</Size><LastModified>2026-09-02T11:30:00.000Z</LastModified></Contents>
          </ListBucketResult>`,
          { status: 200 },
        ),
    );
    const client = new R2Client(credentials);
    const objects = await client.list("raw/", 25);

    expect(objects).toEqual([
      { key: "raw/part1.csv", size: 10737418240, lastModified: "2026-09-01T10:00:00.000Z" },
      { key: "raw/part2.csv", size: 53687091200, lastModified: "2026-09-02T11:30:00.000Z" },
    ]);
    const url = captured[0].url;
    expect(url).toContain("https://acct.r2.cloudflarestorage.com/company-intel-data?");
    expect(url).toContain("list-type=2");
    expect(url).toContain("prefix=raw%2F");
    expect(url).toContain("max-keys=25");
  });

  test("a failed list reports the status instead of an empty result", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    const client = new R2Client(credentials);
    await expect(client.list("raw/")).rejects.toThrow(/HTTP 403/);
  });

  test("getRange() signs a byte range and returns exactly those bytes", async () => {
    stubFetch(() => new Response("Company Name,Website\nAcme, Inc.,https://acme.example\n", { status: 206 }));
    const client = new R2Client(credentials);
    const bytes = await client.getRange("raw/part1.csv", 512, 0);
    expect(captured[0].headers.range).toBe("bytes=0-511");
    expect(captured[0].headers.authorization).toContain("range");
    expect(bytes.toString("utf8")).toContain("Company Name");
  });

  test("head() reports absence without throwing", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    const client = new R2Client(credentials);
    expect(await client.head("raw/missing.csv")).toEqual({ exists: false, size: null, etag: null });
  });
});
