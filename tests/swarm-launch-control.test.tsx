/**
 * The one-click full-corpus control.
 *
 * Scope, stated honestly: this is server-side rendering, not a browser. It proves
 * what the control says and who can see it — the two things that decide whether an
 * operator can authorise a 64 GB run safely — and it does NOT drive the click
 * (there is no DOM engine here; the request sequence is covered by the route tests
 * and by `docs/swarm.md`).
 *
 * What must hold:
 *   - an unauthorised identity, and staging, never see a start button;
 *   - the confirmation names both source objects, the real total, the container
 *     class, the partition/shard fan-out and every budget gate.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { ShutdownReport, SwarmConfirmFacts, SwarmLaunch } from "../src/components/swarm-launch";

describe("full-corpus launch control", () => {
  test("renders the start control for an authorised administrator", () => {
    const html = renderToString(<SwarmLaunch authorized staging={false} />);
    expect(html).toContain("START FULL INDEXING — 64 CONTAINERS");
    expect(html).toContain("Full dataset indexing — 64 containers");
  });

  test("is not rendered for an identity the control plane rejected", () => {
    const html = renderToString(<SwarmLaunch authorized={false} staging={false} />);
    expect(html).not.toContain("START FULL INDEXING");
    expect(html).not.toContain("Full dataset indexing");
  });

  test("is not rendered on staging, which runs bounded benchmarks only", () => {
    const html = renderToString(<SwarmLaunch authorized staging />);
    expect(html).not.toContain("START FULL INDEXING");
  });

  test("the confirmation states both sources, the total, the containers, the fan-out and every budget gate", () => {
    const html = renderToString(<SwarmConfirmFacts version="prod-real-2026-10-22" />);
    // Both original R2 objects, with their measured sizes.
    expect(html).toContain("raw/file1.csv");
    expect(html).toContain("10.22 GB");
    expect(html).toContain("raw/file2.csv");
    expect(html).toContain("54.04 GB");
    expect(html).toContain("64.26 GB");
    // Size, shape and fan-out.
    expect(html).toContain("64 × Cloudflare standard-4 (4 vCPU / 12 GiB / 20 GB)");
    expect(html).toContain("256 independent merge tasks");
    expect(html).toContain("2,816 shard tasks");
    // The budget objective and the automatic gates, including the pause behaviour.
    expect(html).toContain("$50 cumulative objective");
    expect(html).toContain("$40 warning");
    expect(html).toContain("$45 no new tasks");
    expect(html).toContain("$50 automatic pause");
    expect(html).toContain("automatic budget pause stops the swarm");
    // The version being approved is on the screen, not implied.
    expect(html).toContain("prod-real-2026-10-22");
  });

  test("the shutdown report states what each container actually did", () => {
    const html = renderToString(
      <ShutdownReport
        summary={{
          requested: 2,
          stopped: 1,
          failed: 1,
          results: [
            {
              workerId: "indexer-worker-06",
              ok: true,
              containerRunningBefore: true,
              containerDestroyed: true,
              releasedTaskId: "range:csv1:000006",
              releaseConfirmed: true,
              alarmCleared: true,
            },
            {
              workerId: "indexer-worker-07",
              ok: false,
              containerRunningBefore: true,
              containerDestroyed: false,
              releasedTaskId: null,
              releaseConfirmed: true,
              alarmCleared: false,
              error: "container destroy failed: platform error",
            },
          ],
        }}
      />,
    );
    // Server rendering splits text nodes, so the fragments are asserted.
    expect(html).toContain("Container shutdown:");
    expect(html).toContain("1 failed");
    expect(html).toContain("indexer-worker-06");
    expect(html).toContain("released range:csv1:000006");
    expect(html).toContain("indexer-worker-07");
    // A failure is shown with its reason, not as a green light.
    expect(html).toContain("container destroy failed: platform error");
  });

  test("a staging run never exposes the confirmation either", () => {
    // Belt and braces: the facts component is only reachable through the card, so a
    // staging render must not include its text.
    const html = renderToString(<SwarmLaunch authorized staging />);
    expect(html).not.toContain("64.26 GB");
  });
});
