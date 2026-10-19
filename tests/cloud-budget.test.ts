/**
 * The budget guard is an operator protection, not a billing cap: when the running
 * estimate reaches `CLOUD_BUDGET_USD`, Pass 1 pauses at the next durable chunk
 * boundary instead of continuing to spend. The checkpoint stays usable.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cloudKeys } from "../src/shared/cloud/types";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { MemoryBlobStore } from "../tools/cloud/store";

const HEADER = ["organization_id", "organization_name", "organization_domain"];
const ROWS = Array.from({ length: 200 }, (_, index) => [`c${index}`, `Company ${index} Ltd`, `company${index}.example`].join("\t"));
const BODY = Buffer.from(`${[HEADER.join("\t"), ...ROWS].join("\n")}\n`, "utf8");
const SOURCE: Pass1SourceSpec = {
  id: "csv1",
  key: "raw/file1.csv",
  delimiter: "\t",
  columns: { companyid: "organization_id", companyname: "organization_name", companydomain: "organization_domain" },
};

afterEach(() => {
  delete process.env.CLOUD_BUDGET_USD;
});

describe("cloud budget guard", () => {
  test("pauses a full run at a chunk boundary instead of continuing to spend", async () => {
    process.env.CLOUD_BUDGET_USD = "0.000001";
    const store = new MemoryBlobStore({ "raw/file1.csv": BODY });
    const result = await runPass1({
      store,
      version: "budget-guard",
      sources: [SOURCE],
      partitions: 2,
      chunkBytes: 64,
      sliceBytes: 16,
      mode: "full",
    });
    expect(result.stopped).toBe("paused");
    expect(result.state.stage).toBe("paused");
    expect(result.state.note).toContain("budget guard");
    // The checkpoint survives, so raising the limit resumes instead of restarting.
    const checkpoint = await store.getJson<{ nextOffset: number }>(cloudKeys.checkpoint("budget-guard", "csv1"));
    expect(checkpoint?.nextOffset).toBeGreaterThan(0);
    expect(checkpoint?.nextOffset).toBeLessThan(BODY.length);
  });

  test("a benchmark is not stopped by the full-run budget", async () => {
    process.env.CLOUD_BUDGET_USD = "0.000001";
    const store = new MemoryBlobStore({ "raw/file1.csv": BODY });
    const result = await runPass1({
      store,
      version: "budget-bench",
      sources: [SOURCE],
      partitions: 2,
      chunkBytes: 64,
      sliceBytes: 16,
      maxSourceBytes: 40,
      mode: "benchmark",
    });
    expect(result.stopped).not.toBe("paused");
  });
});
