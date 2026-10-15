/**
 * RFC 4180 CSV writing with spreadsheet formula-injection protection.
 *
 * Used by both the Worker (small, bounded exports) and the browser (sample
 * exports) so an export produced in either place is byte-compatible.
 *
 * Formula injection: a cell whose text starts with `=`, `+`, `-`, `@`, TAB or
 * CR is executed as a formula by Excel / Sheets / LibreOffice when the file is
 * opened. Untrusted values (company names, contact titles, notes) are therefore
 * prefixed with an apostrophe, which spreadsheets display literally.
 */

const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** Escape one field for CSV output (always quoted when needed). */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  // Defuse formula injection before quoting.
  if (RISKY_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Serialize one row. */
export function toCsvRow(values: unknown[]): string {
  return values.map(escapeCsvField).join(",");
}

export interface CsvColumn<T> {
  id: string;
  header: string;
  value: (row: T) => unknown;
}

/** Serialize a full document. For very large exports use `csvChunks` instead. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = toCsvRow(columns.map((c) => c.header));
  const body = rows.map((row) => toCsvRow(columns.map((c) => c.value(row))));
  return [head, ...body].join("\r\n") + "\r\n";
}

/**
 * Serialize rows in bounded chunks so a large export never has to exist in
 * memory all at once (`Worker` streams these; the browser joins them).
 */
export function* csvChunks<T>(rows: Iterable<T>, columns: CsvColumn<T>[], chunkSize = 500): Generator<string> {
  yield toCsvRow(columns.map((c) => c.header)) + "\r\n";
  let buffer: string[] = [];
  for (const row of rows) {
    buffer.push(toCsvRow(columns.map((c) => c.value(row))));
    if (buffer.length >= chunkSize) {
      yield buffer.join("\r\n") + "\r\n";
      buffer = [];
    }
  }
  if (buffer.length) yield buffer.join("\r\n") + "\r\n";
}

/** Only these columns may ever be exported; they must exist in real data. */
export const EXPORT_COLUMNS = {
  contact: [
    "fullName",
    "firstName",
    "lastName",
    "title",
    "designation",
    "seniority",
    "department",
    "email",
    "phone",
    "linkedinUrl",
    "companyName",
    "companyDomain",
    "industry",
    "country",
    "state",
    "city",
    "sourceFile",
    "sourceRow",
  ],
  company: [
    "name",
    "domain",
    "website",
    "linkedinUrl",
    "industry",
    "subIndustry",
    "country",
    "state",
    "city",
    "companySize",
    "revenue",
    "contactCount",
    "sources",
  ],
  lead: ["kind", "name", "companyName", "title", "email", "linkedinUrl", "status", "tags", "notes", "savedAt"],
} as const;

export const EXPORT_COLUMN_HEADERS: Record<string, string> = {
  fullName: "Contact Name",
  firstName: "First Name",
  lastName: "Last Name",
  title: "Job Title",
  designation: "Designation",
  seniority: "Seniority",
  department: "Department",
  email: "Email",
  phone: "Phone",
  linkedinUrl: "LinkedIn",
  companyName: "Company",
  companyDomain: "Company Domain",
  industry: "Industry",
  country: "Country",
  state: "State",
  city: "City",
  sourceFile: "Source File",
  sourceRow: "Source Row",
  name: "Company Name",
  domain: "Domain",
  website: "Website",
  subIndustry: "Sub Industry",
  companySize: "Company Size",
  revenue: "Revenue",
  contactCount: "Contact Count",
  sources: "Sources",
  kind: "Kind",
  status: "Status",
  tags: "Tags",
  notes: "Notes",
  savedAt: "Saved At",
};

/** Build a friendly, filesystem-safe export filename. */
export function exportFilename(kind: string, label: string, stamp = new Date()): string {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "export";
  const date = stamp.toISOString().slice(0, 10);
  return `companyintel-${kind}-${safe}-${date}.csv`;
}
