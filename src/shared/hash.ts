/**
 * Stable, runtime-neutral hashing helpers.
 *
 * The same company/contact must get the same id in the local indexer, in the
 * Cloudflare Worker and in the browser preview, so ids are derived with a
 * deterministic 64-bit FNV-1a hash rather than a random UUID.
 */

/** 128-bit-ish deterministic hash built from four FNV-1a passes with different seeds. */
export function stableHash(input: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = "";
  for (const seed of seeds) {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      // h *= 16777619, kept in 32-bit space
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

/** Company id, e.g. `c_3f0a91bb27cd4e10`. */
export function companyId(identityKey: string): string {
  return `c_${stableHash(identityKey).slice(0, 16)}`;
}

/** Contact id, e.g. `p_90ab77c31e0d5f42`. */
export function contactId(identityKey: string): string {
  return `p_${stableHash(identityKey).slice(0, 16)}`;
}

/** Lead id derived from kind + target so double-saves are idempotent. */
export function leadId(kind: "company" | "contact", targetId: string): string {
  return `l_${stableHash(`${kind}:${targetId}`).slice(0, 16)}`;
}

/**
 * Deterministic shard number for a key, used by the indexer and the Worker.
 *
 * This is `stableHash(key)`'s FIRST 32-bit pass reduced modulo `shardCount` — with
 * the other three passes and the hex round-trip removed. That round-trip was pure
 * overhead on the indexer's hottest call: `stableHash` formats four 8-hex-character
 * strings, and this function then took the first eight characters and parsed them
 * back into the number they already were. Pass 2 calls it dozens of times per
 * company (~1.2 M times for a 10,000-company corpus), so the allocations were worth
 * removing.
 *
 * The value is bit-for-bit identical to `parseInt(stableHash(key).slice(0, 8), 16) %
 * shardCount`; `tests/hash.test.ts` asserts that equivalence directly, because a
 * change here would move every posting to a different shard file and mis-split the
 * spool partitions of an existing Pass 1 run.
 */
export function shardOf(key: string, shardCount: number): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shardCount;
}
