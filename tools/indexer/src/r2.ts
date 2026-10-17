/**
 * Minimal R2 upload client (S3-compatible API, AWS Signature v4).
 *
 * Only the indexer runs outside Cloudflare, and it is the only component that
 * needs write access to the bucket, so signing lives here rather than in the
 * Worker (the Worker uses the R2 binding and never sees S3 credentials).
 * * Credentials are resolved by `./credentials` — this process's environment
 * first, then the private, git-ignored local file (`.r2-credentials.json`) — and
 * are never written to disk or printed:
 *
 *   R2_ACCESS_KEY_ID     R2 access key id
 *   R2_SECRET_ACCESS_KEY R2 secret access key
 *   R2_ACCOUNT_ID        your Cloudflare account id (or R2_ENDPOINT_URL)
 *
 * If you would rather not create R2 API tokens at all, run
 * `rclone copy <outputDir> r2:<bucket>` instead — the layout is identical and
 * `--upload` simply skips this module.
 */

import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import { DEFAULT_REGION, credentialsFromEnv, endpointFor, type R2Credentials } from "./credentials";

export type { R2Credentials };
export { credentialsFromEnv };

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding, as SigV4 requires for canonical query parameters. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface PutResult {
  key: string;
  bytes: number;
  etag: string | null;
  attempts: number;
}

export class R2Client {
  private readonly credentials: R2Credentials;
  private readonly endpoint: string;

  constructor(credentials: R2Credentials) {
    this.credentials = credentials;
    // `endpointFor` prefers an explicitly configured R2_ENDPOINT_URL and falls back
    // to the canonical https://<account-id>.r2.cloudflarestorage.com.
    this.endpoint = endpointFor(credentials).replace(/\/+$/, "");
  }

