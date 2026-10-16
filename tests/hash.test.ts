/**
 * `shardOf` and the id hashes must not move.
 *
 * `shardOf` decides two recorded facts:
 *
 *   - which spool partition a company lands in (`partitionFor` in the indexer's
 *     mapping), and `spool-manifest.json` records that partition number — if the
 *     hash changed, an existing Pass 1 spool would be read as if its rows belonged
 *     somewhere else, so a company and the contact rows that name it could stop
 *     meeting in the same partition;
 *   - which index shard a posting goes to, and the Worker looks postings up by
 *     computing the same number for a query term.
 *
 * The implementation was optimized (the hex round-trip through `stableHash` is gone)
 * but the VALUE is unchanged, and the equivalence assertion below is the whole
 * guarantee: `shardOf(key, n)` is exactly `stableHash(key)`'s first 32-bit pass
 * reduced modulo `n`.
 */

import { describe, expect, test } from "bun:test";

import { companyId, contactId, leadId, shardOf, stableHash } from "../src/shared/hash";

/**
 * Keys chosen for the shapes real data has: empty, very short, normalized company
 * names (the real values, so the numbers below are the ones a real spool recorded),
 * long names, a non-ASCII name, a name containing U+2028 (the separator that broke
 * pass 2), and a couple of contact/lead identifiers.
 */
const KEYS = [
  "",
  "a",
  "n:acme",
  "n:microsoft",
  "d:microsoft.com",
  "n:tata consultancy services limited",
  "l:linkedin.com/company/acme",
  "n:globex\u2028holdings",
  "n:müller gmbh",
  "s:csv1:1234567890",
  `n:${"very long company name ".repeat(30)}`,
  "constructor",
  "e:ada@acme.example",
  "p_90ab77c31e0d5f42",
];

const SHARD_COUNTS = [1, 2, 4, 8, 16, 64, 256, 512, 2048];

describe("shardOf", () => {
  test("is exactly stableHash's first pass, modulo the shard count", () => {
    for (const key of KEYS) {
      const expected = parseInt(stableHash(key).slice(0, 8), 16);
      for (const count of SHARD_COUNTS) {
        expect(shardOf(key, count)).toBe(expected % count);
      }
    }
  });

  test("is stable across calls and always inside the shard range", () => {
    for (const key of KEYS) {
      const first = shardOf(key, 256);
      expect(shardOf(key, 256)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(256);
    }
  });

  test("assigns the shards an existing Pass 1 spool already recorded", () => {
    // Golden values: the partition/shard numbers the real corpus produces today. A
    // change to the hash would move every row of a preserved spool to a different
    // partition file and must be a deliberate, documented migration instead.
    expect(shardOf("d:microsoft.com", 256)).toBe(38);
    expect(shardOf("n:tata consultancy services", 256)).toBe(6);
    expect(shardOf("l:linkedin.com/company/acme", 256)).toBe(85);
    expect(shardOf("e:ada@acme.example", 512)).toBe(296);
  });
});

describe("document identifiers", () => {
  test("are derived deterministically and stay stable", () => {
    expect(companyId("d:microsoft.com")).toBe("c_5186f026d7931e60");
    expect(companyId("n:tata consultancy services")).toBe("c_afbb000648e60b64");
    expect(contactId("c_abc|ada@acme.example")).toBe("p_e3534711702be2ff");
    expect(leadId("company", "c_abc")).toBe("l_afa01d3ca6951b86");
    // Same input, same id; different input, different id.
    expect(companyId("d:microsoft.com")).toBe(companyId("d:microsoft.com"));
    expect(companyId("d:microsoft.com")).not.toBe(companyId("d:microsoft.com."));
  });
});
