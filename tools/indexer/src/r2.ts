/**
 * Minimal R2 upload client (S3-compatible API, AWS Signature v4).
 *
 * Only the indexer runs outside Cloudflare, and it is the only component that
 * needs write access to the bucket, so signing lives here rather than in the
 * Worker (the Worker uses the R2 binding and never sees S3 credentials).
 *
 * Credentials come from the environment and are never written to disk or
 * printed:
 *
 *   R2_ACCOUNT_ID        your Cloudflare account id
 *   R2_ACCESS_KEY_ID     R2 access key id
 *   R2_SECRET_ACCESS_KEY R2 secret access key
 *
 * If you would rather not create R2 API tokens at all, run
 * `rclone copy <outputDir> r2:<bucket>` instead — the layout is identical and
 * `--upload` simply skips this module.
 */

import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function credentialsFromEnv(bucket = "company-intel-data"): R2Credentials | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

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
    this.endpoint = `https://${credentials.accountId}.r2.cloudflarestorage.com`;
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

    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const queryString = canonicalQuery ? `?${canonicalQuery}` : "";

    return fetch(`${this.endpoint}${canonicalUri}${queryString}`, {
      method,
      headers: { ...headers, authorization },
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
    const response = await this.sign("GET", "", undefined, undefined, {
      bucketRoot: true,
      query: { "list-type": "2", prefix, "max-keys": String(maxKeys) },
    });
    if (!response.ok) {
      throw new Error(`ListObjectsV2 failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const xml = await response.text();
    const objects: { key: string; size: number; lastModified: string | null }[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? "";
      const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? "0");
      const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? null;
      if (key) objects.push({ key: decodeXml(key), size, lastModified });
    }
    return objects;
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

  /** GET one object (used by the verification script; never writes). */
  async get(key: string): Promise<Response> {
    return this.sign("GET", key);
  }

  async head(key: string): Promise<{ exists: boolean; size: number | null; etag: string | null }> {
    const response = await this.sign("HEAD", key);
    if (!response.ok) return { exists: false, size: null, etag: null };
    const size = response.headers.get("content-length");
    return { exists: true, size: size ? Number(size) : null, etag: response.headers.get("etag") };
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
