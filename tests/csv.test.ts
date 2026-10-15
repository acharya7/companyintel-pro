import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CsvParser, guessDelimiter, normalizeHeader, profileCsvFile, readCsvFile } from "../tools/indexer/src/csv";
import { escapeCsvField, exportFilename, toCsv, toCsvRow, type CsvColumn } from "../src/shared/csv";

function parse(text: string) {
  const parser = new CsvParser();
  const records = [...parser.push(text), ...parser.end()];
  return records.map((record) => record.fields);
}

describe("CSV parser", () => {
  test("parses plain rows and reports source line numbers", () => {
    const parser = new CsvParser();
    const records = [...parser.push("a,b,c\n1,2,3\n")];
    expect(records.map((record) => record.fields)).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(records[0].line).toBe(1);
    expect(records[1].line).toBe(2);
  });

  test("handles quoted fields containing delimiters, quotes and newlines", () => {
    const text = 'id,name,note\n1,"Acme, Inc.","line one"\n2,"He said ""hi""","multi\nline"\n3,"Tab\there",x\n';
    const rows = parse(text);
    expect(rows[1]).toEqual(["1", "Acme, Inc.", "line one"]);
    expect(rows[2]).toEqual(["2", 'He said "hi"', "multi\nline"]);
    expect(rows[3]).toEqual(["3", "Tab\there", "x"]);
  });

  test("multiline fields advance the reported line number correctly", () => {
    const parser = new CsvParser();
    const records = [...parser.push('a,"one\ntwo"\nb,c\n')];
    expect(records[0].fields).toEqual(["a", "one\ntwo"]);
    // The next record starts on the physical line after the embedded newline.
    expect(records[1].line).toBe(3);
  });

  test("handles CRLF and a UTF-8 BOM", () => {
    expect(parse("\uFEFFa,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("flushes a trailing record without a final newline", () => {
    expect(parse("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("supports alternative delimiters and quote characters", () => {
    const parser = new CsvParser({ delimiter: ";", quote: "'" });
    const records = [...parser.push("a;'b;c';d\n")];
    expect(records[0].fields).toEqual(["a", "b;c", "d"]);
  });

  test("survives chunk boundaries splitting a quoted field", () => {
    const parser = new CsvParser();
    // The header record completes in the first chunk; the quoted value does not.
    const first = [...parser.push('id,note\n1,"half')];
    const second = [...parser.push(' and half"\n')];
    expect(first.map((record) => record.fields)).toEqual([["id", "note"]]);
    expect(second[0].fields).toEqual(["1", "half and half"]);
  });

  test("guessDelimiter picks the most frequent candidate", () => {
    expect(guessDelimiter("a,b,c,d")).toBe(",");
    expect(guessDelimiter("a;b;c;d")).toBe(";");
    expect(guessDelimiter("a\tb\tc")).toBe("\t");
  });

  test("normalizeHeader reduces headers for alias matching", () => {
    expect(normalizeHeader("Company Name")).toBe("companyname");
    expect(normalizeHeader("E-Mail Address")).toBe("emailaddress");
    expect(normalizeHeader("Employees (total)")).toBe("employeestotal");
  });
});

describe("file reader and profiler", () => {
  test("reads a file end to end and profiles its columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-csv-"));
    const path = join(dir, "sample.csv");
    await writeFile(
      path,
      'Company Name,Website,Contact Email,Country\n"Acme, Inc.",https://acme.example,ada@acme.example,"United States"\nBeta Ltd,beta.example,,India\n',
      "utf8",
    );
    try {
      const rows = [];
      for await (const record of readCsvFile(path)) rows.push(record.fields);
      expect(rows).toHaveLength(3);
      expect(rows[1][0]).toBe("Acme, Inc.");

      const profile = await profileCsvFile(path, { knownFields: ["companyname", "companydomain", "email", "companycountry"] });
      expect(profile.headers).toEqual(["Company Name", "Website", "Contact Email", "Country"]);
      expect(profile.sampledRows).toBe(2);
      const website = profile.columns.find((column) => column.header === "Website");
      expect(website?.looksLike).toBe("url");
      const email = profile.columns.find((column) => column.header === "Contact Email");
      expect(email?.looksLike).toBe("email");
      expect(email?.emptyCount).toBe(1);
      expect(profile.unmappedHeaders).toContain("Contact Email");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("maxRecords bounds a sample run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-csv-"));
    const path = join(dir, "big.csv");
    await writeFile(path, `id\n${Array.from({ length: 50 }, (_, i) => i).join("\n")}\n`, "utf8");
    try {
      let count = 0;
      for await (const _record of readCsvFile(path, { maxRecords: 10 })) count += 1;
      // `maxRecords` bounds records yielded, and the header is the first record.
      expect(count).toBe(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CSV export safety", () => {
  test("defuses spreadsheet formula injection", () => {
    expect(escapeCsvField("=1+1")).toBe("'=1+1");
    expect(escapeCsvField("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(escapeCsvField("-2+3")).toBe("'-2+3");
    expect(escapeCsvField("@cmd")).toBe("'@cmd");
    expect(escapeCsvField("normal value")).toBe("normal value");
  });

  test("quotes and escapes values that need it", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvField(null)).toBe("");
  });

  test("writes a header and CRLF line endings", () => {
    const columns: CsvColumn<{ name: string; count: number }>[] = [
      { id: "name", header: "Name", value: (row) => row.name },
      { id: "count", header: "Count", value: (row) => row.count },
    ];
    const csv = toCsv([{ name: "Acme, Inc.", count: 3 }], columns);
    expect(csv).toBe('Name,Count\r\n"Acme, Inc.",3\r\n');
    expect(toCsvRow(["a"])).toBe("a");
  });

  test("filenames are safe and dated", () => {
    const name = exportFilename("contacts", "Acme / Inc. ***", new Date("2026-10-15T00:00:00Z"));
    expect(name).toBe("companyintel-contacts-acme-inc-2026-10-15.csv");
  });
});
