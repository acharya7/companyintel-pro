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
candidate budget (`defaultResultBudget = 400`, `defaultRetrievalBudget = 3000`). Queries under
3 characters use the prefix index instead of trigrams.

**Stage 2 — ranking** (`score.ts`): exact equality, alias equivalence, prefix similarity,
token overlap (with idf weighting), trigram Jaccard, bounded edit distance, word-order
tolerance and abbreviation compatibility, with penalties for generic-only matches
("international", "solutions", "services") and a query-length-aware minimum score.
Candidates are then filtered, sorted, and paginated.

Hydration is the expensive half, because a profile object is read **whole**: its cost is
`partitions read × partition bytes`, not "one candidate". Three bounds keep a cold query
inside a fixed budget regardless of how many candidates retrieval produced:

1. **Partition size.** `SHARDING.companiesPerPartition = 250`, so one profile object is
   ~25 KB (26.8 KB measured on the 20 K real-data sample: 2.2 MB / 82 objects). The same number
   must hold for a 20 K-company sample and for a 4.7 M-company production index, and only the
   partition size controls that.
2. **Per-search partition ceiling.** `SHARDING.maxHydrate` (default 16, ceiling 64,
   operator-tunable with the `SEARCH_MAX_HYDRATE` Worker variable, per-request override in
   `SearchOptions.maxHydrate`). Partitions are taken in candidate order, never re-read, and
the budget is spent across the engine's hydration batches — so a search reads at most
   `16 × ~25 KB ≈ 400 KB` of profile data however dispersed its candidates are.
3. **Early-stop barrier.** Once the requested page is full of hits that score strictly above
   `WEAK_CEILING = 0.95` — the highest relevance a token/trigram-only candidate can reach —
   the rest of the candidate list can neither reorder nor extend that page, so its tiers are
   never fetched. The count then becomes a floor, which the API already reports as `N+`
   (`page.totalIsLowerBound`).

`retrieval.scored` reports the documents actually hydrated, so the number in the search
sidebar is the real work done, not the candidate budget.

### Measured query cost

On the sample index built from the real `raw/file1.csv` + `raw/file2.csv` (20,265 companies,
19,414 contacts), with one fresh candidate source per query — exactly what the Worker does —
`bun scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version <version>`:

| query class | before: 2000 companies/object, unbounded hydration | after: 250 companies/object, 16-partition ceiling |
| --- | --- | --- |
| exact ("Microsoft Corporation") | 27 reads · 2.04 MB · 152 ms | 32 reads · 478 KB · 25 ms |
| alias ("Infosys Ltd") | 27 reads · 2.04 MB · 150 ms | 32 reads · 478 KB · 21 ms |
| prefix ("micro") | 19 reads · 1.99 MB · 102 ms | 24 reads · 431 KB · 16 ms |
| typo ("Microsft") | 22 reads · 2.01 MB · 110 ms | 27 reads · 442 KB · 23 ms |
| transposition ("Mircosoft") | 21 reads · 2.0 MB · 108 ms | 28 reads · 457 KB · 19 ms |
| multi-token | 30 reads · 2.1 MB · 130 ms | 35 reads · 512 KB · 21 ms |
| no result | 9 reads · 0.03 MB · 3 ms | 11 reads · 77 KB · 3 ms |

All figures are **local** (Bun, one vCPU): latency is CPU + decompression, not network to
Cloudflare, and the byte column is the cold-query volume the fake bucket served. Latency is
dominated by `JSON.parse` + gzip inflate + scoring, so the ~4× byte reduction is the number
that matters for the Worker CPU budget; the read count rises slightly because small objects
are what buy the byte reduction.

**The trade-off, stated plainly:** the 16-partition ceiling can return fewer rows than
hydrating all 400 candidates, for broad low-precision queries whose matches are spread over
more partitions than the budget covers (measured: 68 rows across 14 query classes at 16
partitions, 19 at 32, 4 at 64; the rows that *are* returned keep their order and score).
Under-filled pages are reported as `N+`, never as a fake total. Raising `SEARCH_MAX_HYDRATE`
buys those rows back at proportionally more bytes; the recall-correct fix is a layout whose
candidates cluster (refs ordered by normalized name), which was measured and **did not** pay
off on this data — the 400-candidate sets still spanned 20–50 of 82 partitions — so the
partition ceiling stays the honest knob until a 1 M-record run can be measured.

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
`directory.json`, so the reader never guesses and no query ever lists the bucket.

