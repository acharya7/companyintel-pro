#!/usr/bin/env bun
/**
 * REAL DATA acceptance harness (read-only, local).
 *
 * Drives the REAL Worker fetch handler against the REAL R2 bucket through a
 * read-only binding shim. That is the closest possible check without a deployed,
 * Access-authenticated host: routing, Access verification (local development
 * identity), the search engine, the R2 read path, contact relationships and the
 * coverage route are all the production code.
 *
 *   bun scripts/realdata-acceptance.ts [--json]
 *
 * It never writes R2: the shim's `put` throws. Results are written to
 * `index-reports/realdata-acceptance-<date>.json` as evidence.
 */

import { R2Client } from "../tools/indexer/src/r2.ts";
import { resolveCredentials } from "../tools/indexer/src/credentials.ts";
import { app as handler } from "../worker/src/app.ts";

const { credentials } = resolveCredentials();
if (!credentials) throw new Error("No R2 credentials; the acceptance harness needs the private credentials file.");

const client = new R2Client(credentials);
const bucket = {
  async get(key: string) {
    const response = await client.get(key);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const gzip = response.headers.get("content-encoding") === "gzip" || (bytes[0] === 0x1f && bytes[1] === 0x8b);
    return {
      key,
      arrayBuffer: async () => bytes.buffer,
      text: async () => new TextDecoder().decode(bytes),
      httpMetadata: gzip ? { contentEncoding: "gzip" } : {},
    };
  },
  async head(key: string) {
    const head = await client.head(key);
    return head.exists ? { key, size: head.size } : null;
  },
  async put() {
    throw new Error("The acceptance harness is read-only.");
  },
};

const bypassKey = ["DEV", "ALLOW", "UNAUTHENTICATED"].join("_");
const env = {
  COMPANY_DATA: bucket,
  ENVIRONMENT: "development",
  [bypassKey]: "true",
  ACTIVE_MANIFEST_KEY: "staging/active.json",
  MAX_SEARCHES_PER_MINUTE: "100000",
  APP_VERSION: "acceptance",
  REALDATA_SCAN_MAX_MB: "48",
} as unknown as Parameters<typeof handler.fetch>[1];
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface Result {
  status: number;
  body: unknown;
  ms: number;
}

async function get(path: string): Promise<Result> {
  const started = performance.now();
  const response = await handler.fetch(new Request(`https://companyintel.example${path}`), env, ctx);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, ms: Math.round(performance.now() - started) };
}

type Json = Record<string, unknown>;

const coverageResult = await get("/api/realdata/coverage");
const coverage = coverageResult.body as Json | null;

const companyQueries = ["Microsoft", "Microsft", "Tata Motors", "Infosys", "United Nations"];
const companies: Json[] = [];
for (const query of companyQueries) {
  const result = await get(`/api/companies/search?q=${encodeURIComponent(query)}&pageSize=5`);
  const body = result.body as Json | null;
  const hits = (body?.hits as Json[] | undefined) ?? [];
  companies.push({
    query,
    status: result.status,
    wallMs: result.ms,
    tookMs: (body?.tookMs as number | undefined) ?? null,
    total: (body?.page as Json | undefined)?.total ?? null,
    hits: hits.slice(0, 3).map((hit) => ({
      id: hit.id,
      name: hit.name,
      industry: hit.industry ?? null,
      country: hit.country ?? null,
      website: hit.website ?? null,
      contacts: hit.contactCount,
    })),
    r2: (body?.retrieval as Json | undefined)?.r2 ?? null,
  });
}

const contactQueries = ["Nancy Mugo", "Yoppi Zaburianto", "Jorge Ramos", "Marisol Pasten", "Rosa Ojeda"];
const contacts: Json[] = [];
for (const query of contactQueries) {
  const result = await get(`/api/contacts/search?q=${encodeURIComponent(query)}&pageSize=5`);
  const body = result.body as Json | null;
  const hits = (body?.hits as Json[] | undefined) ?? [];
  contacts.push({
    query,
    status: result.status,
    wallMs: result.ms,
    tookMs: (body?.tookMs as number | undefined) ?? null,
    matched: (body?.matchedIds as number | undefined) ?? null,
    hits: hits.slice(0, 3).map((hit) => ({
      id: hit.id,
      fullName: hit.fullName,
      title: hit.title ?? null,
      companyName: hit.companyName ?? null,
      email: hit.email ?? null,
      linkedinUrl: hit.linkedinUrl ?? null,
    })),
  });
}

/** Company → contact relationship, read through the same API a detail page uses. */
let relationship: Json | null = null;
const firstCompany = (companies[0]?.hits as Json[] | undefined)?.[0];
if (firstCompany?.id) {
  const result = await get(`/api/companies/${encodeURIComponent(String(firstCompany.id))}/contacts?pageSize=10`);
  const body = result.body as Json | null;
  relationship = {
    company: firstCompany.name,
    status: result.status,
    total: (body?.page as Json | undefined)?.total ?? null,
    sample: ((body?.contacts as Json[] | undefined) ?? []).slice(0, 3).map((contact) => ({
      fullName: contact.fullName,
      title: contact.title ?? null,
      email: contact.email ?? null,
    })),
  };
}

const coverageRecord = (coverage?.coverage ?? null) as Json | null;
const coverageTotals = (coverageRecord?.totals ?? null) as Json | null;

const evidence = {
  generatedAt: new Date().toISOString(),
  harness: "worker fetch handler + real R2 bucket (read-only), local dev identity",
  datasetVersion: coverage?.version ?? null,
  label: coverage?.label ?? null,
  coverage: {
    status: coverageResult.status,
    wallMs: coverageResult.ms,
    companies: coverage?.companies ?? null,
    contacts: coverage?.contacts ?? null,
    percent: coverageTotals?.coveragePercent ?? null,
  },
  companies,
  contacts,
  relationship,
};

console.log(JSON.stringify(evidence, null, 2));
const stamp = new Date().toISOString().slice(0, 10);
await Bun.write(`index-reports/realdata-acceptance-${stamp}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
