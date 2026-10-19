/**
 * Blob storage the cloud indexer reads and writes.
 *
 * The engine must run unchanged in two places:
 *
 *   - inside a Cloudflare Container, using the S3-compatible API (the same
 *     `R2Client` the local indexer already uses), and
 *   - in this repository's tests and dev server, where a real R2 round-trip is
 *     either unnecessary or must be bounded.
 *
 * So the engine talks to this interface, not to `R2Client` directly. Every
 * implementation is content-addressed by key and idempotent on PUT: writing the
 * same key twice with the same bytes is safe, which is what lets a restarted job
 * re-upload a chunk without creating a second copy.
 */

import { createHash } from "node:crypto";

import type { R2Client } from "../indexer/src/r2";

export interface BlobHead {
  exists: boolean;
  size: number | null;
  etag: string | null;
}

export interface BlobStore {
  /** Read exactly `length` bytes at `offset` (fewer at end of object). */
  getRange(key: string, offset: number, length: number): Promise<Buffer>;
  put(key: string, body: Buffer, contentType?: string): Promise<{ etag: string | null }>;
  head(key: string): Promise<BlobHead>;
  /** Every object under a prefix, following pagination. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Cheap GET of a small JSON object; null when absent. */
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
}

/** Real R2 over the S3 API. Requests are counted so the job can report cost. */
export class R2BlobStore implements BlobStore {
  private readonly client: R2Client;
  private counters = { classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0 };

  constructor(client: R2Client) {
    this.client = client;
  }

  countersSnapshot() {
    return { ...this.counters };
  }

  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const info = await this.head(key);
    if (!info.exists || info.size === null) throw new Error(`Source object is missing: ${key}`);
    const end = Math.min(info.size, offset + length);
    if (offset >= end) return Buffer.alloc(0);
    this.counters.classB += 1;
    const buffer = await this.client.getRange(key, end - offset, offset);
    this.counters.bytesRead += buffer.length;
    return buffer;
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<{ etag: string | null }> {
    this.counters.classA += 1;
    const result = await this.client.put(key, body, contentType);
    this.counters.bytesWritten += body.length;
    return { etag: result.etag };
  }

  /** Source objects are immutable during a run, so their HEAD is cached. */
  private readonly headCache = new Map<string, BlobHead>();

  async head(key: string): Promise<BlobHead> {
    if (!key.startsWith("cloud/")) {
      const cached = this.headCache.get(key);
      if (cached) return cached;
    }
    this.counters.classB += 1;
    const info = await this.client.headDetailed(key);
    const result = { exists: info.exists, size: info.size, etag: info.etag };
    if (info.exists && !key.startsWith("cloud/")) this.headCache.set(key, result);
    return result;
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      this.counters.classA += 1;
      const page = await this.client.listPage(prefix, 1000, cursor);
      out.push(...page.objects.map((object) => ({ key: object.key, size: object.size })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async getJson<T>(key: string): Promise<T | null> {
    this.counters.classB += 1;
    const response = await this.client.get(key);
    if (!response.ok) return null;
    const text = await response.text();
    this.counters.bytesRead += Buffer.byteLength(text, "utf8");
    return JSON.parse(text) as T;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    await this.put(key, body, "application/json");
  }
}

/**
 * In-memory store for tests and dry runs.
 *
 * It implements the same contract as R2 (range reads, idempotent PUT, listing)
 * and records every operation, so a test can assert the exact request counts a
 * job would bill — not just its output.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Buffer>();
  readonly ops = { classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0 };

  constructor(seed: Record<string, Buffer> = {}) {
    for (const [key, value] of Object.entries(seed)) this.objects.set(key, value);
  }

  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    this.ops.classB += 1;
    const body = this.objects.get(key);
    if (!body) throw new Error(`Source object is missing: ${key}`);
    const slice = body.subarray(offset, Math.min(body.length, offset + length));
    this.ops.bytesRead += slice.length;
    return Buffer.from(slice);
  }

  async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    this.ops.classA += 1;
    this.ops.bytesWritten += body.length;
    this.objects.set(key, Buffer.from(body));
    return { etag: createHash("md5").update(body).digest("hex") };
  }

  async head(key: string): Promise<BlobHead> {
    this.ops.classB += 1;
    const body = this.objects.get(key);
    return body ? { exists: true, size: body.length, etag: null } : { exists: false, size: null, etag: null };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    this.ops.classA += 1;
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const body = this.objects.get(key);
    if (!body) return null;
    this.ops.classB += 1;
    return JSON.parse(body.toString("utf8")) as T;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, Buffer.from(JSON.stringify(value), "utf8"));
  }

  /** Test helper: the stored bytes (undefined when absent). */
  bytes(key: string): Buffer | undefined {
    return this.objects.get(key);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
