/**
 * The reference-space allocator is the precondition for 256 independent merges: if two
 * partitions can share a ref (or an object boundary), concurrent workers would write
 * overlapping objects and the index would be silently corrupt. These tests check the
 * arithmetic rather than a run: alignment, disjointness under skew, the object-index
 * mapping the reader actually uses, and the failure path when a partition outgrows its
 * allocation.
 */

import { describe, expect, test } from "bun:test";

import { SHARDING, contactPartitionOfRef, partitionOfRef } from "../src/shared/search/index-format";
import {
  REF_ALIGNMENT,
  alignRef,
  describeAllocation,
  objectRangeForPartition,
  partitionFits,
  planRefBases,
} from "../tools/indexer/src/ref-space";

describe("ref-space alignment", () => {
  test("bases and capacities are multiples of the alignment the reader divides by", () => {
    const allocation = planRefBases([10, 5_000, 250_000, 1_500_000]);
    for (const [index, base] of allocation.bases.entries()) {
      expect(base % REF_ALIGNMENT).toBe(0);
      // The two divisions the reader performs must both land on an object edge.
      expect(base % SHARDING.companiesPerPartition).toBe(0);
      expect(base % 1000).toBe(0);
      expect(allocation.capacities[index]! % REF_ALIGNMENT).toBe(0);
    }
    expect(allocation.bases[0]).toBe(0);
    expect(alignRef(1)).toBe(REF_ALIGNMENT);
    expect(alignRef(REF_ALIGNMENT)).toBe(REF_ALIGNMENT);
    expect(alignRef(REF_ALIGNMENT + 1)).toBe(2 * REF_ALIGNMENT);
  });

  test("a partition larger than the default 1,000,000 stride still gets its own range", () => {
    // 1.5M rows means at most 1.5M companies: a fixed 1e6 stride would overlap.
    const allocation = planRefBases([1_500_000, 1_500_000]);
    expect(allocation.capacities[0]).toBeGreaterThanOrEqual(1_500_000);
    expect(allocation.bases[1]).toBe(allocation.capacities[0]!);
    expect(allocation.bases[1]).toBeGreaterThanOrEqual(1_500_000);
    // Both partitions fit inside their own capacity.
    expect(partitionFits(allocation, 0, 1_500_000)).toBe(true);
    expect(partitionFits(allocation, 1, 1_500_000)).toBe(true);
    // And one company more than capacity is rejected rather than written.
    expect(partitionFits(allocation, 0, allocation.capacities[0]! + 1)).toBe(false);
  });

  test("object ranges never overlap, including across a skewed partition", () => {
    const allocation = planRefBases([500_000, 40_000_000, 3, 900_000, 0]);
    const ranges = allocation.bases.map((_, partition) => objectRangeForPartition(allocation, partition));
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]!;
      const current = ranges[index]!;
      expect(current.companyObjects.first).toBeGreaterThanOrEqual(previous.companyObjects.lastExclusive);
      expect(current.contactObjects.first).toBeGreaterThanOrEqual(previous.contactObjects.lastExclusive);
    }
    // The last object a partition can touch is exactly the boundary the next one starts at.
    expect(ranges[1]!.companyObjects.first).toBe(allocation.bases[1]! / SHARDING.companiesPerPartition);
    expect(ranges[1]!.contactObjects.first).toBe(allocation.bases[1]! / 1000);
  });

  test("every ref a partition can emit maps to that partition's own object range", () => {
    const allocation = planRefBases([2_500, 7_500]);
    for (const partition of [0, 1]) {
      const range = objectRangeForPartition(allocation, partition);
      const base = allocation.bases[partition]!;
      const capacity = allocation.capacities[partition]!;
      for (const local of [0, 1, 249, 250, capacity - 1]) {
        const ref = base + local;
        expect(partitionOfRef(ref)).toBeGreaterThanOrEqual(range.companyObjects.first);
        expect(partitionOfRef(ref)).toBeLessThan(range.companyObjects.lastExclusive);
        expect(contactPartitionOfRef(ref)).toBeGreaterThanOrEqual(range.contactObjects.first);
        expect(contactPartitionOfRef(ref)).toBeLessThan(range.contactObjects.lastExclusive);
      }
    }
  });

  test("the allocation is deterministic and independent of when it is computed", () => {
    const rows = [12_345, 987, 4_400_000, 1];
    expect(planRefBases(rows)).toEqual(planRefBases(rows));
    expect(planRefBases([])).toEqual({ bases: [], capacities: [], total: 0 });
    // Negative/NaN inputs cannot produce a negative base.
    const guarded = planRefBases([-5, Number.NaN, 0]);
    expect(guarded.bases).toEqual([0, REF_ALIGNMENT, 2 * REF_ALIGNMENT]);
  });

  test("a corrupted manifest cannot produce an unsafe or wrapped range", () => {
    expect(() => planRefBases([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toThrow();
  });

  test("the description names the reservation an operator would need to see", () => {
    const allocation = planRefBases([1_000, 1_000]);
    const text = describeAllocation(allocation);
    expect(text).toContain("2 partition(s)");
    expect(text).toContain(`alignment ${REF_ALIGNMENT}`);
  });
});
