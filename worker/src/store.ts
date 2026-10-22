/**
 * R2 data access for the Worker.
 *
 * Only two kinds of objects exist here:
 *   - immutable, versioned index/profile objects (never written in place),
 *   - a handful of small, mutable `app-data/` objects (leads, saved searches,
 *     settings, activity, exports) written with conditional (compare-and-set)
 *     requests so two browser tabs cannot lose each other's writes.
 *
 * R2 is eventually consistent for writes, so the optimistic-concurrency loop
 * below re-reads and retries a bounded number of times and then surfaces a
 * conflict to the caller instead of silently overwriting.
 */

import type { Company, Contact, DatasetStats, DatasetVersionSummary, SavedLead, SavedSearch, UnassignedContact, UserSettings, ActivityEntry } from "../../src/shared/models";
import { R2_PREFIX, leadShardKey, statsKey, activeManifestKey, companyPartitionKey, contactPartitionKey, companyDetailKey, contactDetailKey, exportMetaKey, exportObjectKey, indexDirectoryKey, indexShardKey, manifestKey, partitionOfRef, contactPartitionOfRef, savedSearchesKey, settingsKey, activityKey, unassignedPartitionKey, validationKey, progressKey, detailForCompany, detailForContacts, isDetailSplitFormat, type IndexDirectory, type ShardPayload, type IndexKind, type CompanyPartitionPayload, type ContactPartitionPayload, type CompanyDetailPayload, type ContactDetailPayload, type ContactShardKind, type ContactShardPayload, type UnassignedPartitionPayload } from "../../src/shared/search/index-format";
import { SHARDING, contactsFor, postingsFor, snapshotKey } from "../../src/shared/search/index-format";
import { shardOf } from "../../src/shared/hash";
import { isCacheableKey, type ObjectCache, type ReadMetrics } from "./search-cache";

export const LEAD_SHARDS = 64;
export const MAX_WRITE_RETRIES = 4;

export interface ActivePointer {
  version: string;
  previousVersion: string | null;
  activatedAt: string;
  activatedBy: string;
}

export interface LeadIndex {
  total: number;
  partitions: { partition: number; count: number; updatedAt: string }[];
  updatedAt: string;
}

export interface ExportIndexEntry {
  id: string;
  filename: string;
  createdAt: string;
  rowCount: number;
  bytes: number;
  truncated: boolean;
}

export interface R2StoreOptions {
  /**
   * Bounded, per-isolate cache for immutable index objects. Optional: a store
   * built without one behaves exactly as before, and all mutable `app-data/`
   * reads bypass it either way (see `isCacheableKey`).
   */
  cache?: ObjectCache;
  /** Counts the objects/bytes this store actually fetched from R2. */
  metrics?: ReadMetrics;
  /**
   * Mutable pointer this deployment treats as "the active dataset".
   *
   * Production uses the default (`manifests/active.json`). The staging Worker
   * sets `staging/active.json`, so a staging activation cannot change what the
   * production application serves even though both read the same indexes.
   */
  activeManifestKey?: string;
}

export class R2Store {
  /**
   * Format version per dataset version, so "does this index store details inline?"
   * is answered once per request instead of once per record. The directory object
   * it comes from is itself an immutable, cacheable index object — this memo just
   * avoids re-decoding it on every record of an export loop.
   */
  private readonly formatVersions = new Map<string, number>();

  constructor(
    private readonly bucket: R2Bucket,
    private readonly options: R2StoreOptions = {},
  ) {}

  /**
   * True when this version keeps full records in `details/` (format v4+).
   *
   * A v2/v3 index carries `attributes` inline in its partitions; those versions
   * stay fully readable, which is what makes a rollback to the previous version a
   * pointer change rather than a rebuild.
   */
  private async hasSplitDetails(version: string): Promise<boolean> {
    const memo = this.formatVersions.get(version);
    if (memo !== undefined) return isDetailSplitFormat(memo);
    const directory = await this.getDirectory(version);
    const formatVersion = directory?.formatVersion ?? 0;
    this.formatVersions.set(version, formatVersion);
    return isDetailSplitFormat(formatVersion);
  }

  /* ------------------------------ primitives ----------------------------- */

  private async readObject(key: string): Promise<R2ObjectBody | null> {
    try {
      return await this.bucket.get(key);
    } catch {
      return null;
    }
  }

