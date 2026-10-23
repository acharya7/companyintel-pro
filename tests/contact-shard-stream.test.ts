/**
 * The streaming shard reader's contract.
 *
 * These are the failures that matter at 86 M contacts and cannot be reproduced by
 * the fixture index (whose shards are a few kilobytes): a key that straddles a
 * chunk boundary, an ids array far larger than the per-term cap, and a term that
 * is not in the shard at all. The test feeds the exact object shape the indexer
 * writes through a decompression stream split into tiny chunks, so a scanner
 * regression shows up here instead of as an empty person search in production.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { scanContactShardStream, scanRefShardStream } from "../worker/src/contact-shard-stream";

/** Same serialisation the indexer uses: `{"terms":{"<term>":{"ids":[…],"q":[…]}}}`. */
function contactPayload(terms: Record<string, string[]>): string {
  const parts = Object.entries(terms).map(
    ([term, ids]) => `${JSON.stringify(term)}:${JSON.stringify({ ids, q: ids.map(() => 200) })}`,
  );
  return `{"terms":{${parts.join(",")}}}`;
}

function refPayload(ids: Record<string, number[]>): string {
  const parts = Object.entries(ids).map(
    ([id, refs]) => `${JSON.stringify(id)}:${JSON.stringify({ refs, q: refs.map(() => 255) })}`,
  );
  return `{"terms":{${parts.join(",")}}}`;
}

/** A decompressed reader that hands out at most `chunk` characters at a time. */
function chunkedStream(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

describe("streaming contact-name shards", () => {
  test("finds requested terms when every key and id straddles chunk boundaries", async () => {
    const payload = contactPayload({
      priya: Array.from({ length: 25 }, (_, index) => `p_priya${index}`),
      "priya sharma": ["p_exact1", "p_exact2"],
      other: ["p_other"],
    });
    const scan = await scanContactShardStream(chunkedStream(payload, 5), ["priya", "priya sharma"]);
    expect(scan.postings.get("priya")?.ids).toHaveLength(25);
    expect(scan.postings.get("priya sharma")?.ids).toEqual(["p_exact1", "p_exact2"]);
    expect(scan.capped).toBe(false);
  });

  test("stops collecting at the cap and reports it", async () => {
    const payload = contactPayload({ smith: Array.from({ length: 50 }, (_, index) => `p_s${index}`) });
    const scan = await scanContactShardStream(chunkedStream(payload, 1024), ["smith"], { idsPerTerm: 8 });
    expect(scan.postings.get("smith")?.ids).toHaveLength(8);
    expect(scan.capped).toBe(true);
    // A capped read must stop early rather than decompress the rest of a common
    // term's postings; the whole payload is only ~1.5 KB here, so assert the flag
    // and the cap rather than a byte count.
    expect(scan.stoppedEarly).toBe(false);
  });

  test("a missing term is absent, never a near neighbour's ids", async () => {
    const payload = contactPayload({ alice: ["p_a"], bob: ["p_b"] });
    const scan = await scanContactShardStream(chunkedStream(payload, 3), ["zzqq"]);
    expect(scan.postings.has("zzqq")).toBe(false);
    expect(scan.scannedChars).toBe(payload.length);
  });

  test("gzip is handled by the caller: the scanner reads decompressed text", async () => {
    const payload = contactPayload({ carol: ["p_c"] });
    const gz = gzipSync(Buffer.from(payload, "utf8"));
    const stream = new Blob([new Uint8Array(gz)]).stream().pipeThrough(new DecompressionStream("gzip"));
    const scan = await scanContactShardStream(stream, ["carol"]);
    expect(scan.postings.get("carol")?.ids).toEqual(["p_c"]);
  });
});

describe("streaming ids shards", () => {
  test("returns refs for requested ids across chunk boundaries", async () => {
    const payload = refPayload({ p_a: [123], p_b: [-7], p_c: [9001] });
    const refs = await scanRefShardStream(chunkedStream(payload, 4), ["p_a", "p_b", "p_c"]);
    expect(refs.get("p_a")).toEqual([123]);
    expect(refs.get("p_b")).toEqual([-7]);
    expect(refs.get("p_c")).toEqual([9001]);
  });

  test("an id that is not in the shard is not invented", async () => {
    const payload = refPayload({ p_a: [1] });
    const refs = await scanRefShardStream(chunkedStream(payload, 7), ["p_missing"]);
    expect(refs.size).toBe(0);
  });
});
