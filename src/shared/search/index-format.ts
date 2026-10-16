/**
 * R2 index layout — the contract between the local indexer (writer) and the
 * Cloudflare Worker (reader).
 *
 * Bucket: `company-intel-data` (bound to the Worker as `COMPANY_DATA`).
 *
 *   raw/                  original CSV files, never modified by the app
 *   staging/<version>/    output that is not published yet
 *   indexes/<version>/…   exact / prefix / token / trigram shards + directory
 *   companies/<version>/… canonical company metadata partitions
 *   contacts/<version>/…  contact partitions, one per company range
 *   manifests/<version>/  manifest + validation report
 *   manifests/active.json pointer to the published version (single small object)
 *   app-data/             saved leads, saved searches, settings, exports
 *   backups/              periodic snapshots of app-data
 *
 * Rules that keep query cost predictable:
 *   - Objects are immutable once published; a new run writes a new version.
 *   - No directory listing at query time (except the dataset management page).
 *   - Shard count is fixed per version and recorded in the directory, so the
 *     Worker never guesses.
 *   - Every object is content-addressed by version, so the edge/browser caches
 *     can treat them as immutable.
 */

export const INDEX_FORMAT_VERSION = 2;

export const R2_PREFIX = {
  raw: "raw/",
  staging: "staging/",
  indexes: "indexes/",
  companies: "companies/",
  contacts: "contacts/",
  manifests: "manifests/",
  appData: "app-data/",
  backups: "backups/",
} as const;

/**
 * Shard counts and object sizes.
 *
 * Sized for a ≈10M-company index. A postings shard holds one term's ref list, so
 * its size is bounded by the term's document frequency; the counts below keep a
 * typical shard in the tens of KB. Profile partitions hold `companiesPerPartition`
 * records (~300 B each, gzip ≈ 20%) and are the only objects a company detail
 * page has to read.
 *
 * Why `companiesPerPartition` is small (250, not 2000):
 *
 * A search hydrates candidate companies by *partition*, so its byte cost is
 * `partitionsTouched × partitionBytes`, and a partition is read whole. With 2000
 * companies per object every hydrated candidate dragged ~2000 unneeded
 * neighbours into memory — measured on the real-data sample as 1.96 MB and 11
 * reads for a page of 25 (docs/architecture.md). At 250 companies per object a
 * partition is ~25 KB (26.8 KB measured on the 20 K real-data sample), so the hard
 * ceiling for one search is `maxHydrate × partitionBytes` ≈ 400 KB — and it no
 * longer grows with the
 * collection size, because the partition size is fixed while the number of
 * partitions is not. The price is more objects (4.7 M organizations → ~18.8 K
 * company objects) and a few more reads per query, which R2 charges ~$0.36 per
 * million of and can serve concurrently.
 *
 * Query cost model (see docs/architecture.md for the measured numbers):
 *   exact/alias search → 1 exact shard + 1 prefix shard + the candidate profile
 *                        partitions of confident matches only
 *   fuzzy search       → 1 exact (miss) + up to 6 prefix + up to 10 token +
 *                        up to 14 trigram shards, then ≤ maxHydrate profile parts
 */
export const SHARDING = {
  exactShards: 512,
  prefixShards: 256,
  tokenShards: 256,
  trigramShards: 512,
  /** companyId → document ref lookup (company detail pages). */
  idShards: 256,
  /** Companies per company/profile object (see the sizing note above). */
  companiesPerPartition: 250,
  /** Companies per contact object (contacts are grouped by company). */
  companiesPerContactPartition: 1000,
  /**
   * Hard ceiling on profile objects fetched to hydrate one search, counted
   * across every hydration batch of that search. Bounds bytes AND reads.
   */
  maxHydrate: 16,
  /** Upper bound on candidate docs sent to the scorer for one search. */
  maxScored: 400,
  /** Prefixes longer than this are truncated to this length before lookup. */
  maxPrefixLength: 12,
} as const;

export type IndexKind = "exact" | "prefix" | "token" | "trigram" | "ids" | "stats";

