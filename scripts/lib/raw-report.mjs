/**
 * Pure helpers shared by the read-only R2 verification scripts.
 *
 * Nothing here talks to the network, reads credentials, or writes anything: these
 * functions only shape and sanity-check what R2 returned, so they can be unit
 * tested without a bucket (`tests/raw-report.test.ts`). The scripts are the only
 * callers.
 *
 * Two rules are deliberate and load-bearing:
 *   1. An unknown size is reported as unknown — never as 0, and never guessed.
 *   2. A truncated sample is trimmed back to the last COMPLETE record, so a schema
 *      report can never be computed from half a quoted, multiline row.
 */

/** Human-readable byte size. `null`/`undefined`/negative means "not reported". */
export function formatBytes(bytes) {
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
export function isCsvKey(key) {
  return /\.csv$/i.test(String(key ?? "").trim());
}

/** Largest first; objects with an unknown size sort last. */
export function sortBySizeDesc(objects) {
  return [...(objects ?? [])].sort((a, b) => (b?.size ?? -1) - (a?.size ?? -1));
}

/**
 * Bounded view of one `raw/` LIST result.
 *
 * Objects are ordered largest-first, so the two source files (10 GB and 50 GB)
 * are always inside even a 25-object bound when the prefix holds other objects.
 *
 * `objectsRead` is how many objects the ONE bounded LIST returned — not a bucket
 * total, which cannot be known without paginating. `truncated` therefore only
 * asserts that more objects exist than were read, and nothing more.
 */
export function planRawListing(objects, max = 25) {
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
export function compareExpected(expected, objects) {
  const have = new Map((objects ?? []).map((object) => [object?.key, object]));
  return (expected ?? []).map((key) => ({ key, present: have.has(key), object: have.get(key) ?? null }));
}

/** Number of `"` characters. Escaped quotes are doubled, so parity is preserved. */
export function quoteCount(text) {
  let count = 0;
  for (const character of String(text ?? "")) {
    if (character === '"') count += 1;
  }
  return count;
}

/**
 * Trim a byte-range sample back to the last complete CSV record.
 *
 * Slicing at the final newline is not enough: if the range ends inside a quoted
 * field that spans lines, the last "line" is half a record and the quote in it is
 * unbalanced. Complete records always contain an even number of quotes, so an odd
 * count means "drop that line and check again" (bounded, so a pathological sample
 * cannot loop forever).
 */
export function truncateAtRecordBoundary(text, maxDrops = 50) {
  let candidate = String(text ?? "");
  for (let drop = 0; drop <= maxDrops; drop += 1) {
    const lastNewline = candidate.lastIndexOf("\n");
    if (lastNewline < 0) return ""; // no complete record in this sample
    const complete = candidate.slice(0, lastNewline + 1);
    if (quoteCount(complete) % 2 === 0) return complete;
    candidate = candidate.slice(0, lastNewline);
  }
  return "";
}
