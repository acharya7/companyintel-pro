/**
 * One parallel partition-merge task (Cloud Component 1).
 *
 * This is the cloud counterpart of `runPartitionMerge`: it loads the verified Pass 1
 * spool from R2, merges exactly ONE spool partition at its allocated `refBase`, writes
 * that partition's projection/detail objects and its partition-tagged posting parts,
 * and stops before FINALIZE. It never writes a shared index shard, never writes
 * `state.json` and never activates anything.
 *
 * Isolation is structural, not conventional:
 *   - the ref base is aligned (see `ref-space.ts`), so the object indices this task
 *     writes cannot belong to another partition;
 *   - posting parts are keyed `pass2/parts/<kind>/<shard>/p-<partition>-<batch>`, so 256
 *     containers writing the same shard for different partitions cannot collide;
 *   - the result is written to `partitions/<n>.json` with the exact object list, which
 *     is what shard assembly and the manifest commit read.
 *
 * Retry safety: every output key is derived from (version, partition, object/batch), so
 * a retried task overwrites its own bytes and nothing else. The result object is
 * written last, which is the completion marker the coordinator waits for.
 */

import { createHash } from "node:crypto";

import { cloudKeys } from "../../src/shared/cloud/types";
import type { IndexingCounters } from "../../src/shared/models";
import {
  objectRangeForPartition,
  partitionFits,
  planRefBases,
  type RefAllocation,
} from "../indexer/src/ref-space";
import type { IndexerConfig } from "../indexer/src/build";

import { runCloudPass2 } from "./pass2";
import type { BlobStore } from "./store";

export interface PartitionTaskOptions {
  store: BlobStore;
  version: string;
  config: IndexerConfig;
  /** Spool partition to merge (0..partitions-1). */
  partition: number;
  /** First document ref of this partition, from `planRefBases`. */
  refBase: number;
  /**
   * Rows of every spool partition, in partition order.
   *
   * Used to allocate the ref space identically to the plan. When omitted the run falls
   * back to the single partition's own checkpoint row count, which is enough to check
   * the cap but not to derive the base.
   */
  rowsByPartition?: number[];
  /**
   * Capacity the coordinator allocated to this partition (from the plan).
   *
   * The swarm sends it with the task so the container can enforce the cap WITHOUT
   * re-reading every partition's manifests: a merge that outgrew its slice must fail
   * before publishing refs that belong to its neighbour.
   */
  refCapacity?: number;
  /** Local scratch directory for one partition at a time. */
  workDir: string;
  onLog?: (line: string) => void;
  diskFloorBytes?: number;
}

export interface PartitionTaskResult {
  version: string;
  partition: number;
  refBase: number;
  capacity: number;
  rows: number;
  companies: number;
  contacts: number;
  /** Highest ref used + 1: the next partition must start at or above this. */
  nextRef: number;
  firstCompanyObject: number;
  lastCompanyObjectExclusive: number;
  shardParts: number;
  objects: { key: string; bytes: number }[];
  objectBytes: number;
  /**
   * This partition's counters, aggregated by the finalize phase.
   *
   * Partition-scoped on purpose: `rowsRead` is the rows of THIS partition, and
   * `perSource` is what it read from each source. The coordinator sums them to the
   * corpus totals — which is the only way coverage can be reconciled when 256
   * tasks each see a slice.
   */
  counters: IndexingCounters;
  /** Facet distributions, merged by finalize into `manifests/<v>/stats.json`. */
  companyStats: {
    byIndustry: [string, number][];
    byCountry: [string, number][];
    bySize: [string, number][];
  };
  contactStats: {
    byDesignation: [string, number][];
    byDepartment: [string, number][];
    bySeniority: [string, number][];
  };
  coverage: { email: number; linkedin: number; phone: number; neither: number };
  /** Projection/detail objects this partition wrote, by kind. */
  objectCounts: { companyProjections: number; companyDetails: number; contactProjections: number; contactDetails: number; unassigned: number };
  completedAt: string;
  /** Content hash of the object list, so the manifest commit can prove it saw this. */
  digest: string;
}

