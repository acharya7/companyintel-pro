/**
 * The coordinator is the only durable owner of a swarm run, so these tests attack the
 * things that would lose or duplicate work in production:
 *
 *   - a task is handed to exactly one worker (a claim pops it, a completion is
 *     idempotent);
 *   - a worker that dies mid-range does not strand that range (the expired lease is
 *     reclaimed by the next worker);
 *   - the ingest phase writes the aggregate Pass 1 checkpoint and state that the
 *     unchanged Pass 2 merge verifies, with the real chunk count;
 *   - the budget gates stop new claims at $45 and pause the run at $50 instead of
 *     spending past the operator's limit.
 */

import { describe, expect, test } from "bun:test";

import type { SwarmBlockDescriptor, SwarmPlan, SwarmTask } from "../src/shared/cloud/swarm";
import { IndexingCoordinator } from "../worker/src/indexing-coordinator";
import { fakeDoState } from "./helpers/fake-do";
import { FakeR2Bucket } from "./helpers/fake-r2";

const BLOCK_BYTES = 1024;
const SIZE = 3072;
const PLAN: SwarmPlan = {
  version: "swarm-test",
  createdAt: "2026-10-22T00:00:00.000Z",
  mode: "full",
  partitions: 4,
  blockBytes: BLOCK_BYTES,
  rangeBlocks: 1,
  sources: [{ id: "csv1", key: "raw/file1.csv", size: SIZE, etag: '"e1"', blocks: 3 }],
  budgetUsd: 50,
  workers: 4,
};

function harness(seed: Record<string, unknown> = {}) {
  const state = fakeDoState({ seed });
  const bucket = new FakeR2Bucket();
  const coordinator = new IndexingCoordinator(state as unknown as DurableObjectState, {
    COMPANY_DATA: bucket as unknown as R2Bucket,
  });
  return { state, bucket, coordinator };
}

