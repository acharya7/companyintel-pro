import { R2Client } from "./tools/indexer/src/r2.ts";
import { resolveCredentials } from "./tools/indexer/src/credentials.ts";
import { app } from "./worker/src/app.ts";

const { credentials } = resolveCredentials();
const client = new R2Client(credentials);
const bucket = {
  async get(key) { const r = await client["sign"]("GET", key); if (!r.ok) return null; return { key, size: Number(r.headers.get("content-length") ?? 0), etag: r.headers.get("etag"), uploaded: new Date(), httpMetadata: { contentEncoding: r.headers.get("content-encoding") ?? undefined }, body: r.body, arrayBuffer: () => r.arrayBuffer() }; },
  async put(key) { return { key, etag: "x", size: 0 }; },
  async head(key) { const h = await client.headDetailed(key); return h.exists ? { key, size: h.size, uploaded: new Date(), httpMetadata: {} } : null; },
  async list() { return { objects: [], truncated: false }; },
  async delete() {},
};
const env = { COMPANY_DATA: bucket, ENVIRONMENT: "development", DEV_ALLOW_UNAUTHENTICATED: "true" };
const base = "https://app.local";
const hit = async (path) => {
  const t = Date.now();
  const res = await app.fetch(new Request(base + path, { headers: { origin: base } }), env);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ms: Date.now() - t, body };
};

const cov = await hit("/api/realdata/coverage");
console.log("COVERAGE", cov.status, cov.ms + "ms", cov.body?.coverageStatus, cov.body?.activeVersion, JSON.stringify(cov.body?.totals));

const queries = ["jet freight logistics", "Google", "Salesforce", "Microsoft", "Microsoft Corpo", "Gooogle"];
for (const q of queries) {
  const r = await hit("/api/companies/search?q=" + encodeURIComponent(q) + "&pageSize=5");
  const names = (r.body?.hits ?? []).slice(0, 3).map((h) => h.name ?? h.companyName ?? h.id);
  const notice = r.body?.notice ? JSON.stringify(String(r.body.notice).slice(0, 90)) : "null";
  console.log("SEARCH " + JSON.stringify(q) + " -> " + r.status + " " + r.ms + "ms hits=" + (r.body?.hits?.length ?? 0) + " total=" + (r.body?.page?.total ?? "?") + " notice=" + notice + " :: " + names.join(" | "));
}

const first = await hit("/api/companies/search?q=Microsoft&pageSize=3");
const id = first.body?.hits?.[0]?.id;
const p2 = await hit("/api/companies/search?q=Microsoft&pageSize=3&page=2");
console.log("PAGE2", p2.status, (p2.body?.hits ?? []).map((h) => h.id).join(","), "first", id, "different", (p2.body?.hits?.[0]?.id ?? "") !== id);
const det = await hit("/api/companies/" + id);
console.log("DETAIL", det.status, det.body?.company?.name, "industry", det.body?.company?.industry, "country", det.body?.company?.country);
const cts = await hit("/api/companies/" + id + "/contacts?pageSize=5");
console.log("COMPANY CONTACTS", cts.status, cts.body?.page?.total, (cts.body?.contacts ?? []).slice(0, 2).map((c) => c.fullName));

for (const q of ["priya sharma", "satya nadella", "john smyth", "zzzzqqq"]) {
  const r = await hit("/api/contacts/search?q=" + encodeURIComponent(q) + "&pageSize=5");
  const rows = (r.body?.hits ?? []).slice(0, 2).map((h) => h.fullName + "@" + (h.companyName ?? "unassigned"));
  console.log("PEOPLE " + JSON.stringify(q) + " -> " + r.status + " " + r.ms + "ms hits=" + (r.body?.hits?.length ?? 0) + " matched=" + (r.body?.matchedIds ?? "?") + " corrected=" + (r.body?.correctedQuery ?? "null") + " :: " + rows.join(" | "));
}

const cid = (await hit("/api/contacts/search?q=priya&pageSize=1")).body?.hits?.[0]?.id;
if (cid) {
  const cd = await hit("/api/contacts/" + cid);
  console.log("CONTACT DETAIL", cd.status, cd.body?.contact?.fullName, "company", cd.body?.company?.name);
}
const st = await hit("/api/dataset/status");
console.log("STATUS", st.status, st.body?.indexed, st.body?.activeVersion, st.body?.bucketOk);