Object counts are a deliberate trade-off, not an accident: at 250 companies and 1000
companies-with-contacts per object, the measured full-input estimate (4.7 M organizations,
96.8 M people) lands at roughly 19 K company objects plus ~97 K contact objects — about
116 K objects, ~11–20 GB gzipped (scaled from the measured sample; see docs/cost.md). Small
profile objects are what bound the byte cost of a
search and of a company detail page (~25 KB); the price is more objects to upload and a
slightly larger per-query read count (R2 charges ~$0.36 per million Class B reads, so reads
are the cheap side of that trade).

The only LIST operation in the whole application is the bounded `raw/` listing on the Dataset
Management page (`GET /api/dataset/sources`, at most 25 objects, requested only when that page
is opened). Search, contact retrieval, exports and the app shell never list the bucket.

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
3. **Edge caching — deliberately narrow.** The Worker uses Cloudflare's edge cache in exactly two
   places: the Access JWKS fetch (`cf: { cacheTtl, cacheEverything }`) and immutable hashed static
   assets (`cache-control: public, max-age=31536000, immutable`; the HTML shell and export
   downloads are `no-store`). Dataset, contact, lead and settings responses are **not** put in a
   shared cache: they are private authenticated data behind Access, and the specification is
   explicit that shared edge caching should be skipped unless privacy can be demonstrated. Their
   R2 reads are already bounded (≤ 30 small objects per fuzzy query) and mostly absorbed by
   layers 1–2. Nothing mutable is ever cached anywhere shared, and Access verification happens
   before any cache or dataset work.
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

## API contract (implemented in `worker/src/app.ts`, schemas in `src/shared/api-contract.ts`)

Every `/api/*` route requires a verified Cloudflare Access identity, is same-origin only, is
rate limited per identity, and validates input with Zod. Errors are
`{ error: { code, message, requestId } }` with `400` (invalid), `401`/`403` (unauthenticated /
not allowed), `404`, `429` (rate limited), `500`, or `503` when no dataset version is active.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + environment + identity email |
| GET | `/api/dataset/status` | active/previous version, manifests, source ids, progress |
| GET | `/api/dataset/sources` | bounded LIST of `raw/` (≤ 25 objects) — Dataset page only |
| GET | `/api/dataset/stats` | pre-computed aggregate stats (dashboard charts) |
| POST | `/api/dataset/validate` | re-verify the active version's manifest, directory and a sample of objects |
| POST | `/api/dataset/activate` | atomically re-point the active version (rollback), with confirmation |
| GET | `/api/companies/search` | typo-tolerant company search (`q`, page, sort, filters, fuzzy, resultBudget) |
| GET | `/api/companies/:id` | company profile + facets + coverage |
| GET | `/api/companies/:id/contacts` | paginated, filtered contacts for one company |
| GET | `/api/contacts` | contacts across ≤ 50 selected company ids |
| GET | `/api/contacts/:id` | one contact |
| GET/POST/DELETE | `/api/leads`, `/api/leads/:id` | saved leads (R2, ETag-conditional writes) |
| GET/POST/DELETE | `/api/saved-searches`, `/api/saved-searches/:id` | saved search definitions |
| POST | `/api/saved-searches/:id/run` | re-run a saved search and stamp `lastRunAt` |
| GET/PUT | `/api/settings` | user preferences (cache, privacy, default page size) |
| GET/POST | `/api/activity` | recent-activity feed (batched writes, never per keystroke) |
| GET/POST | `/api/exports`, `/api/exports/:id`, `/api/exports/:id/download` | CSV export jobs (staged, injection-safe, row-capped) |

Paginated routes return `page: { page, pageSize, total, totalIsLowerBound, hasMore }`, so a
bounded search can report a lower bound honestly instead of a fabricated total. Search responses
include `datasetVersion`, `retrieval` (candidate counts per stage) and `tookMs`.

## Access control

`worker/src/access.ts` verifies the Cloudflare Access JWT on every `/api/*` request: RSA
signature against the team JWKS, `iss`, `aud`, `exp`/`nbf` with clock skew, and an email
allowlist (or Access service-token common name). Failure is `401`/`403`; a missing
configuration in production fails closed (`503`), never open. `DEV_ALLOW_UNAUTHENTICATED` is
refused whenever `ENVIRONMENT === "production"`. See `docs/security.md`.