async function call(coordinator: IndexingCoordinator, path: string, body: Record<string, unknown> = {}) {
  const response = await coordinator.fetch(
    new Request(`https://coordinator${path}`, {
      method: path === "/status" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(path === "/status" ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return (await response.json()) as Record<string, unknown>;
}

function descriptor(index: number): SwarmBlockDescriptor {
  return {
    index,
    start: index * BLOCK_BYTES,
    end: (index + 1) * BLOCK_BYTES,
    bytes: BLOCK_BYTES,
    quotes: 0,
    newlines: 10,
    firstFalseEnd: index * BLOCK_BYTES + 100,
    firstFalseLine: 11,
    firstTrueEnd: null,
    firstTrueLine: null,
  };
}

/** Drain every block task, then every range task, reporting counters like a worker. */
async function runIngest(coordinator: IndexingCoordinator): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const claim = await call(coordinator, "/claim", { workerId: `indexer-worker-0${index}` });
    const task = claim.task as SwarmTask;
    expect(task.kind).toBe("block");
    await call(coordinator, "/complete", {
      workerId: `indexer-worker-0${index}`,
      taskId: task.id,
      block: descriptor(task.index),
      result: { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: BLOCK_BYTES, classA: 1, classB: 0 },
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-00" });
    const task = claim.task as SwarmTask;
    expect(task.kind).toBe("range");
    await call(coordinator, "/complete", {
      workerId: "indexer-worker-00",
      taskId: task.id,
      result: { rows: 10, rejected: 1, segments: 2, segmentBytes: 2048, bytesRead: task.end - task.start, classA: 3, classB: 4 },
    });
  }
}

describe("swarm coordinator", () => {
  test("hands each block task to exactly one worker and plans ranges from them", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);

    const claimed: string[] = [];
    for (const worker of ["indexer-worker-00", "indexer-worker-01", "indexer-worker-02"]) {
      const claim = await call(coordinator, "/claim", { workerId: worker });
      const task = claim.task as SwarmTask;
      claimed.push(task.id);
      expect(claim.plan).toEqual({ version: PLAN.version, partitions: PLAN.partitions, blockBytes: BLOCK_BYTES });
    }
    // The answer is a second coordinator call: `plan` is idempotent per version.
    const again = await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    expect(again.created).toBe(false);
    // Distinct tasks, not the same one leased three times.
    expect(new Set(claimed).size).toBe(3);

    for (const [index, id] of claimed.entries()) {
      await call(coordinator, "/complete", {
        workerId: `indexer-worker-0${index}`,
        taskId: id,
        block: descriptor(index),
        result: { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: BLOCK_BYTES, classA: 1, classB: 0 },
      });
    }

    // Every block is done: the next claim advances to ingest and returns a range.
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-03" });
    expect(claim.stage).toBe("ingest");
    const task = claim.task as SwarmTask;
    expect(task.kind).toBe("range");
    expect(task.start).toBe(0);
    expect(task.baseLine).toBe(1);
    // Three blocks, one cut per block → three ranges covering the whole object.
    const status = (await call(coordinator, "/status")) as unknown as { sources: { rangesTotal: number }[] };
    expect(status.sources[0]!.rangesTotal).toBe(3);
  });

  test("writes the Pass 1 checkpoint and state that Pass 2 verifies", async () => {
    const { coordinator, bucket } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    await runIngest(coordinator);

    const state = JSON.parse(bucket.objects.get(`cloud/jobs/${PLAN.version}/state.json`)!.bytes.toString("utf8"));
    expect(state.stage).toBe("pass1-complete");
    expect(state.coverage).toBe("full");
    expect(state.totals.rowsIndexed).toBe(30);
    expect(state.totals.rowsRejected).toBe(3);
    expect(state.totals.sourceBytesRead).toBe(SIZE);
    expect(state.sources[0].chunks).toBe(3);
    expect(state.sources[0].complete).toBe(true);

    const checkpoint = JSON.parse(bucket.objects.get(`cloud/jobs/${PLAN.version}/checkpoints/csv1.json`)!.bytes.toString("utf8"));
    expect(checkpoint).toMatchObject({
      sourceId: "csv1",
      complete: true,
      nextOffset: SIZE,
      chunks: 3,
      rows: 30,
      rejected: 3,
      partitions: PLAN.partitions,
    });

    // The merge task is queued and any worker may claim it.
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-05" });
    expect(claim.stage).toBe("merge");
    expect((claim.task as SwarmTask).kind).toBe("merge");

    await call(coordinator, "/complete", {
      workerId: "indexer-worker-05",
      taskId: (claim.task as SwarmTask).id,
      result: { rows: 30, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: 0, classA: 0, classB: 0 },
      searchable: { rows: 30 },
    });
    const done = (await call(coordinator, "/claim", { workerId: "indexer-worker-05" })) as { stop?: string; stage?: string };
    expect(done.stop).toBe("complete");
    expect(done.stage).toBe("complete");
  });

  test("reclaims a task whose worker stopped heartbeating", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);

    const first = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })) as { task: SwarmTask };
    const taskKey = `t:${first.task.id}`;
    const stored = state.map.get(taskKey) as SwarmTask;
    expect(stored.state).toBe("leased");
    expect(stored.attempts).toBe(1);

    // The worker disappears: its lease goes stale.
    state.map.set(taskKey, { ...stored, leaseUntil: Date.now() - 1000 });

    const second = (await call(coordinator, "/claim", { workerId: "indexer-worker-01" })) as { task: SwarmTask };
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.attempts).toBe(2);
    expect(second.task.leaseOwner).toBe("indexer-worker-01");
  });

  test("stops new claims at the soft gate and pauses the run at the hard gate", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);

    // $49 of container time: past the $45 soft gate, under the $50 pause.
    state.map.set("accounting", { containerSeconds: 1_400_000, classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0 });
    const soft = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })) as { stop?: string; task?: unknown };
    expect(soft.stop).toBe("budget_soft");
    expect(soft.task).toBeNull();

    // $70: the run pauses and says why, instead of spending past the limit.
    state.map.set("accounting", { containerSeconds: 2_000_000, classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0 });
    const hard = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })) as { stop?: string };
    expect(hard.stop).toBe("budget");
    const status = (await call(coordinator, "/status")) as unknown as { stage: string; stopReason?: string; accounting: { level: string } };
    expect(status.stage).toBe("paused");
    expect(status.accounting.level).toBe("hard");
    expect(status.stopReason).toContain("budget gate");
  });

  test("a repeated completion is idempotent, so a retried task cannot be counted twice", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    const claim = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })) as { task: SwarmTask };
    const body = {
      workerId: "indexer-worker-00",
      taskId: claim.task.id,
      block: descriptor(0),
      result: { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: BLOCK_BYTES, classA: 1, classB: 0 },
    };
    await call(coordinator, "/complete", body);
    const again = (await call(coordinator, "/complete", body)) as { duplicate?: boolean };
    expect(again.duplicate).toBe(true);
    const status = (await call(coordinator, "/status")) as unknown as { tasks: { blocksDone: number } };
    expect(status.tasks.blocksDone).toBe(1);
  });
});