/** Shard count for a given index kind (recorded in the directory). */
export function shardCountFor(directory: { shards: Record<string, number> }, kind: Exclude<IndexKind, "stats">): number {
  return directory.shards[kind] ?? 1;
}

export function manifestKey(version: string): string {
  return `${R2_PREFIX.manifests}${version}/manifest.json`;
}

export function validationKey(version: string): string {
  return `${R2_PREFIX.manifests}${version}/validation.json`;
}

export function progressKey(version: string): string {
  return `${R2_PREFIX.manifests}${version}/progress.json`;
}

/** Pre-computed aggregate statistics used by the dashboard charts. */
export function statsKey(version: string): string {
  return `${R2_PREFIX.manifests}${version}/stats.json`;
}

/** The single mutable pointer object. Everything else is immutable. */
export function activeManifestKey(): string {
  return `${R2_PREFIX.manifests}active.json`;
}

export function indexShardKey(version: string, kind: IndexKind, shard: number): string {
  return `${R2_PREFIX.indexes}${version}/${kind}/${String(shard).padStart(4, "0")}.json.gz`;
}

export function indexDirectoryKey(version: string): string {
  return `${R2_PREFIX.indexes}${version}/directory.json`;
}

export function companyPartitionKey(version: string, partition: number): string {
  return `${R2_PREFIX.companies}${version}/${String(partition).padStart(5, "0")}.json.gz`;
}

export function contactPartitionKey(version: string, partition: number): string {
  return `${R2_PREFIX.contacts}${version}/${String(partition).padStart(5, "0")}.json.gz`;
}

/** Partition that holds a given global document reference. */
export function partitionOfRef(ref: number, perPartition = SHARDING.companiesPerPartition): number {
  return Math.floor(ref / perPartition);
}

/** Contact object that holds the contacts of a given company document ref. */
export function contactPartitionOfRef(ref: number): number {
  return Math.floor(ref / SHARDING.companiesPerContactPartition);
}

export function leadShardKey(partition: number): string {
  return `${R2_PREFIX.appData}leads/${String(partition).padStart(3, "0")}.json`;
}

export function savedSearchesKey(): string {
  return `${R2_PREFIX.appData}saved-searches.json`;
}

export function settingsKey(): string {
  return `${R2_PREFIX.appData}settings.json`;
}

export function activityKey(): string {
  return `${R2_PREFIX.appData}activity.json`;
}

export function exportObjectKey(exportId: string): string {
  return `${R2_PREFIX.appData}exports/${exportId}.csv`;
}

export function exportMetaKey(exportId: string): string {
  return `${R2_PREFIX.appData}exports/${exportId}.json`;
}

export function stagingKey(version: string, suffix: string): string {
  return `${R2_PREFIX.staging}${version}/${suffix}`;
}

export function backupKey(stamp: string): string {
  return `${R2_PREFIX.backups}app-data/${stamp}.json`;
}

/**
 * Recovery snapshot key for one app-data object: at most one snapshot per
 * object per day, so snapshot growth is bounded by (partitions × days).
 *
 *   app-data/leads/012.json → backups/app-data/2026-10-15/leads-012.json
 */
