/**
 * Regression tests for the intermediate-file codec — the exact mechanism that
 * failed the 1,000,000-record benchmark.
 *
 * The failure was:
 *
 *     pass 1  writes  JSON.stringify(row) + "\n"      // U+2028 stays LITERAL
 *     pass 2  reads   node:readline                    // U+2028 IS a terminator
 *     result          JSON Parse error: Unterminated string
 *
 * so these tests pin both halves of the fix, plus the ways a damaged file must be
 * reported rather than silently shortened:
 *
 *   - a record containing U+2028/U+2029 survives a round trip, and an encoded
 *     line can never contain a byte any line-oriented reader could split on;
 *   - a LEGACY file (written by the old build, with literal separators) still
 *     reads back as one record, because the reader splits on `\n` only;
 *   - a truncated final record, a malformed record and an oversized record each
 *     fail with their file, line number and byte offset — and with no record
 *     content in the message, because a spool row holds real contact data.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_LINE_BYTES,
  JsonlError,
  encodeJsonlLine,
  encodeJsonlRecord,
  isJsonlError,
  readJsonlFile,
  readJsonlLines,
  scanJsonlFile,
} from "../tools/indexer/src/jsonl";
import { hashFile } from "../tools/indexer/src/spool";

const dir = mkdtempSync(join(tmpdir(), "companyintel-jsonl-"));
let counter = 0;

function write(name: string, content: string | Buffer): string {
  counter += 1;
  const path = join(dir, `${name}-${counter}`);
  writeFileSync(path, content);
  return path;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function collect<T>(path: string, options = {}): Promise<T[]> {
  const out: T[] = [];
  for await (const record of readJsonlFile<T>(path, options)) out.push(record.value);
  return out;
}

describe("encoding a record", () => {
  test("escapes the separators JSON.stringify leaves literal", () => {
    const line = encodeJsonlRecord({ value: "A\u2028B\u2029C" });
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(line).toContain("\\u2028");
    expect(line).toContain("\\u2029");
    // …and it is still the same value.
    expect(JSON.parse(line)).toEqual({ value: "A\u2028B\u2029C" });
  });

  test("an encoded line holds exactly one newline, whatever the value contains", () => {
    const tricky = { value: "a\nb\r\nc\u2028d\u2029e\u0085f\u000bg" };
    const line = encodeJsonlLine(tricky);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
    expect(line.split("\r").length).toBeLessThanOrEqual(2);
    expect(JSON.parse(line)).toEqual(tricky);
  });

  test("escapes separators anywhere in a structure, including keys", () => {
    const value = { "k\u2028ey": ["A\u2029B", { nested: "\u2028" }] };
    const line = encodeJsonlRecord(value);
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(JSON.parse(line)).toEqual(value);
  });
});

describe("reading records", () => {
  test("round-trips records through encode and read", async () => {
    const rows = [
      { id: 1, name: "Globex\u2028Holdings" },
      { id: 2, name: "Acme" },
      { id: 3, name: "\u2029Leading separator" },
      { id: 4, name: "trailing separator\u2028" },
    ];
    const path = write("roundtrip.jsonl", rows.map(encodeJsonlLine).join(""));
    expect(await collect(path)).toEqual(rows);
  });

  test("reads a LEGACY file whose separators are literal bytes", async () => {
    // Exactly what the old build wrote: bare `JSON.stringify`, so U+2028 and
    // U+2029 are in the file as literal characters. `readline` split this into
    // two lines and threw; the `\n`-only splitter must not.
    const legacy = `${JSON.stringify({ name: "Globex\u2028Holdings", industry: "Software\u2029Services" })}\n`;
    const raw = readFileSync(write("legacy.jsonl", legacy));
    expect(raw.includes(0xe2) && raw.includes(0x80)).toBe(true); // separators really are literal
    const rows = await collect<{ name: string }>(write("legacy2.jsonl", legacy));
    expect(rows).toEqual([{ name: "Globex\u2028Holdings", industry: "Software\u2029Services" }]);
  });

  test("handles a very long record", async () => {
    const long = { pad: "x".repeat(5_000_000), tail: "end" };
    const path = write("long.jsonl", encodeJsonlLine(long));
    const rows = await collect<typeof long>(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].pad.length).toBe(5_000_000);
    expect(rows[0].tail).toBe("end");
  });

  test("decodes multi-byte characters that straddle a read chunk boundary", async () => {
    // The reader reads 1 MiB chunks. A line of repeated 2- and 3-byte characters
    // guarantees that some character is split across a chunk boundary, and byte
    // offsets must stay exact for a diagnostic to be useful.
    const value = "é".repeat(700_000) + "→".repeat(300_000);
    const path = write("boundary.jsonl", encodeJsonlLine({ value }) + encodeJsonlLine({ value: "after" }));
    const lines = [];
    for await (const line of readJsonlLines(path)) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe(encodeJsonlRecord({ value }));
    expect(lines[0].byteLength).toBe(Buffer.byteLength(lines[0].text, "utf8"));
    expect(lines[1].byteOffset).toBe(lines[0].byteLength + 1);
    const rows = await collect<{ value: string }>(path);
    expect(rows[0].value).toBe(value);
    expect(rows[1].value).toBe("after");
  });

  test("accepts Windows CRLF terminators, and a CR inside a value stays escaped", async () => {
    const rows = [{ os: "windows", note: "line1\r\nline2" }, { os: "unix", note: "plain" }];
    const path = write("crlf.jsonl", rows.map((row) => `${encodeJsonlRecord(row)}\r\n`).join(""));
    expect(await collect(path)).toEqual(rows);
  });

  test("blank lines are skipped without shifting the reported line numbers", async () => {
    const body = `\n${encodeJsonlLine({ a: 1 })}\n\n${encodeJsonlLine({ a: 2 })}\n`;
    const path = write("blank.jsonl", body);
    const lines = [];
    for await (const line of readJsonlFile<{ a: number }>(path)) lines.push(line);
    // Records are at line 2 and line 5 (the template adds a blank line before and
    // after each encoded record, and `encodeJsonlLine` already terminates it).
    expect(lines.map((line) => line.value.a)).toEqual([1, 2]);
    expect(lines.map((line) => line.line)).toEqual([2, 5]);
  });

  test("reports every byte to onChunk so a caller can hash while parsing", async () => {
    const rows = [{ a: "x\u2028y" }, { a: "z" }];
    const path = write("hash.jsonl", rows.map(encodeJsonlLine).join(""));
    const hash = createHash("sha256");
    for await (const _record of readJsonlFile(path, { onChunk: (chunk) => hash.update(chunk) })) {
      void _record;
    }
    expect(hash.digest("hex")).toBe(await hashFile(path));
  });
});

describe("damaged files are reported, never silently shortened", () => {
  test("a truncated final record is a hard error with its position", async () => {
    const good = encodeJsonlLine({ a: 1 });
    const path = write("truncated.jsonl", `${good}${encodeJsonlRecord({ a: 2 }).slice(0, 5)}`);
    const failure = await collect(path).catch((error: unknown) => error);
    expect(isJsonlError(failure)).toBe(true);
    const error = failure as JsonlError;
    expect(error.details.code).toBe("truncated_final_line");
    expect(error.details.line).toBe(2);
    expect(error.details.byteOffset).toBe(Buffer.byteLength(good, "utf8"));
    expect(error.details.fileSize).toBe(Buffer.byteLength(`${good}${encodeJsonlRecord({ a: 2 }).slice(0, 5)}`, "utf8"));
    expect(error.message).toContain("does not end with a complete record");
  });

  test("a final record with no newline is refused even when it parses", async () => {
    const path = write("no-newline.jsonl", `${encodeJsonlLine({ a: 1 })}${encodeJsonlRecord({ a: 2 })}`);
    const failure = await collect(path).catch((error: unknown) => error);
    expect((failure as JsonlError).details.code).toBe("truncated_final_line");
  });

  test("a malformed record reports line and offset, and never the content", async () => {
    const secret = "ada@example.com";
    const body = `${encodeJsonlLine({ a: 1 })}{"broken":"${secret}"\n${encodeJsonlLine({ a: 3 })}`;
    const path = write("malformed.jsonl", body);
    const failure = await collect(path).catch((error: unknown) => error);
    const error = failure as JsonlError;
    expect(error.details.code).toBe("malformed_record");
    expect(error.details.line).toBe(2);
    expect(error.details.byteOffset).toBe(Buffer.byteLength(encodeJsonlLine({ a: 1 }), "utf8"));
    expect(error.details.recordBytes).toBeGreaterThan(0);
    // Safe to paste: the message carries positions, not data.
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("broken");
  });

  test("an oversized record is a corruption signal, not an accepted value", async () => {
    const path = write("oversized.jsonl", encodeJsonlLine({ pad: "x".repeat(4096) }));
    const failure = await collect(path, { maxLineBytes: 1024 }).catch((error: unknown) => error);
    expect((failure as JsonlError).details.code).toBe("line_too_long");
    expect(DEFAULT_MAX_LINE_BYTES).toBeGreaterThan(1024);
  });

  test("scanJsonlFile collects problems instead of throwing, and leaks nothing", async () => {
    const body = `{"a":1}\n{"b":\n{"c":3}\n{"d":4`;
    const path = write("scan.jsonl", body);
    const scan = await scanJsonlFile(path);
    expect(scan.records).toBe(4);
    expect(scan.terminated).toBe(false);
    expect(scan.problems.map((problem) => problem.kind)).toEqual(["unparseable", "truncated"]);
    expect(scan.problems[0].line).toBe(2);
    expect(scan.problems[1].line).toBe(4);
    expect(JSON.stringify(scan)).not.toContain('"b"');
  });

  test("scanJsonlFile on a healthy file reports no problems", async () => {
    const path = write("healthy.jsonl", [encodeJsonlLine({ a: 1 }), encodeJsonlLine({ b: "x\u2028y" })].join(""));
    const scan = await scanJsonlFile(path);
    expect(scan.records).toBe(2);
    expect(scan.parsed).toBe(2);
    expect(scan.terminated).toBe(true);
    expect(scan.problems).toEqual([]);
  });

  test("an empty file is not reported as truncated", async () => {
    const path = write("empty.jsonl", "");
    const scan = await scanJsonlFile(path);
    expect(scan.records).toBe(0);
    expect(scan.problems).toEqual([]);
    expect(await collect(path)).toEqual([]);
  });
});
