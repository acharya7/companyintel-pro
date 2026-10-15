# CompanyIntel architecture

Private, single-user B2B company intelligence: typo-tolerant company search, per-company
contact discovery, saved leads, saved searches and CSV exports.

**Runtime is Cloudflare Workers. Persistent cloud storage is Cloudflare R2. Nothing else.**
There is no Convex, no Postgres/MySQL/Supabase/Firebase/Mongo, no D1, no KV, no Durable
Objects, no Redis/Upstash, no Elasticsearch/Algolia/Meilisearch/Typesense server and no VPS.

## Components

| Path | Role |
| --- | --- |
| `src/` | React 19 + Vite + Tailwind v4 frontend (shadcn/ui, TanStack Query, IndexedDB) |
| `worker/` | Cloudflare Worker: Hono API, Cloudflare Access verification, R2 access, CSV export |
| `src/shared/` | Canonical models, normalization, CSV utilities, API contract, search engine |
| `src/shared/search/` | Index formats, shard routing, candidate retrieval, ranking, scoring |
| `tools/indexer/` | Windows-compatible streaming CSV indexer (Node/Bun, disk-backed) |
| `tests/` | Unit, relevance, indexer, CSV, and Access-security tests (`bun test`) |
| `scripts/` | QA, benchmark and R2 verification helpers |
| `wrangler.toml` | Worker, static assets and `COMPANY_DATA` R2 binding |

`src/shared/**` is imported by the frontend, the Worker **and** the indexer, so query
normalization, ranking and index layout cannot drift between write and read paths.

## Data flow

```
raw/*.csv in R2  ──►  tools/indexer (local, streaming)  ──►  indexes|companies|contacts|manifests/<version>
                                   │                                      │
                                   └── staging/<version> ─────────────────┘
                                                                          │
                                            manifests/active.json ────────┘   (single mutable pointer)
                                                                          │
Browser ──► Worker (Access-verified) ──► bounded R2 reads ────────────────┘
```

1. The two original CSVs are uploaded once to `company-intel-data/raw/` and never modified.
2. The local indexer streams them, resolves entities conservatively, builds exact/prefix/
   token/trigram indexes plus company and contact partitions, validates checksums, uploads
   to `staging/<version>/`-adjacent versioned prefixes and only then publishes.
3. The Worker answers searches by reading a handful of immutable shard objects. It never
   lists the bucket and never touches a CSV at request time.

## Canonical model

`Company`: `id`, original `name`, `normalizedName`, `aliases`, `domain`, `website`,
`linkedinUrl`, industry/sub-industry, country/state/city, `companySize`, `revenue`,
`contactCount`, `sources[]`, `ambiguous?`, `facets`.

`Contact`: `id`, `companyId`, `fullName`, first/last name, title, designation, seniority,
department, email, phone, `linkedinUrl`, location, `source {source,row}`.

`facets` on each company (designation/department/seniority/country/city buckets plus
`emailAvailable` / `linkedinAvailable`) are precomputed at index time so the Company Details
filter dropdowns never require a scan.

### Entity resolution (conservative by design)

Strong evidence only, in priority order:

1. source-provided company id (strong within one file),
2. canonical LinkedIn company URL (strong across files),
3. normalized verified domain (strong across files),
4. normalized company name (weak — used only when **neither** side carries strong evidence).

A row's identifiers are **unioned**; rows merge when exactly one existing record matches any
of them. Two rows carrying *contradictory* strong identifiers are never merged. Same-name
companies with different domains stay separate records and are flagged `ambiguous` so the UI
can say so instead of silently combining them. Contact dedup uses email → LinkedIn →
(name + company + title); two people with the same name at the same company keep distinct
records when their titles differ.

## Search

Two stages, both bounded (`src/shared/search/engine.ts`):

**Stage 1 — candidate retrieval.** Normalize the query → exact index (all variants: primary,
legal-suffix-stripped, abbreviation-expanded, compact) → prefix index → token inverted index
→ character trigram index (rare grams first when df stats are available) → dedupe → strict
candidate budget (`defaultResultBudget = 800`, `defaultRetrievalBudget = 3000`). Queries under
3 characters use the prefix index instead of trigrams.

