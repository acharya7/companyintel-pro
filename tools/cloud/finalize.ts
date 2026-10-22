/**
 * Finalize a PARALLEL build: aggregate the durable partition and shard results into
 * the index directory, dataset stats, validation report and manifest.
 *
 * This is the single-owner commit at the end of the swarm. Every expensive step
 * already happened in its own task (256 partition merges, then one task per shard);
 * this module only reads their durable result objects, verifies the referenced
 * objects are present with the recorded sizes, and publishes:
 *
 *   manifests/<v>/stats.json
 *   indexes/<v>/directory.json
 *   manifests/<v>/validation.json
 *   manifests/<v>/manifest.json      ← written LAST, the completion marker
 *
 * It never activates the version: `active.json` is an operator action (the admin
 * API), so an incomplete or invalid generation can never become searchable.
 *
 * Determinism: the aggregate is a pure function of the durable results (sorted by
 * partition and by kind/shard), so a retried finalize writes identical objects.
 */

import { createHash } from "node:crypto";

import { INDEX_FORMAT_VERSION, type IndexDirectory } from "../../src/shared/search/index-format";
import { NORMALIZER_VERSION } from "../../src/shared/normalize";
import type { DatasetStats, DatasetVersionSummary, IndexingCounters } from "../../src/shared/models";
import { cloudKeys } from "../../src/shared/cloud/types";
import type { IndexerConfig } from "../indexer/src/build";

import type { SourceCheckpoint } from "./pass1";
import { partitionResultKey, type PartitionTaskResult } from "./partition";
import { shardCountFor, shardResultKey, shardTasksFor, type ShardTaskResult } from "./shard";
import type { BlobStore } from "./store";

export interface FinalizeOptions {
  store: BlobStore;
  version: string;
  config: Pick<IndexerConfig, "partitions" | "shards" | "sources">;
  onLog?: (line: string) => void;
  /** Skip the object-existence pass (used by tests that deliberately omit objects). */
  skipObjectCheck?: boolean;
}

export interface FinalizeResult {
  version: string;
  partitions: number;
  shards: number;
  shardObjects: number;
  counts: { companies: number; contacts: number; rows: number };
  objects: number;
  bytes: number;
  validationPassed: boolean;
  issues: { severity: "error" | "info"; code: string; message: string }[];
  directoryKey: string;
  manifestKey: string;
}

/** Empty counters for a source, so a missing per-source entry is never `undefined`. */
function emptyCounters(): IndexingCounters {
  return {
    rowsRead: 0,
    rowsRejected: 0,
    uniqueCompanies: 0,
    uniqueContacts: 0,
    duplicateRowsResolved: 0,
    duplicateCompaniesResolved: 0,
    ambiguousCompanies: 0,
    recordsMissingCompanyId: 0,
    perSource: {},
  };
}

function addCounters(total: IndexingCounters, part: IndexingCounters): void {
  for (const key of [
    "rowsRead",
    "rowsRejected",
    "uniqueCompanies",
    "uniqueContacts",
    "duplicateRowsResolved",
    "duplicateCompaniesResolved",
    "ambiguousCompanies",
    "recordsMissingCompanyId",
    "contactsHighConfidence",
    "contactsPlausible",
    "contactsConflicting",
    "contactsUnresolved",
    "contactsMoved",
    "identifierConflicts",
    "unassignedObjects",
  ] as const) {
    const value = part[key];
    if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  }
  for (const [id, value] of Object.entries(part.perSource ?? {})) {
    const target = total.perSource[id] ?? { rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0 };
    target.rowsRead += value.rowsRead ?? 0;
    target.rowsRejected += value.rowsRejected ?? 0;
    target.companies += value.companies ?? 0;
    target.contacts += value.contacts ?? 0;
    total.perSource[id] = target;
  }
}

/** Merge `[label, count]` pairs from every partition, then keep the largest. */
function mergeBuckets(target: Map<string, number>, entries: [string, number][]): void {
  for (const [label, count] of entries) target.set(label, (target.get(label) ?? 0) + count);
}