export async function runPartitionTask(options: PartitionTaskOptions): Promise<PartitionTaskResult> {
  const { store, version, partition } = options;
  if (!Number.isInteger(partition) || partition < 0) throw new Error(`partition must be a non-negative integer (got ${partition}).`);
  if (!Number.isInteger(options.refBase) || options.refBase < 0) throw new Error(`refBase must be a non-negative integer (got ${options.refBase}).`);

  // Allocate the same way the coordinator did. The base must agree with the plan: a
  // mismatch would write this partition's companies into another partition's objects.
  let allocation: RefAllocation | null = null;
  if (options.rowsByPartition) {
    allocation = planRefBases(options.rowsByPartition);
    const expected = allocation.bases[partition];
    if (expected === undefined) throw new Error(`Partition ${partition} is outside the allocation (${allocation.bases.length} partitions).`);
    if (expected !== options.refBase) {
      throw new Error(
        `Ref base mismatch for partition ${partition}: the plan allocates ${expected}, the task was given ${options.refBase}. ` +
          "Refusing to merge into a range this partition does not own.",
      );
    }
  }
  /*
   * A ref base must be aligned to 1000: the reader derives object keys with
   * `floor(ref/250)` (companies) and `floor(ref/1000)` (contacts), so an unaligned base
   * would put this partition's first company in an object another partition owns.
   */
  if (options.refBase % 1000 !== 0) {
    throw new Error(
      `Ref base ${options.refBase} for partition ${partition} is not aligned to 1000; its refs would share an object with another partition.`,
    );
  }
  const capacity = allocation?.capacities[partition] ?? options.refCapacity ?? Number.POSITIVE_INFINITY;
  if (options.refCapacity !== undefined && options.refCapacity <= 0) {
    throw new Error(`refCapacity must be a positive number of refs (got ${options.refCapacity}).`);
  }
  if (allocation && options.refCapacity !== undefined && options.refCapacity !== capacity) {
    throw new Error(
      `Partition ${partition} was given capacity ${options.refCapacity}, but the plan allocates ${capacity}. Refusing to merge against a disagreement.`,
    );
  }

  const result = await runCloudPass2({
    store,
    version,
    config: options.config,
    workDir: options.workDir,
    onlyPartition: partition,
    refBase: options.refBase,
    mergeOnly: true,
    ...(options.diskFloorBytes !== undefined ? { diskFloorBytes: options.diskFloorBytes } : {}),
    onLog: options.onLog,
  });
  const snapshot = result.mergeOnly;
  if (!snapshot) {
    throw new Error(
      `Partition ${partition} did not produce a merge-only snapshot (stopped: ${result.stopped}). ` +
        "A partition task must never reach finalize; check that mergeOnly was honoured.",
    );
  }

  // The cap is the collision guard: a partition that outgrew its allocation must fail
  // loudly rather than write refs that belong to the next partition.
  if (!partitionFits({ bases: [options.refBase], capacities: [capacity], total: 0 }, 0, snapshot.counters.uniqueCompanies)) {
    throw new Error(
      `Partition ${partition} produced ${snapshot.counters.uniqueCompanies.toLocaleString()} companies, ` +
        `more than its allocated ${capacity.toLocaleString()} refs. Re-plan with fresh row counts; nothing was activated.`,
    );
  }
  /*
   * The refs this partition consumed: one per company, assigned sequentially from the
   * base. `snapshot.counters.uniqueCompanies` is the authoritative count (a ref is
   * consumed exactly once per company), so it — not a mirrored counter — is what the
   * allocation check and the next partition's base are derived from.
   */
  const nextRef = options.refBase + snapshot.counters.uniqueCompanies;
  if (nextRef > options.refBase + capacity) {
    throw new Error(
      `Partition ${partition} reached ref ${nextRef}, past its allocation ` +
        `[${options.refBase}, ${options.refBase + capacity}). Refusing to publish its objects.`,
    );
  }

  const objects = snapshot.objects
    .filter((object) => object.key.startsWith("companies/") || object.key.startsWith("contacts/") || object.key.startsWith("details/") || object.key.startsWith("unassigned/"))
    .map((object) => ({ key: object.key, bytes: object.bytes }));
  // A partition task must not have produced a final index shard: that would mean the
  // run reached finalize and 256 tasks would fight over the same shared objects.
  const shards = snapshot.objects.filter((object) => object.key.startsWith("indexes/"));
  if (shards.length) {
    throw new Error(`Partition ${partition} wrote ${shards.length} final index object(s); a merge-only task must not. Nothing was published.`);
  }

  const objectBytes = objects.reduce((total, object) => total + object.bytes, 0);
  const ranges = allocation ? objectRangeForPartition(allocation, partition) : null;
  const digest = createHash("sha256")
    .update(objects.map((object) => `${object.key}:${object.bytes}`).join("\n"))
    .digest("hex");

  const countOf = (prefix: string) => objects.filter((object) => object.key.startsWith(prefix)).length;
  const task: PartitionTaskResult = {
    version,
    partition,
    refBase: options.refBase,
    capacity,
    rows: snapshot.counters.rowsRead,
    companies: snapshot.counters.uniqueCompanies,
    contacts: snapshot.counters.uniqueContacts,
    counters: snapshot.counters,
    companyStats: {
      byIndustry: snapshot.companyStats.byIndustry,
      byCountry: snapshot.companyStats.byCountry,
      bySize: snapshot.companyStats.bySize,
    },
    contactStats: {
      byDesignation: snapshot.contactStats.byDesignation,
      byDepartment: snapshot.contactStats.byDepartment,
      bySeniority: snapshot.contactStats.bySeniority,
    },
    coverage: snapshot.coverage,
    // Object keys are `<kind>/<version>/…`, so the version is part of every prefix:
    // `details/companies/` would count nothing and make the directory claim a
    // projection split that has no detail half.
    objectCounts: {
      companyProjections: countOf("companies/"),
      companyDetails: countOf(`details/${version}/companies/`),
      contactProjections: countOf("contacts/"),
      contactDetails: countOf(`details/${version}/contacts/`),
      unassigned: countOf("unassigned/"),
    },
    nextRef,
    firstCompanyObject: ranges?.companyObjects.first ?? Math.floor(options.refBase / 250),
    lastCompanyObjectExclusive: ranges?.companyObjects.lastExclusive ?? Number.POSITIVE_INFINITY,
    shardParts: result.shardParts,
    objects,
    objectBytes,
    completedAt: new Date().toISOString(),
    digest,
  };

  // Written LAST: this object is the task's completion marker.
  await store.putJson(partitionResultKey(version, partition), task);
  return task;
}

/** Durable per-partition result, read by shard assembly and the manifest commit. */
export function partitionResultKey(version: string, partition: number): string {
  return `${cloudKeys.jobRoot(version)}/partitions/${String(partition).padStart(4, "0")}.json`;
}

/** Posting-part prefix a partition writes under (mirrors `pass2.ts`). */
export function partitionPartPrefix(version: string, kind: string, shard: number): string {
  return `${cloudKeys.jobRoot(version)}/pass2/parts/${kind}/${String(shard).padStart(4, "0")}/`;
}
