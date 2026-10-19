/**
 * The streamed shard serialiser is what bounds Pass 2's memory, so it must produce
 * exactly the bytes the previous `JSON.stringify` path produced — a search shard is
 * parsed by the Worker and any escaping difference would silently change matching.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { shardJsonParts } from "../tools/indexer/src/build";

async function collect(terms: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  for await (const part of shardJsonParts(terms)) parts.push(part.toString("utf8"));
  return parts.join("");
}

describe("streamed shard serialization", () => {
  test("emits JSON that parses to the same payload", async () => {
    const terms = {
      "acme corp": { refs: [1, 2, 3], q: [10, 20, 30] },
      constructor: { refs: [4], q: [255] },
      'quote"back\\slash': { refs: [5], q: [0] },
      "line\u2028separator": { refs: [6], q: [7] },
    };
    const expected = JSON.stringify({ terms: { ...terms } });
    const streamed = await collect(terms);
    expect(JSON.parse(streamed)).toEqual(JSON.parse(expected));
    // Prototype-polluting term names stay own properties of `terms`.
    const parsed = JSON.parse(streamed) as { terms: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(parsed.terms, "constructor")).toBe(true);
  });

  test("gzip bytes are identical to gzipSync of the whole document", async () => {
    const terms = { alpha: { refs: [1, 2], q: [3, 4] }, beta: { refs: [5], q: [6] } };
    const expected = gzipSync(Buffer.from(JSON.stringify({ terms: { ...terms } }), "utf8"), { level: 6 });
    const parts: Buffer[] = [];
    for await (const part of shardJsonParts(terms)) parts.push(part);
    const streamed = gzipSync(Buffer.concat(parts), { level: 6 });
    expect(Buffer.compare(expected, streamed)).toBe(0);
  });

  test("releases each term as it is written", async () => {
    const terms: Record<string, unknown> = { a: { refs: [1], q: [1] }, b: { refs: [2], q: [2] }, c: { refs: [3], q: [3] } };
    for await (const _part of shardJsonParts(terms)) {
      // Nothing to assert per part; the mutation below is checked afterwards.
    }
    expect(Object.keys(terms).length).toBe(0);
  });
});
