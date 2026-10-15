/**
 * In-memory `R2Bucket` binding for tests.
 *
 * Implements the parts of the R2 binding the Worker actually uses (get, put with
 * ETag preconditions, head, list, delete) and records operation/byte counters so
 * tests and benchmarks can report **real** reads per search instead of guessing.
 *
 * Objects loaded from disk are stored exactly as the indexer uploads them:
 * gzipped shards keep their bytes and get `contentEncoding: "gzip"`. A separate
 * helper stores a gzip body *without* metadata, which is what happens when files
 * are copied in with rclone — the Worker must still read those.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface StoredObject {
  etag: string;
  bytes: Buffer;
  contentType: string;
  contentEncoding?: string;
  uploaded: Date;
}

export interface OperationCounters {
  gets: number;
  heads: number;
  puts: number;
  lists: number;
  deletes: number;
  /** Total bytes served by `get` (i.e. what the Worker would transfer from R2). */
  bytesRead: number;
  /** Keys served by `get`, so a test can name what a search fetched. */
  readKeys: string[];
}

export class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  readonly counters: OperationCounters = {
    gets: 0,
    heads: 0,
    puts: 0,
    lists: 0,
    deletes: 0,
    bytesRead: 0,
    readKeys: [],
  };

  private etagCounter = 0;

  /** Runs immediately before every `put` (used to simulate concurrent writers). */
  beforePut: (() => void) | null = null;

  private nextEtag(bytes: Buffer): string {
    this.etagCounter += 1;
    return `"e${this.etagCounter}-${bytes.length}"`;
  }

  /** Store an object from raw bytes, mirroring what the indexer uploads. */
  putBytes(key: string, bytes: Buffer, options: { contentEncoding?: string; contentType?: string } = {}): void {
    this.objects.set(key, {
      etag: this.nextEtag(bytes),
      bytes,
      contentType: options.contentType ?? "application/json",
      contentEncoding: options.contentEncoding,
      uploaded: new Date(),
    });
  }

  /**
   * Load exactly the objects the indexer would upload, using the same rules as
   * `uploadOutput` (`.gz` files carry `content-encoding: gzip`). Files that stay
   * local, such as the `objects.jsonl` validation log, are deliberately excluded
   * so the bucket mirrors a real upload rather than the working directory.
   */
  loadObjects(root: string, keys: string[], options: { gzipMetadata?: boolean } = {}): number {
    const gzipMetadata = options.gzipMetadata ?? true;
    for (const key of keys) {
      const bytes = readFileSync(join(root, key));
      const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
      this.putBytes(key, bytes, {
        contentType: key.endsWith(".gz") || key.endsWith(".json") ? "application/json" : "text/plain",
        contentEncoding: isGzip && gzipMetadata ? "gzip" : undefined,
      });
    }
    return keys.length;
  }

  /**
   * Load a whole directory tree, as an rclone copy of the output folder would:
   * this includes the `objects.jsonl` log and any other local file.
   */
  loadDirectory(root: string, options: { gzipMetadata?: boolean } = {}): number {
    const gzipMetadata = options.gzipMetadata ?? true;
    let loaded = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const info = statSync(path);
        if (info.isDirectory()) {
          walk(path);
          continue;
        }
        const key = relative(root, path).split(sep).join("/");
        const bytes = readFileSync(path);
        const isGzip = entry.endsWith(".gz") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
        this.putBytes(key, bytes, {
          contentType: entry.endsWith(".json") || isGzip ? "application/json" : "text/plain",
          contentEncoding: isGzip && gzipMetadata ? "gzip" : undefined,
        });
        loaded += 1;
      }
    };
    walk(root);
    return loaded;
  }

  resetCounters(): void {
    this.counters.gets = 0;
    this.counters.heads = 0;
    this.counters.puts = 0;
    this.counters.lists = 0;
    this.counters.deletes = 0;
    this.counters.bytesRead = 0;
    this.counters.readKeys = [];
  }

  /* --------------------------- R2Bucket surface --------------------------- */

  async get(key: string): Promise<unknown> {
    this.counters.gets += 1;
    const object = this.objects.get(key);
    if (!object) return null;
    this.counters.bytesRead += object.bytes.length;
    this.counters.readKeys.push(key);
    const bytes = object.bytes;
    return {
      key,
      etag: object.etag,
      size: bytes.length,
      uploaded: object.uploaded,
      httpMetadata: { contentType: object.contentType, contentEncoding: object.contentEncoding },
      body: new Blob([new Uint8Array(bytes)]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => bytes.toString("utf8"),
      json: async () => JSON.parse(bytes.toString("utf8")),
    };
  }

  async put(
    key: string,
    value: string | Buffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string }; onlyIf?: { etagMatches?: string } },
  ): Promise<unknown> {
    this.counters.puts += 1;
    const hook = this.beforePut;
    this.beforePut = null;
    if (hook) hook();

    const current = this.objects.get(key);
    if (options?.onlyIf?.etagMatches && current && current.etag !== options.onlyIf.etagMatches) {
      // R2 returns null when a precondition fails: a lost update, not an error.
      return null;
    }

    const bytes =
      typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value as Uint8Array);
    const stored: StoredObject = {
      etag: this.nextEtag(bytes),
      bytes,
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
      contentEncoding: options?.httpMetadata?.contentEncoding,
      uploaded: new Date(),
    };
    this.objects.set(key, stored);
    return { key, etag: stored.etag, size: bytes.length };
  }

  async head(key: string): Promise<unknown> {
    this.counters.heads += 1;
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, etag: object.etag, size: object.bytes.length, uploaded: object.uploaded, httpMetadata: {} };
  }

  async delete(key: string): Promise<void> {
    this.counters.deletes += 1;
    this.objects.delete(key);
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<unknown> {
    this.counters.lists += 1;
    const limit = options.limit ?? 1000;
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort((a, b) => a[0].localeCompare(b[0]));
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = all.slice(start, start + limit);
    const truncated = start + page.length < all.length;
    return {
      objects: page.map(([key, value]) => ({
        key,
        etag: value.etag,
        size: value.bytes.length,
        uploaded: value.uploaded,
        httpMetadata: {},
      })),
      truncated,
      cursor: truncated ? String(start + page.length) : undefined,
    };
  }

  /** Convenience used by assertions. */
  getObject(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