**Stage 2 — ranking** (`score.ts`): exact equality, alias equivalence, prefix similarity,
token overlap (with idf weighting), trigram Jaccard, bounded edit distance, word-order
tolerance and abbreviation compatibility, with penalties for generic-only matches
("international", "solutions", "services") and a query-length-aware minimum score.
Candidates are then filtered, sorted, and paginated. Only the budgeted candidate set is
hydrated from R2 (≤ `SHARDING.maxHydrate = 24` partition objects).

Match categories returned to the UI: `exact`, `alias`, `prefix`, `fuzzy`, `possible`. The UI
shows *"Showing similar results for …"* for corrected queries and *"Possible match"* for
weak ones; the typed query is never silently replaced.

## R2 layout (contract: `src/shared/search/index-format.ts`)

```
raw/                 original CSVs (app never writes here)
staging/<version>/   unpublished intermediate output
indexes/<version>/   exact|prefix|token|trigram|ids shards + directory.json
companies/<version>/ canonical company partitions (gzip JSON)
contacts/<version>/  contact partitions grouped by company (gzip JSON)
manifests/<version>/ manifest.json, validation.json, progress.json, stats.json
manifests/active.json  the ONE mutable pointer object
app-data/            leads/, saved-searches.json, settings.json, activity.json, exports/
backups/app-data/    snapshots written before lead mutations
```

Every search object is immutable and version-addressed, so browser and edge caches can treat
it as immutable for a year. Rollback = re-point `manifests/active.json`.

Shard counts (512 exact / 256 prefix / 256 token / 512 trigram / 256 ids) are recorded in
`directory.json`, so the reader never guesses and the object count stays in the low
thousands for ~10M companies — no million-object buckets, no single giant object, no listing
per query.

## Frontend

- Routes (`src/main.tsx`): `/` landing, `/dashboard`, `/companies`, `/companies/:companyId`,
  `/contacts`, `/leads`, `/saved-searches`, `/exports`, `/dataset`, `/settings`.
- `AppLayout` provides sidebar navigation, dataset status chip, theme toggle and command
  search entry point. Light and dark themes are provided by `next-themes` + Tailwind tokens in
  `src/index.css`.
- There is no signup, login, billing or guest flow: Cloudflare Access gates the whole origin.

## Caching (four layers)

1. **TanStack Query** — in-memory cache with request deduplication and per-query stale times.
2. **IndexedDB** (`src/lib/cache/persistent-cache.ts`) — bounded LRU with TTL, version-scoped
   keys, and contact redaction so sensitive contact pages are not retained indefinitely.
3. **Cloudflare Cache API** — only for immutable, version-addressed index objects; never for
   leads, settings or anything user-mutable. Access is enforced before any cache lookup.
4. **R2 versioned indexes** — immutable objects as the durable layer.

Cache keys include the dataset version, normalized query, fuzzy flag, filters, sort, page and
page size (`buildSearchCacheKey` / `buildContactCacheKey`), so `"Microsft"` and `"microsft "`
share an entry, and a new dataset version invalidates everything automatically.

## Application data in R2 (no database)

- Saved leads are partitioned documents (`app-data/leads/<partition>.json`) plus a small
  index object, written with **conditional PUTs (`etagMatches`)**; a failed precondition is a
  detected lost update, retried by the caller.
- Saved searches, settings and activity are single small JSON objects.
- Exports are staged: metadata object + CSV object, generated with bounded rows
  (`MAX_EXPORT_ROWS = 50_000`) and CSV-injection-safe escaping.
- Consistency is **read-after-write per object, not transactional**. Two tabs writing the same
  lead partition concurrently cannot silently overwrite each other: the conditional PUT fails,
  the mutation is re-run against fresh state, and a persistent conflict is surfaced as an error
  rather than corrupting the object.
- Before each lead-shard mutation the previous content is copied to
  `backups/app-data/<YYYY-MM-DD>/<label>.json` — at most one snapshot per object per day, so
  growth is bounded by partitions × days. See `docs/recovery.md` for restore steps.

## Access control

`worker/src/access.ts` verifies the Cloudflare Access JWT on every `/api/*` request: RSA
signature against the team JWKS, `iss`, `aud`, `exp`/`nbf` with clock skew, and an email
allowlist (or Access service-token common name). Failure is `401`/`403`; a missing
configuration in production fails closed (`503`), never open. `DEV_ALLOW_UNAUTHENTICATED` is
refused whenever `ENVIRONMENT === "production"`. See `docs/security.md`.