export function snapshotKey(stamp: string, appDataKey: string): string {
  const label = appDataKey.replace(R2_PREFIX.appData, "").replace(/\.json$/, "").replace(/\//g, "-");
  return `${R2_PREFIX.backups}app-data/${stamp}/${label}.json`;
}

/**
 * Directory object read once per dataset version by the Worker (then cached in
 * memory / at the edge). It tells the reader where every shard lives and what
 * the index contains, without any listing operation.
 */
export interface IndexDirectory {
  formatVersion: number;
  normalizerVersion: number;
  version: string;
  createdAt: string;
  shards: {
    exact: number;
    prefix: number;
    token: number;
    trigram: number;
    ids: number;
    companyPartitions: number;
    contactPartitions: number;
  };
  counts: {
    companies: number;
    contacts: number;
    /** Doc refs available per shard are derivable; kept for diagnostics. */
    indexedAliases: number;
  };
  /** Which source ids contributed rows, so the UI can prove both were indexed. */
  sources: string[];
  /** Bytes of every generated object, for the dataset page. */
  bytes: {
    indexes: number;
    companies: number;
    contacts: number;
    total: number;
  };
  /** Top terms per shard live in the shard payloads; df stats are global. */
  fields: {
    company: string[];
    contact: string[];
  };
}

/**
 * One term's postings inside a shard object.
 *
 * `refs` are global document references (stable within an index version).
 * `q` is a pre-computed 0..255 prominence/quality score per ref, used to
 * pre-rank candidates BEFORE any profile object is fetched — this is what keeps
 * fuzzy queries from hydrating hundreds of dispersed records.
 */
export interface Postings {
  refs: number[];
  q?: number[];
  /** Document frequency of the term, so the reader can prefer rare terms. */
  df?: number;
}

/** Shard payload: term → postings (terms are the shard's own key space). */
export interface ShardPayload {
  terms: Record<string, Postings>;
}

/**
 * Postings for one term, or `undefined` when the term is not in this shard.
 *
 * Own-property lookup is mandatory here, and this helper is the single place it
 * happens. A shard payload arrives from `JSON.parse`, so its `terms` object has
 * `Object.prototype` behind it: `terms["constructor"]` (a company really can be
 * called "Constructor", and any query term reaches this code) returns the
 * inherited `Object` constructor — truthy, but with no `refs`/`q`, which crashed
 * both the indexer's finalize step and, at query time, the Worker.
 */
export function postingsFor(payload: ShardPayload | null | undefined, term: string): Postings | undefined {
  const terms = payload?.terms;
  if (!terms || !Object.prototype.hasOwnProperty.call(terms, term)) return undefined;
  return terms[term];
}

/** Company profile partition (also used to hydrate search candidates). */
export interface CompanyPartitionPayload {
  /** Global ref of the first record in this object. */
  firstRef: number;
  companies: unknown[];
}

/** Contact partition: contacts grouped by company ref. */
export interface ContactPartitionPayload {
  firstRef: number;
  /** companyRef → contacts (sorted by company ref inside the object). */
  byCompany: Record<string, unknown[]>;
}

/**
 * Contacts of one company ref, or `undefined`.
 *
 * The keys are numeric strings so an inherited property is unlikely, but the
 * payload is `JSON.parse`d data and `Object.prototype` has numeric-looking
 * members on some engines, so the same own-property rule applies.
 */
export function contactsFor(payload: ContactPartitionPayload | null | undefined, ref: number): unknown[] | undefined {
  const byCompany = payload?.byCompany;
  const key = String(ref);
  if (!byCompany || !Object.prototype.hasOwnProperty.call(byCompany, key)) return undefined;
  return byCompany[key];
}

/**
 * Relative object path for one generated artefact.
 *
 * The indexer writes into a local output directory using these exact keys, then
 * uploads each file to the identical key in R2 — so a local validation run and
 * the uploaded layout can never drift apart.
 */
export function folderFor(kind: "companies" | "contacts" | "indexes", version: string, suffix: string | number): string {
  if (kind === "companies") return companyPartitionKey(version, Number(suffix));
  if (kind === "contacts") return contactPartitionKey(version, Number(suffix));
  const value = String(suffix);
  return `${R2_PREFIX.indexes}${version}/${value.endsWith(".json") ? `${value}.gz` : value}`;
}

/**
 * Quality score packed into a single byte: heavier contact coverage and shorter
 * names win, matching the engine's tie-break behaviour at zero query cost.
 */
export function qualityByte(contactCount: number, nameLength: number): number {
  const coverage = Math.min(200, Math.round(20 * Math.log2(1 + Math.max(0, contactCount))));
  const brevity = Math.max(0, 30 - Math.min(30, nameLength));
  return Math.max(0, Math.min(255, coverage + brevity));
}
