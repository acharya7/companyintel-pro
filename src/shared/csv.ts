/**
 * CSV export: build a downloadable file from indexed rows.
 *
 * Exports leave the machine (downloaded, pasted into a spreadsheet), so two
 * rules apply to every cell:
 *
 *   1. Formula injection is defused — a value beginning with `=`, `+`, `-` or
 *      `@` is prefixed with `'`, so a company named `=cmd|' /C calc'!A0` is data
 *      rather than a command in Excel/LibreOffice.
 *   2. Anything containing a quote, comma or newline is quoted with doubled
 *      quotes, and rows are separated with CRLF, which every spreadsheet reads.
 *
 * This is the *writer*. CSV parsing for indexing lives in `./csv-parse.ts`;
 * `EXPORT_COLUMN_HEADERS` turns the API's column ids into the human-readable
 * headers a person expects in the file.
 */

export interface CsvColumn<T> {
  /** Stable column id, as sent by the client in the export request. */
  id: string;
  /** Header written to the file. */
  header: string;
  value: (row: T) => unknown;
}

/** Header text for every column id the export API accepts. */
export const EXPORT_COLUMN_HEADERS: Record<string, string> = {
  // saved leads
  kind: "Type",
  name: "Name",
  companyName: "Company",
  title: "Job Title",
  email: "Email",
  linkedinUrl: "LinkedIn",
  status: "Status",
  tags: "Tags",
  notes: "Notes",
  savedAt: "Saved At",
  // companies
  domain: "Domain",
  website: "Website",
  industry: "Industry",
  country: "Country",
  city: "City",
  companySize: "Company Size",
  contactCount: "Contacts",
  // contacts
  fullName: "Contact Name",
  designation: "Designation",
  seniority: "Seniority",
  department: "Department",
  phone: "Phone",
  sourceFile: "Source File",
};

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/** Escape one cell: defuse formulas, then quote when the value requires it. */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (!text) return "";
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CRLF-free CSV line from already-ordered values. */
export function toCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvField).join(",");
}

/** A complete CSV document: header line plus one line per row, CRLF-separated. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [toCsvRow(columns.map((column) => column.header))];
  for (const row of rows) lines.push(toCsvRow(columns.map((column) => column.value(row))));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Safe, dated file name: `companyintel-<kind>-<subject>-<YYYY-MM-DD>.csv`.
 * The subject is reduced to lowercase alphanumerics so a company name like
 * `Acme / Inc. ***` can never escape the download directory or the header.
 */
export function exportFilename(kind: string, subject: string, date: Date = new Date()): string {
  const slug = (input: string) =>
    input
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const safeKind = slug(kind) || "export";
  const safeSubject = slug(subject) || safeKind;
  return `companyintel-${safeKind}-${safeSubject}-${date.toISOString().slice(0, 10)}.csv`;
}
