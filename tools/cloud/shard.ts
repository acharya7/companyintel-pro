/**
 * One parallel shard-assembly task (Cloud Component 2).
 *
 * A parallel merge cannot finalize: the final index shard objects are shared by all
 * 256 partitions, so a per-partition finalize would have every container overwrite
 * the others' shards. Partition tasks therefore write partition-tagged posting parts
 * (`pass2/parts/<kind>/<shard>/p-<partition>-<batch>.lines.gz`) and stop.
 *
 * This task is the other half: ONE (kind, shard) per invocation, reading every
 * partition's parts for that shard, merging them through the indexer's own payload
 * builder, and writing exactly one object — `indexes/<version>/<kind>/<shard>.json`.
 *
 * Isolation:
 *   - the object key is derived from (version, kind, shard) only, so no two tasks
 *     can write the same object and a retry overwrites its own bytes;
 *   - it never writes `directory.json`, `manifests/`, `state.json` or the Pass 2
 *     checkpoint — the manifest commit owns those;
 *   - the result is written to `shards/<kind>/<shard>.json` last, which is the
 *     completion marker the coordinator reads.
 *
 * The output is the index the v4 reader already understands: the payload is built by
 * `assembleShardToStore` in `tools/indexer/src/build.ts`, the same code the
 * sequential finalize uses.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { cloudKeys } from "../../src/shared/cloud/types";
import {
  assembleShardToStore,
  type IndexerConfig,
  type ShardKind,
} from "../indexer/src/build";

import type { BlobStore } from "./store";

/** The five company shard kinds and the three contact-name shard kinds. */
const COMPANY_KINDS = ["exact", "prefix", "token", "trigram", "ids"] as const;
const CONTACT_KINDS = ["contactToken", "contactPrefix", "contactTrigram"] as const;

export interface ShardTaskSpec {
  kind: ShardKind;
  shard: number;
  /** True for the contact-name index (postings are `p_…` ids, not document refs). */
  contact: boolean;
}

/**
 * Every shard this configuration requires, in the same order the sequential
 * finalize writes them.
 *
 * The counts come from `config.shards`, never a hardcoded total: contact kinds reuse
 * the company counts for their kind (`contactToken` → `shards.token`), which is what
 * the reader derives from `directory.shards.contactIndex`.
 */
export function shardTasksFor(config: Pick<IndexerConfig, "shards">): ShardTaskSpec[] {
  const tasks: ShardTaskSpec[] = [];
  for (const kind of COMPANY_KINDS) {
    for (let shard = 0; shard < config.shards[kind]; shard += 1) tasks.push({ kind, shard, contact: false });
  }
  const contactCounts: [ShardKind, number][] = [
    ["contactToken", config.shards.token],
    ["contactPrefix", config.shards.prefix],
    ["contactTrigram", config.shards.trigram],
  ];
  for (const [kind, count] of contactCounts) {
    for (let shard = 0; shard < count; shard += 1) tasks.push({ kind, shard, contact: true });
  }
  return tasks;
}

