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

  /** Sign and send one S3 request. */
  private async sign(method: "PUT" | "HEAD" | "GET", key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const { accessKeyId, secretAccessKey, bucket } = this.credentials;
    const host = new URL(this.endpoint).host;
    const canonicalUri = `/${bucket}/${encodeKeyPath(key)}`;
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

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name]}\n`)
      .join("");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(`${this.endpoint}/${bucket}/${encodeKeyPath(key)}`, {
      method,
      headers: { ...headers, authorization },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  /** PUT with retries and exponential backoff. */
  async put(key: string, body: Buffer, contentType: string, attempts = 4): Promise<PutResult> {
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.sign("PUT", key, body, contentType);
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
    return this.put(key, body, gzip ? "application/json" : "application/json");
  }

  async putFile(key: string, path: string, contentType: string, gzip = false): Promise<PutResult> {
    const raw = await readFile(path);
    const body = gzip && !path.endsWith(".gz") ? gzipSync(raw) : raw;
    return this.put(key, body, contentType);
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