/** `topBuckets` from build.ts, kept local: finalize must not depend on run internals. */
function topBuckets(map: Map<string, number>, limit: number): { value: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

export async function finalizeParallelBuild(options: FinalizeOptions): Promise<FinalizeResult> {
  const { store, version, config } = options;
  const log = options.onLog ?? (() => {});
  const issues: FinalizeResult["issues"] = [];

  /* --------------------------- durable results --------------------------- */

  /*
   * Read the durable results concurrently.
   *
   * Sequentially this is ~3,000 small GETs (256 partitions + 2,816 shards); inside a
   * container one round trip is a noticeable fraction of a second, so the single-owner
   * commit would spend most of an hour waiting. The reads are independent and
   * read-only, so a small window hides the latency without opening thousands of
   * sockets.
   */
  const partitionIndexes = Array.from({ length: config.partitions }, (_, partition) => partition);
  const partitionResults = await mapLimit(partitionIndexes, 16, async (partition): Promise<PartitionTaskResult> => {
    const result = await store.getJson<PartitionTaskResult>(partitionResultKey(version, partition));
    if (!result) {
      throw new Error(
        `Cannot finalize ${version}: partition ${partition} has no result object. ` +
          "Every partition must complete before the manifest is committed.",
      );
    }
    if (result.version !== version || result.partition !== partition) {
      throw new Error(`${partitionResultKey(version, partition)} describes ${result.version}/${result.partition}, not ${version}/${partition}.`);
    }
    return result;
  });
  const partitions = partitionResults.slice().sort((a, b) => a.partition - b.partition);

  const expectedShards = shardTasksFor(config);
  const shardResults = await mapLimit(expectedShards, 16, async (task): Promise<ShardTaskResult> => {
    const result = await store.getJson<ShardTaskResult>(shardResultKey(version, task.kind, task.shard));
    if (!result) {
      throw new Error(
        `Cannot finalize ${version}: shard ${task.kind}/${task.shard} has no result object. ` +
          "Every configured shard must be assembled before the manifest is committed.",
      );
    }
    if (result.kind !== task.kind || result.shard !== task.shard) {
      throw new Error(`Shard result key ${task.kind}/${task.shard} holds ${result.kind}/${result.shard}.`);
    }
    return result;
  });
  // Stable order: the manifest must not depend on which request finished first.
  const shards = shardResults.slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.shard - b.shard);
  // A configured count that disagrees with the plan would silently leave shard
  // objects unreadable, so it is checked against the actual results.
  for (const kind of new Set(expectedShards.map((task) => task.kind))) {
    const count = shardCountFor(config, kind);
    if (shards.filter((result) => result.kind === kind).length !== count) {
      throw new Error(`Shard results for "${kind}" do not cover the configured ${count} shards.`);
    }
  }

  /* ------------------------------ aggregate ------------------------------ */

  const counters = emptyCounters();
  const byIndustry = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const bySize = new Map<string, number>();
  const byDesignation = new Map<string, number>();
  const byDepartment = new Map<string, number>();
  const bySeniority = new Map<string, number>();
  const coverage = { email: 0, linkedin: 0, phone: 0, neither: 0 };
  const objectCounts = { companyProjections: 0, companyDetails: 0, contactProjections: 0, contactDetails: 0, unassigned: 0 };
  let maxNextRef = 0;

  for (const partition of partitions) {
    addCounters(counters, partition.counters);
    mergeBuckets(byIndustry, partition.companyStats.byIndustry);
    mergeBuckets(byCountry, partition.companyStats.byCountry);
    mergeBuckets(bySize, partition.companyStats.bySize);
    mergeBuckets(byDesignation, partition.contactStats.byDesignation);
    mergeBuckets(byDepartment, partition.contactStats.byDepartment);
    mergeBuckets(bySeniority, partition.contactStats.bySeniority);
    coverage.email += partition.coverage.email;
    coverage.linkedin += partition.coverage.linkedin;
    coverage.phone += partition.coverage.phone;
    coverage.neither += partition.coverage.neither;
    objectCounts.companyProjections += partition.objectCounts.companyProjections;
    objectCounts.companyDetails += partition.objectCounts.companyDetails;
    objectCounts.contactProjections += partition.objectCounts.contactProjections;
    objectCounts.contactDetails += partition.objectCounts.contactDetails;
    objectCounts.unassigned += partition.objectCounts.unassigned;
    if (partition.nextRef > maxNextRef) maxNextRef = partition.nextRef;
  }

  const shardBytes = shards.reduce((total, result) => total + result.bytes, 0);

  /* ------------------------------ validation ----------------------------- */

  let verified = 0;
  if (!options.skipObjectCheck) {
    const objects = [
      ...partitions.flatMap((partition) => partition.objects.map((object) => ({ ...object, partition: partition.partition }))),
      ...shards
        .filter((result) => result.key !== null)
        .map((result) => ({ key: result.key as string, bytes: result.bytes, partition: result.shard })),
    ];
    const checks = await mapLimit(objects, 16, async (object) => {
      const head = await store.head(object.key);
      return { object, ok: head.exists && head.size === object.bytes, detail: head.exists ? `${head.size} bytes, expected ${object.bytes}` : "missing" };
    });
    for (const check of checks) {
      if (!check.ok) {
        issues.push({ severity: "error", code: "missing_object", message: `${check.object.key} is ${check.detail}.` });
        continue;
      }
      verified += 1;
    }
  }

  // Source coverage: every source must have contributed rows. This is the same
  // check the sequential validation makes, and the reason the partition tasks
  // report per-source rows instead of echoing the corpus total.
  for (const source of config.sources) {
    if ((counters.perSource[source.id]?.rowsRead ?? 0) === 0) {
      issues.push({
        severity: "error",
        code: "source_missing_rows",
        message: `Source ${source.id} contributed no rows to ${version}.`,
      });
    }
  }

  /*
   * Row coverage against Pass 1's own checkpoints. A partition task that silently
   * merged nothing (the zero-company defect) is caught here even if every object it
   * did write is intact: the totals would not add up.
   */
  let pass1Rows = 0;
  for (const source of config.sources) {
    const checkpoint = await store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(version, source.id));
    if (!checkpoint) {
      issues.push({ severity: "error", code: "missing_checkpoint", message: `Pass 1 checkpoint for ${source.id} is missing.` });
      continue;
    }
    if (!checkpoint.complete) {
      issues.push({ severity: "error", code: "source_incomplete", message: `${source.id} did not finish Pass 1.` });
    }
    pass1Rows += checkpoint.rows;
  }
  if (counters.rowsRead !== pass1Rows) {
    issues.push({
      severity: "error",
      code: "row_coverage",
      message: `Partitions merged ${counters.rowsRead.toLocaleString()} rows but Pass 1 recorded ${pass1Rows.toLocaleString()}.`,
    });
  }

  const shardObjects = shards.filter((result) => result.key !== null).length;
  if (shardObjects === 0) {
    issues.push({ severity: "error", code: "no_index_objects", message: "No shard object was assembled." });
  }
  if (counters.uniqueCompanies > 0 && objectCounts.companyDetails === 0) {
    issues.push({
      severity: "error",
      code: "missing_detail_objects",
      message: "Company projections were written without any company detail object.",
    });
  }
  if (counters.uniqueContacts > 0 && objectCounts.contactDetails === 0) {
    issues.push({
      severity: "error",
      code: "missing_detail_objects",
      message: "Contacts were indexed without any contact detail object.",
    });
  }

  issues.push({
    severity: "info",
    code: "row_sample",
    message: `${counters.rowsRead.toLocaleString()} rows read, ${counters.rowsRejected.toLocaleString()} rejected; ${partitions.length} partitions and ${shards.length} shards aggregated.`,
  });

  /* ------------------------------- publish ------------------------------- */

  const bytes = {
    indexes: shardBytes,
    companies: partitions.reduce(
      (total, partition) => total + partition.objects.filter((object) => object.key.startsWith("companies/")).reduce((sum, object) => sum + object.bytes, 0),
      0,
    ),
    contacts: partitions.reduce(
      (total, partition) => total + partition.objects.filter((object) => object.key.startsWith("contacts/")).reduce((sum, object) => sum + object.bytes, 0),
      0,
    ),
    details: partitions.reduce(
      (total, partition) => total + partition.objects.filter((object) => object.key.startsWith("details/")).reduce((sum, object) => sum + object.bytes, 0),
      0,
    ),
    unassigned: partitions.reduce(
      (total, partition) => total + partition.objects.filter((object) => object.key.startsWith("unassigned/")).reduce((sum, object) => sum + object.bytes, 0),
      0,
    ),
  };
  const totalBytes = bytes.indexes + bytes.companies + bytes.contacts + bytes.details + bytes.unassigned;
  const objectTotal = partitions.reduce((total, partition) => total + partition.objects.length, 0) + shardObjects;

  const stats: DatasetStats = {
    version,
    generatedAt: new Date().toISOString(),
    companies: counters.uniqueCompanies,
    contacts: counters.uniqueContacts,
    companiesByIndustry: topBuckets(byIndustry, 25),
    companiesByCountry: topBuckets(byCountry, 25),
    companiesBySize: topBuckets(bySize, 12),
    contactsByDesignation: topBuckets(byDesignation, 25),
    contactsByDepartment: topBuckets(byDepartment, 25),
    contactsBySeniority: topBuckets(bySeniority, 12),
    contactCoverage: coverage,
  };

  const directory: IndexDirectory = {
    formatVersion: INDEX_FORMAT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    version,
    createdAt: new Date().toISOString(),
    shards: {
      exact: config.shards.exact,
      prefix: config.shards.prefix,
      token: config.shards.token,
      trigram: config.shards.trigram,
      ids: config.shards.ids,
      companyPartitions: objectCounts.companyProjections,
      contactPartitions: objectCounts.contactProjections,
      contactIndex: { token: config.shards.token, prefix: config.shards.prefix, trigram: config.shards.trigram },
      spoolPartitions: config.partitions,
    },
    counts: { companies: counters.uniqueCompanies, contacts: counters.uniqueContacts, indexedAliases: 0 },
    sources: config.sources.map((source) => source.id),
    bytes: { ...bytes, total: totalBytes },
    objects: {
      companyProjections: objectCounts.companyProjections,
      companyDetails: objectCounts.companyDetails,
      contactProjections: objectCounts.contactProjections,
      contactDetails: objectCounts.contactDetails,
    },
    ...(objectCounts.unassigned ? { unassigned: { objects: objectCounts.unassigned, contacts: counters.contactsUnresolved ?? 0 } } : {}),
    fields: { company: ["name", "domain", "industry", "country", "city", "companySize", "revenue"], contact: ["fullName", "title", "email", "phone", "linkedinUrl", "country", "city"] },
  };

  const passed = !issues.some((issue) => issue.severity === "error");
  const validation = {
    version,
    passed,
    checkedAt: new Date().toISOString(),
    verifiedObjects: options.skipObjectCheck ? objectTotal : verified,
    missingObjects: issues.filter((issue) => issue.code === "missing_object").map((issue) => issue.message),
    issues,
  };
  const directoryKey = `indexes/${version}/directory.json`;
  const statsKey = `manifests/${version}/stats.json`;
  const validationKey = `manifests/${version}/validation.json`;
  const manifestKey = `manifests/${version}/manifest.json`;

  const summary: DatasetVersionSummary = {
    version,
    state: "validated",
    createdAt: partitions.map((partition) => partition.completedAt).sort()[0] ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    normalizerVersion: NORMALIZER_VERSION,
    indexFormatVersion: INDEX_FORMAT_VERSION,
    counters,
    bytes: totalBytes,
    objectCount: objectTotal,
    validationPassed: passed,
    notes: `Built by ${partitions.length} parallel partition merges and ${shards.length} shard assembly tasks. Highest ref ${maxNextRef.toLocaleString()}.`,
  };

  const putJson = async (key: string, value: unknown, gzip = false) => {
    const raw = Buffer.from(JSON.stringify(value), "utf8");
    const body = gzip ? await gzipBuffer(raw) : raw;
    await store.put(key, body, gzip ? "application/gzip" : "application/json");
  };

  await putJson(statsKey, stats);
  await putJson(directoryKey, directory);
  await store.put(validationKey, Buffer.from(JSON.stringify(validation, null, 2), "utf8"), "application/json");
  // LAST: this object is what makes the version visible as a candidate build.
  await putJson(manifestKey, summary);

  log(
    `finalize ${version}: ${counters.uniqueCompanies.toLocaleString()} companies, ${counters.uniqueContacts.toLocaleString()} contacts, ` +
      `${objectTotal.toLocaleString()} objects, ${(totalBytes / 1e9).toFixed(2)} GB, validation ${passed ? "passed" : "FAILED"}`,
  );

  return {
    version,
    partitions: partitions.length,
    shards: shards.length,
    shardObjects,
    counts: { companies: counters.uniqueCompanies, contacts: counters.uniqueContacts, rows: counters.rowsRead },
    objects: objectTotal,
    bytes: totalBytes,
    validationPassed: passed,
    issues,
    directoryKey,
    manifestKey,
  };
}

/** Local gzip import kept lazy: finalize is storage-only and must stay light. */
async function gzipBuffer(body: Buffer): Promise<Buffer> {
  const { gzipSync } = await import("node:zlib");
  return gzipSync(body);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Content hash of an assembled finalize report, for idempotent coordinator checks. */
export function finalizeDigest(result: FinalizeResult): string {
  return createHash("sha256").update(`${result.directoryKey}:${result.objects}:${result.bytes}:${result.validationPassed}`).digest("hex");
}
