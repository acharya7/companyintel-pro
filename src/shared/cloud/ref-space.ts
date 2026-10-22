/**
 * Partition-independent document reference space.
 *
 * Why this exists
 *   The merge assigns one document ref per company. With a single sequential merge
 *   that ref is a running counter (`globalRef`), which is exactly what makes 256
 *   independent merges impossible: two workers would assign overlapping refs and
 *   write into each other's objects. The fix is to give every spool partition its
 *   own non-overlapping slice of the ref space, so a partition can be merged by any
 *   container at any time and still produce the same refs a sequential run would
 *   have produced for it.
 *
 * Why the alignment is 1000 and not 1,000,000
 *   The reader derives object keys from a ref with integer division:
 *
 *     company object  = floor(ref / 250)    (`partitionOfRef`)
 *     contact object  = floor(ref / 1000)   (`contactPartitionOfRef`)
 *
 *   A partition's base must therefore be a multiple of both 250 and 1000, or its
 *   first company would share an object with the previous partition's last company —
 *   two writers, one key. 1000 is the least common multiple, and 1,000,000 is a
 *   perfectly good multiple of it: both are safe. What is NOT safe is assuming a
 *   fixed stride is big enough. A name-hashed partition of a 128M-row corpus averages
 *   ~500k rows and can exceed 1M under skew; a fixed 1,000,000 stride would then
 *   silently run into the next partition's refs.
 *
 * The allocation scheme
 *   `planRefBases` allocates each partition a capacity derived from its own row
 *   count (an upper bound on its companies, since every company needs at least one
 *   row), rounded up to the alignment:
 *
 *     capacity_i = roundUp(ceil(rows_i / 250) * 250, 1000)
 *     base_0     = 0
 *     base_i     = base_(i-1) + capacity_(i-1)
 *
 *   Every base is aligned, every capacity is a bound computed from data the Pass 1
 *   checkpoints already hold (no extra R2 read), and the allocation is a pure
 *   function of the partition row counts — so a retried partition task computes the
 *   identical base. There is no silent overflow: `assertPartitionFits` fails loudly
 *   if a merge ever produces more refs than its partition was allocated.
 */

import { SHARDING } from "../search/index-format";

/** Object alignment: lcm(SHARDING.companiesPerPartition, 1000) = lcm(250, 1000). */
export const REF_ALIGNMENT = 1000;

/** Companies per company object; mirrors `SHARDING.companiesPerPartition`. */
const COMPANIES_PER_OBJECT = SHARDING.companiesPerPartition;
/** Refs per contact object; mirrors the reader's contact grouping. */
const COMPANIES_PER_CONTACT_OBJECT = 1000;

export interface RefAllocation {
  /** First ref of each partition, aligned to `REF_ALIGNMENT`. */
  bases: number[];
  /** Capacity reserved for each partition (a multiple of `REF_ALIGNMENT`). */
  capacities: number[];
  /** Total refs reserved across all partitions. */
  total: number;
}

/** Round `value` up to the next multiple of `REF_ALIGNMENT`. */
export function alignRef(value: number): number {
  return Math.ceil(value / REF_ALIGNMENT) * REF_ALIGNMENT;
}

/**
 * Allocate non-overlapping ref ranges for spool partitions.
 *
 * `rowsByPartition[i]` is the row count the Pass 1 checkpoint/manifest records for
 * spool partition `i` (physical rows, header already excluded). A partition with no
 * rows still receives one aligned slot, so the mapping from partition to base does
 * not depend on which partitions happened to be empty.
 */
export function planRefBases(rowsByPartition: readonly number[]): RefAllocation {
  const bases: number[] = [];
  const capacities: number[] = [];
  let next = 0;
  for (const rows of rowsByPartition) {
    const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
    // Every company needs at least one row, so `rows` bounds the company count.
    const capacity = alignRef(Math.max(REF_ALIGNMENT, Math.ceil(safeRows / COMPANIES_PER_OBJECT) * COMPANIES_PER_OBJECT));
    bases.push(next);
    capacities.push(capacity);
    next += capacity;
  }
  assertSafeRange(next, rowsByPartition.length);
  return { bases, capacities, total: next };
}

/**
 * Fail loudly rather than silently wrapping or losing precision.
 *
 * `Number.MAX_SAFE_INTEGER` is ~9.007e15; the real corpus needs ~1.3e8 refs, so this
 * is a guard against a corrupted manifest, not a limit anyone will meet.
 */
export function assertSafeRange(totalRefs: number, partitions: number): void {
  if (!Number.isSafeInteger(totalRefs) || totalRefs < 0) {
    throw new Error(`Ref allocation is not a safe integer (${totalRefs}) for ${partitions} partition(s).`);
  }
  if (totalRefs > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Ref allocation ${totalRefs} exceeds Number.MAX_SAFE_INTEGER.`);
  }
}

/**
 * Objects a partition's refs can occupy.
 *
 * The ranges are disjoint from every other partition's because bases are aligned:
 * the first company object of partition `i` starts exactly at `base_i / 250`, which
 * is never the object holding partition `i-1`'s last company (its capacity is a
 * multiple of 250 too).
 */
export function objectRangeForPartition(
  allocation: RefAllocation,
  partition: number,
): { companyObjects: { first: number; lastExclusive: number }; contactObjects: { first: number; lastExclusive: number } } {
  const base = allocation.bases[partition];
  const capacity = allocation.capacities[partition];
  if (base === undefined || capacity === undefined) {
    throw new Error(`Partition ${partition} is outside the allocation (${allocation.bases.length} partitions).`);
  }
  const firstCompany = base / COMPANIES_PER_OBJECT;
  const firstContact = base / COMPANIES_PER_CONTACT_OBJECT;
  return {
    companyObjects: { first: firstCompany, lastExclusive: firstCompany + capacity / COMPANIES_PER_OBJECT },
    contactObjects: { first: firstContact, lastExclusive: firstContact + capacity / COMPANIES_PER_CONTACT_OBJECT },
  };
}

/**
 * Called by a partition merge before it writes anything.
 *
 * `companies` is what the partition actually produced, which is only known after
 * merging it. A `false` result — never an exception — lets the caller fail the task
 * with a precise message, so the coordinator parks it for an operator instead of
 * writing refs that belong to the next partition.
 */
export function partitionFits(allocation: RefAllocation, partition: number, companies: number): boolean {
  const capacity = allocation.capacities[partition];
  if (capacity === undefined) return false;
  if (!Number.isInteger(companies) || companies < 0) return false;
  return companies <= capacity;
}

/** Human-readable description used in task failures and the panel. */
export function describeAllocation(allocation: RefAllocation): string {
  return (
    `${allocation.bases.length} partition(s), ${allocation.total.toLocaleString()} refs reserved, ` +
    `alignment ${REF_ALIGNMENT}, largest capacity ${Math.max(0, ...allocation.capacities).toLocaleString()}`
  );
}