  /**
   * Sign and send one S3 request.
   *
   * Every header here is part of the SigV4 canonical request, which is why
   * `content-encoding` must be passed through this function rather than added
   * afterwards: the Worker decides whether to gunzip a shard from that metadata,
   * so an unsigned/omitted encoding would make every index object unreadable in
   * production even though the upload itself succeeded.
   */
  private async sign(
    method: "PUT" | "HEAD" | "GET",
    key: string,
    body?: Buffer,
    contentType?: string,
    extra?: {
      contentEncoding?: string;
      contentDisposition?: string;
      range?: string;
      /** Extra query parameters, e.g. a ListObjectsV2 request. */
      query?: Record<string, string>;
      /** Signs the bucket root instead of an object key. */
      bucketRoot?: boolean;
    },
  ): Promise<Response> {
    const { accessKeyId, secretAccessKey, bucket } = this.credentials;
    const host = new URL(this.endpoint).host;
    const canonicalUri = extra?.bucketRoot ? `/${bucket}` : `/${bucket}/${encodeKeyPath(key)}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;
    if (extra?.contentEncoding) headers["content-encoding"] = extra.contentEncoding;
    if (extra?.contentDisposition) headers["content-disposition"] = extra.contentDisposition;
    if (extra?.range) headers.range = extra.range;

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name]}\n`)
      .join("");
    const canonicalQuery = Object.entries(extra?.query ?? {})
      .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${this.credentials.region ?? DEFAULT_REGION}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), this.credentials.region ?? DEFAULT_REGION), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const queryString = canonicalQuery ? `?${canonicalQuery}` : "";

    return fetch(`${this.endpoint}${canonicalUri}${queryString}`, {
      method,
      // `identity` keeps the transport honest: Node's fetch transparently gunzips a
      // response that carries `content-encoding: gzip`, yet leaves the header in
      // place. A reader that trusts that header (the Worker decides whether to
      // gunzip an index shard from it) would then try to inflate plain JSON and
      // treat every shard as empty. Asking for the stored bytes means the header
      // and the body always agree.
      headers: { ...headers, authorization, "accept-encoding": "identity" },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  /**
   * List objects under a prefix (ListObjectsV2).
   *
   * Used by the verification/profile scripts, which run on your machine — the
   * Worker never lists the bucket except for the bounded `raw/` page listing.
   */
  async list(prefix: string, maxKeys = 50): Promise<{ key: string; size: number; lastModified: string | null }[]> {
    return (await this.listPage(prefix, maxKeys)).objects;
  }

  /**
   * One page of ListObjectsV2, including the continuation token.
   *
   * `list()` above returns the first page only, which is all the verification
   * scripts ever needed. A reader that must enumerate a whole prefix (the local
   * development API stands in for a Worker binding, whose `list()` paginates)
   * needs the cursor, so it is returned here rather than parsed again.
   */
  async listPage(
    prefix: string,
    maxKeys = 1000,
    cursor?: string,
  ): Promise<{ objects: { key: string; size: number; lastModified: string | null; etag: string | null }[]; truncated: boolean; cursor: string | undefined }> {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": String(maxKeys) };
    if (cursor) query["continuation-token"] = cursor;
    const response = await this.sign("GET", "", undefined, undefined, { bucketRoot: true, query });
    if (!response.ok) {
      throw new Error(`ListObjectsV2 failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const xml = await response.text();
    const objects: { key: string; size: number; lastModified: string | null; etag: string | null }[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? "";
      const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? "0");
      const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? null;
      const etag = /<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1]?.replace(/"/g, "") ?? null;
      if (key) objects.push({ key: decodeXml(key), size, lastModified, etag });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { objects, truncated, cursor: next ? decodeXml(next) : undefined };
  }

  /** Read a byte range of one object (used to sample a 10/50 GB CSV cheaply). */
  async getRange(key: string, bytes: number, offset = 0): Promise<Buffer> {
    const response = await this.sign("GET", key, undefined, undefined, {
      range: `bytes=${offset}-${offset + bytes - 1}`,
    });
    if (!response.ok) {
      throw new Error(`Range read failed for ${key}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** PUT with retries and exponential backoff. */
  async put(
    key: string,
    body: Buffer,
    contentType: string,
    attempts = 4,
    extra?: { contentEncoding?: string; contentDisposition?: string },
  ): Promise<PutResult> {
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.sign("PUT", key, body, contentType, extra);
        if (response.ok) {
          return { key, bytes: body.length, etag: response.headers.get("etag"), attempts: attempt };
        }
        lastError = `HTTP ${response.status} ${await response.text().catch(() => "")}`.trim();
        // 4xx (other than 429) will not succeed on retry.
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    throw new Error(`R2 upload failed for ${key} after ${attempts} attempts: ${lastError}`);
  }

  async putJson(key: string, value: unknown, gzip = false): Promise<PutResult> {
    const raw = Buffer.from(JSON.stringify(value), "utf8");
    const body = gzip ? gzipSync(raw) : raw;
    return this.put(key, body, "application/json", 4, gzip ? { contentEncoding: "gzip" } : undefined);
  }

  async putFile(key: string, path: string, contentType: string, gzip = false): Promise<PutResult> {
    const raw = await readFile(path);
    const body = gzip && !path.endsWith(".gz") ? gzipSync(raw) : raw;
    return this.put(key, body, contentType, 4, gzip ? { contentEncoding: "gzip" } : undefined);
  }

  /**
   * GET one object (used by the verification script; never writes).
   *
   * The response body is returned as stored, and the reported encoding always
   * matches it. Node's fetch decodes a `content-encoding: gzip` body itself while
   * leaving the header in place, so a reader that trusts the header alone — the
   * Worker treats a gzip flag as "inflate this shard" — would try to inflate plain
   * JSON and see an empty shard. The 1f 8b check is the only reliable answer, and
   * stripping the header when it lies keeps every caller (dev API, verify scripts)
   * honest about what it is holding.
   */
  async get(key: string): Promise<Response> {
    const response = await this.sign("GET", key);
    const encoding = response.headers.get("content-encoding");
    if (!encoding || !response.ok || response.status === 206) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) headers.delete("content-encoding");
    return new Response(new Uint8Array(bytes), { status: response.status, statusText: response.statusText, headers });
  }

  async head(key: string): Promise<{ exists: boolean; size: number | null; etag: string | null }> {
    const response = await this.sign("HEAD", key);
    if (!response.ok) return { exists: false, size: null, etag: null };
    const size = response.headers.get("content-length");
    return { exists: true, size: size ? Number(size) : null, etag: response.headers.get("etag") };
  }

  /**
   * HEAD with the HTTP status kept.
   *
   * `head()` collapses every failure into "does not exist", which is right for a
   * presence check but wrong for diagnosis: a 403 (credentials that cannot read
   * the bucket) must not read as "the file is missing". The Mode B source reader
   * uses this variant so a run fails with the real reason.
   */
  async headDetailed(key: string): Promise<{ exists: boolean; size: number | null; etag: string | null; status: number }> {
    const response = await this.sign("HEAD", key);
    if (!response.ok) return { exists: false, size: null, etag: null, status: response.status };
    const size = response.headers.get("content-length");
    return { exists: true, size: size ? Number(size) : null, etag: response.headers.get("etag"), status: response.status };
  }
}

/** Local file size helper used by the preflight report. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return null;
  }
}
