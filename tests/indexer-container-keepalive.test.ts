/**
 * The container must stay alive for as long as the job runs.
 *
 * Cloudflare stops a container once its Durable Object has been inactive for the
 * inactivity timeout. The Worker's start route answers 202 and goes idle, so without
 * a timeout the platform is free to stop the instance right after the first chunk —
 * which is what staging showed. The documented keep-alive is
 * `ctx.container.setInactivityTimeout()`, renewed by DO activity; this test requires
 * the DO to set it when a job is accepted, and to renew it from its alarm only while
 * `/health` reports a running job.
 */

import { describe, expect, test } from "bun:test";

import { IndexerContainer } from "../worker/src/indexer-container";
import type { EnvWithContainer } from "../worker/src/indexer-container";

interface FakeContainer {
  running: boolean;
  fetched: string[];
  timeouts: number[];
  start(): void;
  getTcpPort(port: number): { fetch(input: RequestInfo | URL): Promise<Response> };
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
}

function fakeState(options: { jobRunning?: boolean; healthThrows?: boolean; timeoutThrows?: boolean } = {}) {
  const container: FakeContainer = {
    running: true,
    fetched: [],
    timeouts: [],
    start() {
      container.running = true;
    },
    getTcpPort() {
      return {
        fetch: async (input) => {
          const url = String(input);
          container.fetched.push(url);
          if (url.endsWith("/health")) {
            if (options.healthThrows) throw new Error("connection refused");
            return Response.json({ ok: true, job: { running: options.jobRunning ?? true } });
          }
          return Response.json({ started: true, pid: 7 }, { status: 202 });
        },
      };
    },
    async setInactivityTimeout(durationMs) {
      if (options.timeoutThrows) throw new Error("keep-alive rejected");
      container.timeouts.push(Number(durationMs));
    },
  };
  const state = {
    container,
    storage: {
      alarmAt: null as number | null,
      async setAlarm(at: number) {
        state.storage.alarmAt = at;
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  return { state, container };
}

const env = { ENVIRONMENT: "development", CONTAINER_JOB_INACTIVITY_MS: "60000", CONTAINER_KEEPALIVE_MS: "1000" } as unknown as EnvWithContainer;

describe("IndexerContainer keep-alive", () => {
  test("accepting a detached job sets an inactivity timeout and arms the alarm", async () => {
    const { state, container } = fakeState();
    // Cold start: the constructor has nothing to restore, so exactly one timeout is
    // expected from accepting the job.
    container.running = false;
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env);

    const response = await durable.fetch(
      new Request("http://container/job", { method: "POST", body: JSON.stringify({ args: ["benchmark"], detach: true }) }),
    );

    expect(response.status).toBe(202);
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).not.toBeNull();
  });

  test("the alarm renews while the job is alive and stops renewing once it ends", async () => {
    const { state, container } = fakeState({ jobRunning: true });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env);
    container.timeouts.length = 0;
    state.storage.alarmAt = null;

    await durable.alarm();
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).not.toBeNull();

    const ended = fakeState({ jobRunning: false });
    const finished = new IndexerContainer(ended.state as unknown as DurableObjectState, env);
    ended.container.timeouts.length = 0;
    ended.state.storage.alarmAt = null;
    await finished.alarm();
    // No renewal and no re-arm: a finished job must not keep paying for container time.
    expect(ended.container.timeouts).toEqual([]);
    expect(ended.state.storage.alarmAt).toBeNull();
  });

  test("a probe failure keeps the window open instead of treating the job as finished", async () => {
    const { state, container } = fakeState({ healthThrows: true });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env);
    container.timeouts.length = 0;
    state.storage.alarmAt = null;

    await durable.alarm();
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).not.toBeNull();
  });

  test("a rejected keep-alive never turns an accepted start into an error", async () => {
    const { state } = fakeState({ timeoutThrows: true });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env);
    const response = await durable.fetch(
      new Request("http://container/job", { method: "POST", body: JSON.stringify({ args: ["benchmark"], detach: true }) }),
    );
    expect(response.status).toBe(202);
  });

  test("a constructor after a DO restart restores the timeout for a running container", async () => {
    const { state, container } = fakeState();
    // The constructor schedules the restore through blockConcurrencyWhile; the fake
    // runs it immediately, so one timeout is recorded.
    new IndexerContainer(state as unknown as DurableObjectState, env);
    expect(container.timeouts).toEqual([60_000]);
  });
});