  /**
   * Read one object body and report whether it is gzip-compressed.
   *
   * The metadata flag is the fast path, but the 1f 8b magic bytes decide when it
   * is absent — which is what happens when an object reached the bucket through
   * rclone/S3 rather than the indexer's uploader.
   */
  private async objectBytes(object: R2ObjectBody): Promise<{ bytes: Uint8Array; gzip: boolean }> {
    const buffer =
      typeof object.arrayBuffer === "function"
        ? await object.arrayBuffer()
        : await new Response(object.body as ReadableStream).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const gzip = object.httpMetadata?.contentEncoding === "gzip" || (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b);
    return { bytes, gzip };
  }

  /** Decode a stored object body (gzip when flagged) into JSON. */
  private async decodeJson<T>(bytes: Uint8Array, gzip: boolean): Promise<T> {
    if (gzip) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return (await new Response(stream).json()) as T;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async getText(key: string): Promise<string | null> {
    const object = await this.readObject(key);
    return object ? object.text() : null;
  }

  /**
   * JSON object (optionally gzip-compressed by the indexer).
   *
   * Gzip is detected from the object's metadata **and** from the 1f 8b magic
   * bytes. The magic-byte check matters because the indexer is not the only way
   * objects reach this bucket: anything copied in with rclone/S3 without a
   * `Content-Encoding` header would otherwise be read as raw gzip bytes, JSON
   * parsing would fail, and every shard would silently look empty.
   */
  async getJson<T>(key: string): Promise<T | null> {
    const cache = this.options.cache;
    if (cache !== undefined && isCacheableKey(key)) {
      // `load` returns a cache hit, joins an in-flight read of the same key, or
      // performs the read — so one object is fetched from R2 at most once, even
      // when two batches ask for it at the same moment. Metrics are recorded
      // inside the read callback because that callback is exactly the R2 fetch:
      // a cache hit and a joined in-flight read both skip it.
      const body = await cache
        .load(key, async () => {
          const object = await this.readObject(key);
          if (!object) return null;
          const read = await this.objectBytes(object);
          this.options.metrics?.recordObject(key, read.bytes.length);
          return read;
        })
        .catch(() => null);
      if (!body) return null;
      try {
        return await this.decodeJson<T>(body.bytes, body.gzip);
      } catch {
        return null;
      }
    }

    const object = await this.readObject(key);
    if (!object) return null;
    try {
      const body = await this.objectBytes(object);
      this.options.metrics?.recordObject(key, body.bytes.length);
      return await this.decodeJson<T>(body.bytes, body.gzip);
    } catch {
      return null;
    }
  }

  async putJson(key: string, value: unknown, options: { gzip?: boolean; onlyIf?: R2Conditional } = {}): Promise<R2Object | null> {
    const body = JSON.stringify(value);
    return this.bucket.put(key, body, {
      httpMetadata: {
        contentType: "application/json",
        ...(options.gzip ? { contentEncoding: "gzip" } : {}),
      },
      onlyIf: options.onlyIf,
    });
  }

  async putCsv(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "text/csv; charset=utf-8", contentDisposition: `attachment` },
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<R2Object | null> {
    try {
      return await this.bucket.head(key);
    } catch {
      return null;
    }
  }

  /** Bounded listing — used only by the dataset management page. */
  async list(prefix: string, limit = 1000): Promise<R2Object[]> {
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    while (objects.length < limit) {
      const page = await this.bucket.list({ prefix, limit: Math.min(1000, limit - objects.length), cursor });
      objects.push(...page.objects);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    return objects;
  }

  /* ------------------------------ dataset --------------------------------- */

  private activeKey(): string {
    const key = this.options.activeManifestKey;
    return key && key.trim() ? key : activeManifestKey();
  }

  async getActivePointer(): Promise<ActivePointer | null> {
    return this.getJson<ActivePointer>(this.activeKey());
  }

  async getDirectory(version: string): Promise<IndexDirectory | null> {
    return this.getJson<IndexDirectory>(indexDirectoryKey(version));
  }

  async getManifest(version: string): Promise<DatasetVersionSummary | null> {
    return this.getJson<DatasetVersionSummary>(manifestKey(version));
  }

  async getValidation(version: string): Promise<unknown | null> {
    return this.getJson(validationKey(version));
  }

  async getProgress(version: string): Promise<unknown | null> {
    return this.getJson(progressKey(version));
  }

  async getStats(version: string): Promise<DatasetStats | null> {
    return this.getJson<DatasetStats>(statsKey(version));
  }

  async putProgress(version: string, progress: unknown): Promise<void> {
    await this.putJson(progressKey(version), progress);
  }

  async listManifests(limit = 20): Promise<DatasetVersionSummary[]> {
    const objects = await this.list("manifests/", limit * 3);
    const versions: DatasetVersionSummary[] = [];
    for (const object of objects) {
      if (!object.key.endsWith("/manifest.json")) continue;
      const manifest = await this.getJson<DatasetVersionSummary>(object.key);
      if (manifest) versions.push(manifest);
    }
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Atomic publish: one tiny pointer object flips the whole dataset version. */
  async activateVersion(pointer: ActivePointer): Promise<void> {
    await this.putJson(this.activeKey(), pointer);
  }

  /* ------------------------------- index ---------------------------------- */

  async getShard(version: string, kind: IndexKind, shard: number): Promise<ShardPayload | null> {
    return this.getJson<ShardPayload>(indexShardKey(version, kind, shard));
  }

  async getShardByTerm(version: string, kind: Exclude<IndexKind, "stats">, term: string, shardCount: number): Promise<ShardPayload | null> {
    return this.getShard(version, kind, shardOf(term, shardCount));
  }

  /**
   * One shard of the contact name index.
   *
   * A separate accessor because the payload is shaped differently: its postings
   * hold contact ids, not document refs. Reading it through `getShard` would type
   * as a company payload and hide the difference at every call site.
   */
  async getContactShard(
    version: string,
    kind: ContactShardKind,
    shard: number,
  ): Promise<ContactShardPayload | null> {
    return this.getJson<ContactShardPayload>(indexShardKey(version, kind, shard));
  }

  /**
   * Ids index postings for many contact ids at once, grouped by shard.
   *
   * This is the second half of contact hydration: a name posting names a contact
   * id, and the ids index says which company owns it (or, for a contact kept
   * without an employer, which `unassigned/` object holds it — see the negative
   * ref convention in `tools/indexer/src/build.ts`).
   */
  async refsForContactIds(version: string, ids: string[], idShards: number): Promise<Map<string, number>> {
    const byShard = new Map<number, string[]>();
    for (const id of ids) {
      const shard = shardOf(id, idShards);
      const list = byShard.get(shard);
      if (list) list.push(id);
      else byShard.set(shard, [id]);
    }
    const out = new Map<string, number>();
    await mapLimit([...byShard.entries()], 8, async ([shard, shardIds]) => {
      const payload = await this.getShard(version, "ids", shard);
      if (!payload) return;
      for (const id of shardIds) {
        const ref = postingsFor(payload, id)?.refs?.[0];
        if (typeof ref === "number") out.set(id, ref);
      }
    });
    return out;
  }

  /**
   * Hydrate companies for a set of global refs.
   *
   * Profile objects are grouped by `companiesPerPartition`, so refs that fall in
   * the same partition cost one read. `maxParts` bounds the worst case for a
   * dispersed fuzzy result set.
   *
   * Partitions are taken in **first-seen order**, i.e. in the order the caller
   * ranked the refs, so a bounded hydration always spends its budget on the
   * best candidates instead of on whichever partition happens to hold the most
   * of them. Refs whose partition falls outside `maxParts` are simply absent
   * from the result map — the caller treats that as "not hydrated", never as an
   * error.
   *
   * COMPLETENESS CONTRACT
   * ---------------------
   * The result contains **every company in every partition this call read**, not
   * only the refs that were asked for. A partition object is fetched whole, so the
   * extra entries are free — and they are what lets a caller truthfully record "this
   * partition was hydrated completely".
   *
   * Returning only the requested refs caused a real search defect: the caller marked
   * the whole partition as read, then skipped every other ref in it as "already read,
   * not in the object", so a query whose token/trigram candidates shared an object
   * with an exact match could silently lose them. The condition is not fixture-only:
   * any result set that retrieves a few refs from an object and later retrieves more
   * from the same object hits it.
   */
  async getCompaniesByRefs(version: string, refs: number[], maxParts: number = SHARDING.maxHydrate): Promise<Map<number, Company>> {
    const grouped = new Map<number, number[]>();
    for (const ref of refs) {
      const partition = partitionOfRef(ref);
      const list = grouped.get(partition);
      if (list) list.push(ref);
      else grouped.set(partition, [ref]);
    }
    const ordered: [number, number[]][] = [];
    for (const entry of grouped) {
      if (ordered.length >= maxParts) break;
      ordered.push(entry);
    }
    const out = new Map<number, Company>();
    await mapLimit(ordered, 8, async ([partition]) => {
      const payload = await this.getJson<CompanyPartitionPayload>(companyPartitionKey(version, partition));
      if (!payload) return;
      for (let index = 0; index < payload.companies.length; index += 1) {
        const company = payload.companies[index] as Company | undefined;
        if (company) out.set(payload.firstRef + index, company);
      }
    });
    return out;
  }

  /**
   * The complete company record: search projection + its detail object.
   *
   * This is the record view (company page, exports, leads), so it pays one extra
   * read on a format-v4 index to get every source column. Search never calls it —
   * `getCompaniesByRefs` returns the projections, which is what keeps search bytes
   * independent of how many columns a record has.
   */
  async getCompanyByRef(version: string, ref: number): Promise<Company | null> {
    const partition = partitionOfRef(ref);
    const payload = await this.getJson<CompanyPartitionPayload>(companyPartitionKey(version, partition));
    if (!payload) return null;
    const company = (payload.companies[ref - payload.firstRef] as Company | undefined) ?? null;
    if (!company || !(await this.hasSplitDetails(version))) return company;

    const detail = detailForCompany(await this.getJson<CompanyDetailPayload>(companyDetailKey(version, partition)), ref);
    if (!detail) return company;
    return {
      ...company,
      ...(detail.attributes ? { attributes: detail.attributes } : {}),
      ...(detail.facets ? { facets: detail.facets as Company["facets"] } : {}),
    };
  }

  /**
   * A company's contacts WITH their full source columns.
   *
   * Same split as the company record: the projection is enough for lists, filters
   * and exports of canonical fields, and the detail object is read only when the
   * caller needs `attributes` (contact page, export, reassignment).
   */
  async getContactsByCompanyRef(version: string, ref: number): Promise<Contact[]> {
    const partition = contactPartitionOfRef(ref);
    const payload = await this.getJson<ContactPartitionPayload>(contactPartitionKey(version, partition));
    if (!payload) return [];
    // `contactsFor` does the own-property lookup: a parsed payload must never
    // answer from `Object.prototype`.
    const contacts = (contactsFor(payload, ref) as Contact[] | undefined) ?? [];
    if (!contacts.length || !(await this.hasSplitDetails(version))) return contacts;

    const attributes = detailForContacts(await this.getJson<ContactDetailPayload>(contactDetailKey(version, partition)), ref);
    if (!attributes) return contacts;
    return contacts.map((contact, position) => {
      const full = attributes[position];
      return full ? { ...contact, attributes: full } : contact;
    });
  }

  /**
   * Contacts of several companies, read partition by partition.
   *
   * Contact objects hold `companiesPerContactPartition` companies each, and a
   * result page clusters around few partitions, so batched hydration costs a
   * handful of reads instead of one per company. `maxParts` bounds the worst case
   * for a dispersed result set; refs from partitions beyond it are simply absent
   * from the map, which the caller reports as "not hydrated".
   */
  async getContactsByCompanyRefs(
    version: string,
    refs: number[],
    maxParts = 8,
  ): Promise<Map<number, Contact[]>> {
    const grouped = new Map<number, number[]>();
    for (const ref of refs) {
      const partition = contactPartitionOfRef(ref);
      const list = grouped.get(partition);
      if (list) list.push(ref);
      else grouped.set(partition, [ref]);
    }
    const ordered: [number, number[]][] = [];
    for (const entry of grouped) {
      if (ordered.length >= maxParts) break;
      ordered.push(entry);
    }
    const out = new Map<number, Contact[]>();
    await mapLimit(ordered, 8, async ([partition, partitionRefs]) => {
      const payload = await this.getJson<ContactPartitionPayload>(contactPartitionKey(version, partition));
      if (!payload) return;
      for (const ref of partitionRefs) {
        const contacts = contactsFor(payload, ref) as Contact[] | undefined;
        if (contacts) out.set(ref, contacts);
      }
    });
    return out;
  }

  /**
   * Partition that holds one preserved contact, from its ids-index ref.
   *
   * The ids index stores `-(partition + 1)` for a contact with no employer (see
   * the negative-ref note in the indexer), so this is the only translation the
   * reader needs to open the right `unassigned/` object. Returns `null` when the
   * ref is a normal, company-owned document ref.
   */
  unassignedPartitionOfRef(ref: number): number | null {
    return ref < 0 ? -ref - 1 : null;
  }

  /**
   * Contacts preserved WITHOUT an employer for one spool partition.
   *
   * One bounded object read, addressed by the company's own Pass 1 partition, so
   * reviewing unresolved contacts costs exactly one GET and never a listing. A
   * format-v2 index has no such objects (the prefix, the partition count and the
   * categories did not exist), and an empty result is the correct answer for it.
   */
  async getUnassignedContacts(version: string, partition: number): Promise<UnassignedContact[]> {
    const payload = await this.getJson<UnassignedPartitionPayload>(unassignedPartitionKey(version, partition));
    if (!payload) return [];
    return (payload.contacts as UnassignedContact[] | undefined) ?? [];
  }

  /* ----------------------------- app data --------------------------------- */

  /**
   * Read-modify-write one small app-data object with compare-and-set retries.
   * `mutate` must be pure; it is re-run against fresh state after a conflict.
   */
  async updateJson<T>(
    key: string,
    mutate: (current: T | null) => T,
    retries = MAX_WRITE_RETRIES,
    options: { snapshot?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const object = await this.readObject(key);
      let current: T | null = null;
      if (object) {
        try {
          const text = await object.text();
          current = JSON.parse(text) as T;
          // Recovery snapshot: the pre-mutation state, at most once per object
          // per day. A snapshot failure must never block the write itself.
          if (options.snapshot && attempt === 0) {
            const stamp = new Date().toISOString().slice(0, 10);
            await this.bucket
              .put(snapshotKey(stamp, key), text, { httpMetadata: { contentType: "application/json" } })
              .catch(() => undefined);
          }
        } catch {
          current = null;
        }
      }
      const next = mutate(current);
      const result = await this.bucket.put(key, JSON.stringify(next), {
        httpMetadata: { contentType: "application/json" },
        onlyIf: object ? { etagMatches: object.etag } : undefined,
      });
      // `put` returns null when `onlyIf` fails — that is a lost update, not an error.
      if (result) return next;
    }
    throw new Error(`Concurrent write conflict on ${key} — nothing was overwritten. Retry the operation.`);
  }

  private leadPartition(leadId: string): number {
    return shardOf(leadId, LEAD_SHARDS);
  }

  /**
   * List saved leads.
   *
   * The lead **shards** are authoritative; the index is only a directory of them
   * (it exists so reading leads never lists the bucket). If the index is missing,
   * empty or references a shard that is no longer there, it is rebuilt from the
   * shards once instead of reporting "no leads". That is the difference between a
   * self-healing read and silent data loss.
   */
  async listLeads(): Promise<SavedLead[]> {
    let index = await this.getJson<LeadIndex>(leadShardKeyIndex());
    if (!index?.partitions?.length) {
      index = await this.rebuildLeadIndex();
      if (!index.partitions.length) return [];
    }

    const shards = await Promise.all(index.partitions.map((part) => this.getJson<SavedLead[]>(leadShardKey(part.partition))));
    const leads = shards.flatMap((shard) => shard ?? []);

    const missing = index.partitions.filter((_, position) => !Array.isArray(shards[position]));
    if (missing.length) {
      // A referenced object is gone (deleted out-of-band, failed write, or a
      // manual restore). Drop those entries and rewrite the directory so the
      // next read is clean, but never drop the leads that do exist.
      const kept = index.partitions.filter((part) => !missing.some((gone) => gone.partition === part.partition));
      await this.putJson(leadShardKeyIndex(), {
        total: leads.length,
        partitions: kept,
        updatedAt: new Date().toISOString(),
      }).catch(() => null);
    }

    return leads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Rebuild the lead directory from the authoritative shard objects.
   *
   * Bounded: one LIST of `app-data/leads/` (at most 500 objects, and the design
   * uses 64 shards) plus one read per non-empty shard. Used automatically when
   * the index is missing, and exposed through `POST /api/leads/repair` so an
   * interrupted write can be repaired on demand without touching a database.
   */
  async rebuildLeadIndex(): Promise<LeadIndex> {
    const objects = await this.list(`${R2_PREFIX.appData}leads/`, 500);
    const shardObjects = objects.filter((object) => object.key.endsWith(".json") && !object.key.endsWith("index.json"));
    const partitions: LeadIndex["partitions"] = [];

    for (const object of shardObjects) {
      const match = /\/(\d+)\.json$/.exec(object.key);
      if (!match) continue;
      const shard = await this.getJson<SavedLead[]>(object.key);
      if (!Array.isArray(shard) || shard.length === 0) continue;
      partitions.push({
        partition: Number(match[1]),
        count: shard.length,
        updatedAt: object.uploaded ? new Date(object.uploaded).toISOString() : new Date().toISOString(),
      });
    }

    partitions.sort((a, b) => a.partition - b.partition);
    const index: LeadIndex = {
      total: partitions.reduce((sum, part) => sum + part.count, 0),
      partitions,
      updatedAt: new Date().toISOString(),
    };
    await this.putJson(leadShardKeyIndex(), index);
    return index;
  }

  async getLead(id: string): Promise<SavedLead | null> {
    const shard = await this.getJson<SavedLead[]>(leadShardKey(this.leadPartition(id)));
    return shard?.find((lead) => lead.id === id) ?? null;
  }

  async upsertLead(lead: SavedLead): Promise<SavedLead> {
    const partition = this.leadPartition(lead.id);
    const key = leadShardKey(partition);
    let stored: SavedLead = lead;
    await this.updateJson<SavedLead[]>(
      key,
      (current) => {
        const list = current ?? [];
        const index = list.findIndex((item) => item.id === lead.id);
        if (index === -1) {
          list.push(lead);
        } else {
          stored = { ...lead, savedAt: list[index].savedAt };
          list[index] = stored;
        }
        return list;
      },
      MAX_WRITE_RETRIES,
      { snapshot: true },
    );
    await this.updateJson<LeadIndex>(leadShardKeyIndex(), (current) => {
      const partitions = current?.partitions ? [...current.partitions] : [];
      const existing = partitions.findIndex((p) => p.partition === partition);
      const count = existing === -1 ? 1 : partitions[existing].count;
      const entry = { partition, count, updatedAt: new Date().toISOString() };
      if (existing === -1) partitions.push(entry);
      else partitions[existing] = entry;
      return { total: partitions.reduce((sum, p) => sum + p.count, 0), partitions, updatedAt: entry.updatedAt };
    });
    return stored;
  }

  async deleteLead(id: string): Promise<boolean> {
    const partition = this.leadPartition(id);
    let removed = false;
    await this.updateJson<SavedLead[]>(
      leadShardKey(partition),
      (current) => {
        const list = current ?? [];
        const next = list.filter((lead) => lead.id !== id);
        removed = next.length !== list.length;
        return next;
      },
      MAX_WRITE_RETRIES,
      { snapshot: true },
    );
    if (removed) {
      await this.updateJson<LeadIndex>(leadShardKeyIndex(), (current) => {
        const partitions = current?.partitions ?? [];
        return {
          total: Math.max(0, (current?.total ?? 1) - 1),
          partitions,
          updatedAt: new Date().toISOString(),
        };
      });
    }
    return removed;
  }

  async getSavedSearches(): Promise<SavedSearch[]> {
    return (await this.getJson<SavedSearch[]>(savedSearchesKey())) ?? [];
  }

  async mutateSavedSearches(mutate: (current: SavedSearch[]) => SavedSearch[]): Promise<SavedSearch[]> {
    return this.updateJson<SavedSearch[]>(savedSearchesKey(), (current) => mutate(current ?? []));
  }

  async getSettings(): Promise<UserSettings | null> {
    return this.getJson<UserSettings>(settingsKey());
  }

  async putSettings(settings: UserSettings): Promise<UserSettings> {
    await this.putJson(settingsKey(), settings);
    return settings;
  }

  async getActivity(): Promise<ActivityEntry[]> {
    return (await this.getJson<ActivityEntry[]>(activityKey())) ?? [];
  }

  async appendActivity(entry: ActivityEntry): Promise<void> {
    await this.updateJson<ActivityEntry[]>(activityKey(), (current) => [entry, ...(current ?? [])].slice(0, 80));
  }

  async putExport(meta: ExportIndexEntry, csv: string): Promise<void> {
    await this.putJson(exportMetaKey(meta.id), meta);
    await this.putCsv(exportObjectKey(meta.id), csv);
    await this.updateJson<ExportIndexEntry[]>(`app-data/exports/index.json`, (current) =>
      [meta, ...(current ?? [])].slice(0, 50),
    );
  }

  async listExports(): Promise<ExportIndexEntry[]> {
    return (await this.getJson<ExportIndexEntry[]>("app-data/exports/index.json")) ?? [];
  }

  async getExport(id: string): Promise<ExportIndexEntry | null> {
    return this.getJson<ExportIndexEntry>(exportMetaKey(id));
  }

  async getExportCsv(id: string): Promise<string | null> {
    return this.getText(exportObjectKey(id));
  }
}

function leadShardKeyIndex(): string {
  return "app-data/leads/index.json";
}

/** Bounded-concurrency map — keeps R2 read fan-out predictable. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
