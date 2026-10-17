/**
 * Live field-preservation check against the development API.
 *
 * Read-only. For a page of real companies and real contacts it reports, per record:
 * how many source columns arrived, the longest value, and whether anything is still
 * marked as truncated. It also confirms search hits stay lightweight.
 */
const base = process.env.API_BASE ?? "http://127.0.0.1:5173";

async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function summarise(label, attributes) {
  const entries = Object.entries(attributes ?? {});
  const lengths = entries.map(([, value]) => value.length);
  const longest = entries.slice().sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  return {
    label,
    columns: entries.length,
    maxLength: lengths.length ? Math.max(...lengths) : 0,
    over400: lengths.filter((length) => length > 400).length,
    truncated: entries.filter(([, value]) => value.endsWith("…")).length,
    longest: longest.map(([key, value]) => `${key}=${value.length}`),
  };
}

const queries = (process.env.QUERIES ?? "Tesla,MicrosoftCorp,Vertex").split(",");
for (const query of queries) {
  const search = await get(`/api/companies/search?q=${encodeURIComponent(query)}&pageSize=3`);
  console.log(`\nquery "${query}" on ${search.datasetVersion}: ${search.hits.length} hit(s)`);
  console.log(`  hit carries attributes? ${search.hits.some((hit) => "attributes" in hit)}`);
  for (const hit of search.hits.slice(0, 2)) {
    const detail = await get(`/api/companies/${encodeURIComponent(hit.id)}`);
    const info = summarise(detail.company.name, detail.company.attributes);
    console.log(`  company ${info.label}: ${info.columns} columns, longest ${info.maxLength}, >400 chars: ${info.over400}, ellipsis-marked: ${info.truncated}`);
    console.log(`    longest: ${info.longest.join(", ")}`);
  }
}

const people = await get("/api/contacts/search?q=smith&pageSize=4");
console.log(`\ncontact hits: ${people.hits.length} (matched ${people.matchedIds}${people.notHydrated ? `, not hydrated ${people.notHydrated}` : ""})`);
console.log(`hit carries attributes? ${people.hits.some((hit) => "attributes" in hit)}`);
for (const hit of people.hits.slice(0, 3)) {
  const detail = await get(`/api/contacts/${encodeURIComponent(hit.id)}`);
  const info = summarise(detail.contact.fullName, detail.contact.attributes);
  console.log(`  contact ${info.label}: ${info.columns} columns, longest ${info.maxLength}, >400 chars: ${info.over400}, ellipsis-marked: ${info.truncated}`);
  console.log(`    longest: ${info.longest.join(", ")}`);
}
