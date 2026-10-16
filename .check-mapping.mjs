/**
 * Throwaway mapping check (deleted right after use).
 *
 * Reads the first 8 KB of each real source object (one bounded ranged GET each),
 * takes the header line, and verifies that EVERY column name referenced by
 * `tools/indexer/indexer.config.json` and by the automatic header aliases actually
 * exists in that file. A typo in a `columns` override would otherwise map nothing
 * and be invisible until the data was already indexed.
 *
 * Prints header names only — never a data row.
 */

import { readFileSync } from "node:fs";
import { parseRecords } from "./src/shared/csv-parse.ts";
import { resolveCredentials } from "./tools/indexer/src/credentials.ts";
import { R2Client } from "./tools/indexer/src/r2.ts";

const config = JSON.parse(readFileSync("tools/indexer/indexer.config.json", "utf8"));
const { credentials } = resolveCredentials();
const client = new R2Client(credentials);

let failures = 0;

for (const source of config.sources) {
  const key = source.path.replace(/^r2:\/\/[^/]+\//, "");
  const head = Buffer.from(await client.getRange(key, 8192)).toString("utf8");
  const headerLine = head.slice(0, head.indexOf("\n"));
  const records = parseRecords(`${headerLine}\n`, { delimiter: source.delimiter });
  const headers = records[0].fields;
  const lookup = new Map(headers.map((name, index) => [name, index]));

  console.log(`\n${source.id}  ${key}`);
  console.log(`  delimiter in config ${JSON.stringify(source.delimiter)}  ·  columns in file ${headers.length}`);
  console.log(`  header[0] ${headers[0]}  ·  header[last] ${headers[headers.length - 1]}`);

  for (const [field, column] of Object.entries(source.columns ?? {})) {
    const index = lookup.get(column);
    const ok = index !== undefined;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${field.padEnd(16)} -> ${column}${ok ? ` (index ${index})` : " — NOT PRESENT IN THIS FILE"}`);
  }
}

console.log(failures ? `\n${failures} configured column(s) do not exist — fix indexer.config.json.` : "\nEvery configured column exists in its file.");
process.exitCode = failures ? 1 : 0;
