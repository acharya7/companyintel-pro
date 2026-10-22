/**
 * The shard fan-out must be the indexer's ACTUAL configuration, not a guess.
 *
 * A Worker bundle cannot read `tools/`, so `SWARM_SHARDS` restates the production
 * shard counts. If the indexer config changes and this constant does not, the
 * assembly phase would cover fewer shards than the reader looks for — or build shards
 * the reader never asks for — and the failure would only show up as missing search
 * results on the real dataset. This test makes that drift a build error instead.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { SWARM_SHARDS, swarmShardTasks, swarmTaskId } from "../src/shared/cloud/swarm";

const CONFIG = JSON.parse(readFileSync("tools/indexer/indexer.config.json", "utf8")) as {
  partitions: number;
  shards: { exact: number; prefix: number; token: number; trigram: number; ids: number };
};

describe("swarm shard plan", () => {
  test("matches the indexer's production shard configuration", () => {
    expect(SWARM_SHARDS).toEqual(CONFIG.shards);
  });

  test("covers every company and contact shard the reader can request", () => {
    const tasks = swarmShardTasks(CONFIG.shards);
    const company = CONFIG.shards.exact + CONFIG.shards.prefix + CONFIG.shards.token + CONFIG.shards.trigram + CONFIG.shards.ids;
    const contact = CONFIG.shards.token + CONFIG.shards.prefix + CONFIG.shards.trigram;
    expect(tasks).toHaveLength(company + contact);
    // The production layout is 1,792 company shards + 1,024 contact shards.
    expect(tasks.length).toBe(2816);
    expect(new Set(tasks.map((task) => `${task.kind}/${task.shard}`)).size).toBe(tasks.length);
    // Contact kinds post contact ids; company kinds post document refs.
    expect(tasks.filter((task) => task.contact).every((task) => task.kind.startsWith("contact"))).toBe(true);
    expect(tasks.filter((task) => !task.contact).every((task) => !task.kind.startsWith("contact"))).toBe(true);
  });

  test("task ids are unique, sortable and carry the kind and ordinal a worker needs", () => {
    expect(swarmTaskId("merge_partition", "all", 7)).toBe("merge_partition:all:000007");
    expect(swarmTaskId("assemble_shard", "contactTrigram", 12)).toBe("assemble_shard:contactTrigram:000012");
    expect(swarmTaskId("finalize", "all", 0)).toBe("finalize:all:000000");
  });
});
