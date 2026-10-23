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
  const res = await app.fetch(new Request(base + path, { headers: { origin: base } }), env);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

for (const q of ["Microsoft", "Google", "jet freight logistics"]) {
  const r = await hit("/api/companies/search?q=" + encodeURIComponent(q) + "&pageSize=6");
  for (const h of r.body?.hits ?? []) {
    const d = await hit("/api/companies/" + h.id);
    const got = d.body?.company?.name;
    console.log(q, "| hit:", JSON.stringify(h.name), "id:", h.id, "-> detail:", JSON.stringify(got), got === h.name ? "OK" : "MISMATCH", "score", h.score ?? h.relevance);
  }
}
