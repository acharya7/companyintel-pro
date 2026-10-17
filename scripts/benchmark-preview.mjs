/**
 * Read-only HTTP measurement against the running Freebuff preview.
 *
 * Same queries in both runs, so the numbers are comparable across index versions:
 * company search (exact / fuzzy / sparse / broad), contact search, and one record
 * open from each. Each request is made twice: the first is cold for this isolate,
 * the second shows what the isolate cache keeps.
 *
 *   bun scripts/benchmark-preview.mjs before
 *   bun scripts/benchmark-preview.mjs after
 */
const label = process.argv[2] ?? "run";
const base = "http://127.0.0.1:5173";

async function timed(path) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  return { status: response.status, ms: performance.now() - started, body };
}

function summarize(result) {
  const { body } = result;
  return {
    status: result.status,
    ms: Math.round(result.ms),
    hits: Array.isArray(body.hits) ? body.hits.length : null,
    total: body.page?.total ?? body.total ?? null,
    bytes: body.retrieval?.r2?.bytesRead ?? null,
    objects: body.retrieval?.r2?.objectsRead ?? null,
    partitions: body.retrieval?.r2?.partitionRequests ?? body.retrieval?.r2?.partitionGets ?? null,
    cacheHits: body.retrieval?.r2?.cacheHits ?? null,
    candidates: body.retrieval?.candidates ?? null,
    scored: body.retrieval?.scored ?? null,
    ladder: body.retrieval?.ladderStopped ?? null,
  };
}

const status = await timed("/api/dataset/status");
console.log(`${label}: active version ${status.body.activeVersion ?? status.body.version ?? "?"} · format ${status.body.formatVersion ?? "?"}`);

const companyQueries = [
  ["company exact", "/api/companies/search?q=Microsoft&pageSize=25"],
  ["company fuzzy", "/api/companies/search?q=microsft&pageSize=25"],
  ["company sparse", "/api/companies/search?q=qualtrics&pageSize=25"],
  ["company broad", "/api/companies/search?q=global%20technology&pageSize=25"],
];
const contactQueries = [
  ["contact exact", "/api/contacts/search?q=Ada&pageSize=25"],
  ["contact fuzzy", "/api/contacts/search?q=ad&pageSize=25"],
];

const rows = [];
for (const [name, path] of [...companyQueries, ...contactQueries]) {
  const cold = await timed(path);
  const warm = await timed(path);
  rows.push({ name, ...summarize(cold), warmMs: Math.round(warm.ms), warmBytes: cold.body.retrieval?.r2?.bytesRead === undefined ? null : (warm.body.retrieval?.r2?.bytesRead ?? 0) });
}

// Record open: the first company hit, and one of its contacts.
const first = await timed("/api/companies/search?q=Microsoft&pageSize=1");
const companyId = first.body.hits?.[0]?.id;
let detailRow = null;
if (companyId) {
  const detail = await timed(`/api/companies/${companyId}`);
  const contacts = await timed(`/api/companies/${companyId}/contacts?pageSize=5`);
  const contactId = contacts.body.items?.[0]?.id ?? contacts.body.contacts?.[0]?.id;
  let contactDetail = null;
  if (contactId) contactDetail = await timed(`/api/contacts/${contactId}`);
  detailRow = {
    name: "company record",
    ms: Math.round(detail.ms),
    columns: detail.body.company?.attributes ? Object.keys(detail.body.company.attributes).length : 0,
    longest: Math.max(0, ...Object.values(detail.body.company?.attributes ?? {}).map((value) => String(value).length)),
    contactColumns: contactDetail?.body?.contact?.attributes ? Object.keys(contactDetail.body.contact.attributes).length : 0,
    contactMs: contactDetail ? Math.round(contactDetail.ms) : null,
  };
}

console.log(JSON.stringify({ label, rows, detail: detailRow }, null, 2));
