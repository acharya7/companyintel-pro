/**
 * Shared shaping of R2 object metadata (runtime-neutral, no network).
 *
 * Two callers report object listings — the phase-A scripts (S3 API, which
 * returns `lastModified` strings) and the read-only probe Worker (native R2
 * binding, which returns `uploaded` Dates). Both must produce the same report
 * shape, and neither may invent a size: an unknown size stays `null` and is
 * printed as "unknown", never as 0.
 */

export interface ObjectSummary {
  key: string;
  /** `null` when the listing did not report a size. Never guessed. */
  size: number | null;
  /** ISO timestamp, or `null` when not reported. */
  lastModified: string | null;
  etag: string | null;
}

/** Loose input shape accepted from either the R2 binding or the S3 client. */
export interface ObjectLike {
  key: string;
  size?: number | null;
  uploaded?: Date | string | null;
  lastModified?: string | null;
  etag?: string | null;
}

function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

/** Normalize one listing entry from either API into the shared summary shape. */
export function summarizeObject(object: ObjectLike): ObjectSummary {
  return {
    key: String(object?.key ?? ""),
    size: typeof object?.size === "number" && Number.isFinite(object.size) ? object.size : null,
    lastModified: isoTimestamp(object?.lastModified ?? object?.uploaded ?? null),
    etag: object?.etag ? String(object.etag) : null,
  };
}

/** Human-readable byte size. `null`/`undefined`/negative means "not reported". */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit]}`;
}

/** True for an original source file under `raw/` (`.csv`, case-insensitive). */
export function isCsvKey(key: unknown): boolean {
  return /\.csv$/i.test(String(key ?? "").trim());
}

/** Largest first; objects with an unknown size sort last. */
export function sortBySizeDesc<T extends ObjectLike>(objects: readonly T[] | null | undefined): T[] {
  return [...(objects ?? [])].sort((a, b) => (b?.size ?? -1) - (a?.size ?? -1));
}

export interface RawListingPlan<T> {
  listed: T[];
  csvs: T[];
  others: T[];
  truncated: boolean;
  objectsRead: number;
}

/**
 * Bounded view of one `raw/` listing.
 *
 * Objects are ordered largest-first, so the two source files (10 GB and 50 GB)
 * are always inside even a 25-object bound when the prefix holds other objects.
 *
 * `objectsRead` is how many objects the bounded listing returned — not a bucket
 * total, which cannot be known without paginating. `truncated` therefore only
 * asserts that more objects exist than were read, and nothing more.
 */
export function planRawListing<T extends ObjectLike>(objects: readonly T[] | null | undefined, max = 25): RawListingPlan<T> {
  const ordered = sortBySizeDesc(objects);
  const listed = ordered.slice(0, Math.max(0, max));
  return {
    listed,
    csvs: listed.filter((object) => isCsvKey(object?.key)),
    others: listed.filter((object) => !isCsvKey(object?.key)),
    truncated: ordered.length > listed.length,
    objectsRead: ordered.length,
  };
}

/** Presence check for explicitly required keys. Missing keys stay missing. */
export function compareExpected<T extends ObjectLike>(
  expected: readonly string[] | null | undefined,
  objects: readonly T[] | null | undefined,
): { key: string; present: boolean; object: T | null }[] {
  const have = new Map((objects ?? []).map((object) => [object?.key, object]));
  return (expected ?? []).map((key) => ({ key, present: have.has(key), object: have.get(key) ?? null }));
}