/** Shard count for one kind, so a task can be validated against the configuration. */
export function shardCountFor(config: Pick<IndexerConfig, "shards">, kind: ShardKind): number {
  if ((CONTACT_KINDS as readonly string[]).includes(kind)) {
    const base = kind.slice("contact".length).toLowerCase() as "token" | "prefix" | "trigram";
    return config.shards[base];
  }
  if (!(COMPANY_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown shard kind "${kind}".`);
  return config.shards[kind as (typeof COMPANY_KINDS)[number]];
}

export function isContactKind(kind: ShardKind): boolean {
  return (CONTACT_KINDS as readonly string[]).includes(kind);
}

export interface ShardTaskOptions {
  store: BlobStore;
  version: string;
  config: Pick<IndexerConfig, "shards">;
  kind: ShardKind;
  shard: number;
  onLog?: (line: string) => void;
}

export interface ShardTaskResult {
  version: string;
  kind: ShardKind;
  shard: number;
  contact: boolean;
  /** Final index object; `null` when the shard has no postings (no object is written). */
  key: string | null;
  bytes: number;
  sha256: string;
  terms: number;
  postings: number;
  /** Posting-part objects read for this shard. */
  parts: number;
  empty: boolean;
  completedAt: string;
  /** Content hash of the produced object (or of "empty"), for the manifest commit. */
  digest: string;
}

export async function runShardTask(options: ShardTaskOptions): Promise<ShardTaskResult> {
  const { store, version, kind, shard } = options;
  const contact = isContactKind(kind);
  if (!Number.isInteger(shard) || shard < 0) throw new Error(`Shard must be a non-negative integer (got ${shard}).`);
  const count = shardCountFor(options.config, kind);
  if (shard >= count) throw new Error(`Shard ${kind}/${shard} is outside the configured ${count} shards for this kind.`);

  /*
   * Read the parts for this ONE shard. Both layouts are accepted so a job that was
   * merged sequentially (untagged `pass2/shards/…`) can be finalized by the same
   * task; a parallel job only has the partition-tagged ones.
   *
   * Part keys sort by partition then batch (`p-007-000000`), which is the same
   * deterministic order the merge emitted them in; a retry therefore reproduces
   * byte-identical postings.
   */
  const tagPrefix = `${cloudKeys.jobRoot(version)}/pass2/parts/${kind}/${String(shard).padStart(4, "0")}/`;
  const sequentialPrefix = `${cloudKeys.jobRoot(version)}/pass2/shards/${kind}/${String(shard).padStart(4, "0")}/`;
  const tagged = await store.list(tagPrefix);
  const sequential = tagged.length ? [] : await store.list(sequentialPrefix);
  const parts = [...tagged, ...sequential].sort((a, b) => a.key.localeCompare(b.key));

  async function* postingLines(): AsyncIterable<string> {
    for (const part of parts) {
      const body = await store.getRange(part.key, 0, part.size);
      const text = gunzipSync(body).toString("utf8");
      for (const line of text.split("\n")) if (line) yield line;
    }
  }

  const assembled = parts.length
    ? await assembleShardToStore({
        version,
        kind,
        shard,
        contact,
        parts: postingLines(),
        put: async (key, body, gzip) => {
          // No `content-encoding` even for gzip bytes: R2's S3 endpoint would decode
          // the body on the way out, breaking ranged reads and checksum comparisons.
          await store.put(key, body, gzip ? "application/gzip" : "application/json");
        },
      })
    : null;

  const result: ShardTaskResult = {
    version,
    kind,
    shard,
    contact,
    key: assembled?.key ?? null,
    bytes: assembled?.bytes ?? 0,
    sha256: assembled?.sha256 ?? "",
    terms: assembled?.terms ?? 0,
    postings: assembled?.postings ?? 0,
    parts: parts.length,
    empty: assembled === null,
    completedAt: new Date().toISOString(),
    digest: assembled
      ? createHash("sha256").update(`${assembled.key}:${assembled.bytes}:${assembled.sha256}`).digest("hex")
      : createHash("sha256").update(`empty:${kind}/${shard}`).digest("hex"),
  };
  options.onLog?.(
    `${kind}/${String(shard).padStart(4, "0")}: ${result.terms.toLocaleString()} terms from ${parts.length} part(s)` +
      (assembled ? `, ${(assembled.bytes / 1024).toFixed(0)} KB` : " — empty, no object written"),
  );
  // Written LAST: this object is the task's completion marker.
  await store.putJson(shardResultKey(version, kind, shard), result);
  return result;
}

/** Durable per-shard result, read by the manifest commit. */
export function shardResultKey(version: string, kind: ShardKind, shard: number): string {
  return `${cloudKeys.jobRoot(version)}/shards/${kind}/${String(shard).padStart(4, "0")}.json`;
}

/** Directory holding every shard result of one kind (for the finalize aggregation). */
export function shardResultPrefix(version: string, kind?: ShardKind): string {
  return `${cloudKeys.jobRoot(version)}/shards/${kind ? `${kind}/` : ""}`;
}
