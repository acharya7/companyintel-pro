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
 *  1. **The published pointer is never written by the preview.** `manifests/active.json`
 *     is answered from an in-memory pointer (the version activated inside this
 *     process, or the one committed to R2 by `cli publish`). Clicking "Activate" in
 *     the preview therefore changes *this process only*; the real pointer in R2 is
 *     untouched, so a development experiment cannot redirect a production deploy.
 *
 *     Reads of the pointer are DYNAMIC: the newest activation wins, and the R2
 *     pointer is re-read at most every five seconds. Publishing a verified index
 *     therefore makes the running preview serve it without a restart — the thing a
 *     pinned-at-startup version could never do.
 *  2. **Only the application's own data area is writable.** `app-data/…` (leads,
 *     saved searches, settings, activity, exports) is kept in memory and the active
 *     pointer is intercepted; every other write throws. No code path in the
 *     preview can overwrite index objects, manifests or source data.
 *
 * Everything else (reads of `companies/`, `contacts/`, `indexes/`, `unassigned/`,
 * `manifests/<version>/…`, the bounded `raw/` listing) is served straight from the
 * bucket, so search results and record details are the real ones.
 *
 * That includes the contact name index (`indexes/<version>/contactToken`,
 * `contactPrefix`, `contactTrigram`), so a person search in the preview reads the
 * same shards a deployed Worker would — and a preserved contact is opened through
 * its `unassigned/` object using the negative ref the ids index records for it
 * (see `worker/src/contact-search.ts`).
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
 * @param {string|null} options.version  index version to serve when nothing is published.
 * @param {boolean} [options.pin]        true when `version` came from the environment: serve it always.
 * @param {(message: string) => void} [options.log]
 */
export function createDevBucket({ remote, version = null, pin = false, log = () => {} }) {
  /** In-memory application data (`app-data/…`). */
  const memory = new Map();

  const activeKey = "manifests/active.json";
  /**
   * A version discovered on disk at startup, used when neither this process nor R2
   * has published a pointer. It is a fallback, not a pin: the moment a newer
   * activation exists it stops being served.
   */
  const fallbackVersion = version;
  /** An activation performed in this process (the Dataset page's Activate button). */
  let localPointer = null;
  /** Last read of the real pointer, with its TTL. */
  let remoteRead = { at: 0, pointer: null };
  const POINTER_TTL_MS = 5000;
  /** What the last resolution chose, so a change can be logged once. */
  let served = null;

  async function readRemotePointer() {
    const now = Date.now();
    if (now - remoteRead.at < POINTER_TTL_MS) return remoteRead.pointer;
    let pointer = null;
    try {
      const found = await remote.getBytes(activeKey);
      if (found) {
        const parsed = JSON.parse(new TextDecoder().decode(found.bytes));
        if (parsed?.version) {
          pointer = {
            version: parsed.version,
            previousVersion: parsed.previousVersion ?? null,
            activatedAt: parsed.activatedAt ?? null,
            activatedBy: parsed.activatedBy ?? "r2",
          };
        }
      }
    } catch {
      // An unreadable pointer is "no pointer": the fallback version still serves.
      pointer = null;
    }
    remoteRead = { at: now, pointer };
    return pointer;
  }

  /**
   * The pointer this process should serve.
   *
   * Order of precedence:
   *   1. `pin` (COMPANYINTEL_DEV_DATASET_VERSION) — an explicit instruction wins.
   *   2. the newest activation of {this process, R2} by `activatedAt`. That is what
   *      makes an R2 publish take effect in the running preview, while an Activate
   *      click still wins until something newer is published.
   *   3. the version discovered at startup, so a bucket with index objects but no
   *      pointer still shows real data instead of "no dataset".
   */
  async function resolvePointer() {
    if (pin && fallbackVersion) {
      return { version: fallbackVersion, previousVersion: null, activatedAt: null, activatedBy: "pinned" };
    }
    const candidates = [];
    if (localPointer) candidates.push(localPointer);
    const remotePointer = await readRemotePointer();
    if (remotePointer) candidates.push(remotePointer);
    if (fallbackVersion) {
      candidates.push({ version: fallbackVersion, previousVersion: null, activatedAt: null, activatedBy: "discovered" });
    }
    if (!candidates.length) return null;
    const stamp = (entry) => (entry.activatedAt ? Date.parse(entry.activatedAt) || 0 : 0);
    // `sort` is stable, so on equal timestamps the earlier candidate (local, then
    // R2, then the startup discovery) keeps precedence.
    const ranked = [...candidates].sort((a, b) => stamp(b) - stamp(a));
    const chosen = ranked[0];
    if (served !== chosen.version) {
      log(`serving index version ${chosen.version} (${chosen.activatedBy})`);
      served = chosen.version;
    }
    return chosen;
  }

  async function pointerBytes() {
    const pointer = await resolvePointer();
    if (!pointer?.version) return null;
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
      const bytes = await pointerBytes();
      if (bytes) return { bytes, httpMetadata: { contentType: "application/json" }, etag: null, synthetic: true };
    }
    const staged = memory.get(key);
    if (staged) return { ...staged, synthetic: false };
    const remoteObject = await remote.getBytes(key);
    if (!remoteObject) return null;
    return { ...remoteObject, synthetic: false };
  }

  return {
    /** The version this server currently serves (resolved, not cached). */
    activeVersion: async () => (await resolvePointer())?.version ?? null,

    async get(key) {
      const found = await read(key);
      if (!found) return null;
      return bodyObject(key, found.bytes, found.httpMetadata, found.etag);
    },

    async head(key) {
      if (key === activeKey) {
        const bytes = await pointerBytes();
        if (bytes) return headObject(key, bytes.byteLength, { contentType: "application/json" }, null);
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
          if (!parsed?.version) throw new Error("the pointer has no version");
          localPointer = {
            version: parsed.version,
            previousVersion: parsed.previousVersion ?? null,
            activatedAt: parsed.activatedAt ?? new Date().toISOString(),
            activatedBy: parsed.activatedBy ?? "dev-api",
          };
          log(`active version switched to ${localPointer.version} (in-process only; R2 manifests/active.json untouched)`);
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
