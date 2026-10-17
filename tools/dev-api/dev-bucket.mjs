/**
 * CompanyIntel — development R2 bucket shim.
 *
 * The Cloudflare Worker reads everything through its `COMPANY_DATA` binding. A
 * local dev server has no bindings, so this module implements the subset of the
 * binding the Worker actually uses (`get`, `head`, `list`, `put`, `delete`) on top
 * of an S3-compatible R2 client. The Worker code is then byte-for-byte the code
 * that will run in production — it is the *binding* that is substituted, not the
 * application.
 *
 * Two rules make it safe to point it at the real bucket:
 *
 *  1. **The published pointer is never written.** `manifests/active.json` reads
 *     resolve to an in-memory pointer (the version this dev server was told to
 *     serve, or the version activated inside this process). Clicking "Activate" in
 *     the preview therefore changes *this process only*; the real pointer in R2 is
 *     untouched, so a development experiment cannot redirect a production deploy.
 *  2. **Only the application's own data area is writable.** `app-data/…` (leads,
 *     saved searches, settings, activity, exports) is kept in memory and the active
 *     pointer is intercepted; every other write throws. No code path in the
 *     preview can overwrite index objects, manifests or source data.
 *
 * Everything else (reads of `companies/`, `contacts/`, `indexes/`, `unassigned/`,
 * `manifests/<version>/…`, the bounded `raw/` listing) is served straight from the
 * bucket, so search results and record details are the real ones.
 */

/** Keys the development server is allowed to write, and how they are stored. */
const WRITABLE_PREFIXES = ["app-data/"];
const WRITABLE_EXACT = ["manifests/active.json"];

function isWritable(key) {
  return WRITABLE_EXACT.includes(key) || WRITABLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Content type / encoding a stored object reports, matching what `put` recorded. */
function metadataOf(httpMetadata) {
  return { ...(httpMetadata ?? {}) };
}

/**
 * An R2 body object as the Worker uses it: metadata plus `arrayBuffer()`/`text()`.
 * `body` is provided for the `new Response(object.body)` path the store falls back
 * to when `arrayBuffer` is absent.
 */
function bodyObject(key, bytes, httpMetadata, etag) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    key,
    size: buffer.byteLength,
    etag: etag ?? `dev-${buffer.byteLength}`,
    httpMetadata: metadataOf(httpMetadata),
    uploaded: new Date(0),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => new TextDecoder().decode(buffer),
    json: async () => JSON.parse(new TextDecoder().decode(buffer)),
    body: new Response(buffer).body,
  };
}

function headObject(key, size, httpMetadata, etag) {
  return {
    key,
    size,
    etag: etag ?? `dev-${size}`,
    httpMetadata: metadataOf(httpMetadata),
    uploaded: new Date(0),
  };
}

/**
 * Build the binding-shaped bucket.
 *
 * @param {object} options
 * @param {object} options.remote        `{ getBytes, head, list }` — the real bucket reader.
 * @param {string|null} options.version  the index version this server serves.
 * @param {(message: string) => void} [options.log]
 */
export function createDevBucket({ remote, version = null, log = () => {} }) {
  /** In-memory application data (`app-data/…`) and, if activated here, the pointer. */
  const memory = new Map();
  /** The active pointer this process serves; null means "whatever R2 says". */
  const pointer = {
    version,
    previousVersion: null,
    activatedAt: version ? new Date().toISOString() : null,
    activatedBy: "dev-api",
  };

  const activeKey = "manifests/active.json";

  function pointerBytes() {
    if (!pointer.version) return null;
    return new TextEncoder().encode(
      JSON.stringify({
        version: pointer.version,
        previousVersion: pointer.previousVersion,
        activatedAt: pointer.activatedAt,
        activatedBy: pointer.activatedBy,
      }),
    );
  }

  async function read(key) {
    if (key === activeKey) {
      const staged = memory.get(key);
      if (staged) return { ...staged, synthetic: false };
      const bytes = pointerBytes();
      if (bytes) return { bytes, httpMetadata: { contentType: "application/json" }, etag: null, synthetic: true };
    }
    const staged = memory.get(key);
    if (staged) return { ...staged, synthetic: false };
    const remoteObject = await remote.getBytes(key);
    if (!remoteObject) return null;
    return { ...remoteObject, synthetic: false };
  }

  return {
    /** The version this server currently serves (the dev override or an activation). */
    activeVersion: () => pointer.version,

    async get(key) {
      const found = await read(key);
      if (!found) return null;
      return bodyObject(key, found.bytes, found.httpMetadata, found.etag);
    },

    async head(key) {
      if (key === activeKey && pointerBytes()) {
        const bytes = pointerBytes();
        return headObject(key, bytes.byteLength, { contentType: "application/json" }, null);
      }
      const staged = memory.get(key);
      if (staged) return headObject(key, staged.bytes.byteLength, staged.httpMetadata, null);
      const head = await remote.head(key);
      if (!head) return null;
      return headObject(key, head.size, { contentEncoding: head.contentEncoding }, head.etag);
    },

    async put(key, value, options = {}) {
      if (!isWritable(key)) {
        throw new Error(
          `The development API refuses to write ${key}. Only app-data/… and the in-process active pointer can be written; ` +
            "index objects, manifests and source data are read-only in the preview.",
        );
      }
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      // A write to the pointer is an activation inside THIS process: the version is
      // accepted, the real `manifests/active.json` object is never touched.
      if (key === activeKey) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          pointer.version = parsed.version ?? pointer.version;
          pointer.previousVersion = parsed.previousVersion ?? pointer.previousVersion;
          pointer.activatedAt = parsed.activatedAt ?? new Date().toISOString();
          pointer.activatedBy = parsed.activatedBy ?? "dev-api";
          log(`active version switched to ${pointer.version} (in-process only; R2 manifests/active.json untouched)`);
          memory.delete(key);
          return headObject(key, bytes.byteLength, { contentType: "application/json" }, null);
        } catch (error) {
          throw new Error(`Refusing an unparseable active pointer: ${error.message}`);
        }
      }
      memory.set(key, { bytes, httpMetadata: { ...(options.httpMetadata ?? {}) } });
      return headObject(key, bytes.byteLength, options.httpMetadata, null);
    },

    async delete(key) {
      if (!isWritable(key)) throw new Error(`The development API refuses to delete ${key}.`);
      memory.delete(key);
    },

    async list(options = {}) {
      const { prefix = "", limit = 1000, cursor } = options;
      const page = await remote.list(prefix, limit, cursor);
      const objects = [];
      // In-memory keys are merged only on the first page; cursor pages come from R2.
      if (!cursor) {
        for (const [key, entry] of memory) {
          if (!key.startsWith(prefix)) continue;
          objects.push(headObject(key, entry.bytes.byteLength, entry.httpMetadata, null));
        }
      }
      const remoteObjects = page.objects.map((object) => headObject(object.key, object.size, {}, object.etag));
      const merged = [...objects, ...remoteObjects].sort((a, b) => a.key.localeCompare(b.key)).slice(0, limit);
      return { objects: merged, truncated: page.truncated, cursor: page.cursor };
    },
  };
}
