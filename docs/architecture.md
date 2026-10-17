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
department, email, phone, `linkedinUrl`, location, `source {source,row}`, `association?`
(`category`, `reason`, `evidence`, candidate ids, `movedFrom`). `UnassignedContact` is a contact
with `companyId: ""` plus the `claimedCompanyName` / `claimedNormalizedName` it was preserved
under. A company also carries `associations {highConfidence, plausible, conflicting, total}`.

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
can say so instead of silently combining them. Identifier ownership is **first-owner-wins and
never reassigned**: a later row that carries a domain already owned by another record has its
claim refused (counted and sampled), so file order can no longer change which company a domain
points at. Source-provided ids are scoped to their file (`s:<source>:<id>`).

Company resolution and contact association are two separate stages: resolution answers "which
company is this row about", and a second stage asks "does this person work there", per contact,
against every credible company of the same normalized name, based on the row's identity, the
email domain, and country. Its verdict is one of `high_confidence` / `plausible` / `unresolved` /
`conflicting`; an unresolved contact is preserved in `unassigned/` under the name it claimed
rather than attached to a guess. Contact dedup uses email → LinkedIn → (name + company + title),
computed **after** the association decision and scoped to the final company, so reassignment
cannot merge two different people or duplicate one person; two people with the same name at the
same company keep distinct records when their titles differ. Full rules: `docs/association.md`.

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
4. **Adaptive hydration ladder** (`SearchOptions.adaptiveHydration`, default on, factor
   `ADAPTIVE_HYDRATE_FACTOR = 2`, rungs `ADAPTIVE_HYDRATE_MAX_STEPS = 2`)
   — 16 → 32 → 64. A short page is the one case where more bytes are worth
   spending, so the engine re-walks the same candidate order with a doubled partition budget —
   but only when the previous sweep was cut short *by that budget*. The source reports
   `hydrationBudgetHit()`, which is the difference between "more budget would find more
   companies" and "there are no more companies to find". It stops only on evidence about the
   whole candidate set: the page is full of hits above `WEAK_CEILING`, every candidate has
   been hydrated (`retrieval.ladderStopped = "candidates_exhausted"`), the source says the
   last sweep dropped nothing for budget, or `SEARCH_LIMITS.maxHydrate` (64) is reached. A
   rung that ranks nothing is NOT a stop — it says nothing about the partitions it did not
   reach, and an earlier rule that used it lost valid results.

   The ladder is affordable because a format-v4 partition is a **search projection**: 21 KB
   on the 20 K index instead of 1.2 MB with the source columns, so 64 partitions ≈ 1.35 MB.
   See “Format v4” below.
5. **Whole-name gating** (`retrieval.fuzzyDeferred` / `fuzzyRecovered`). When the exact and
   prefix stages already produced at least a page of candidates, the token and trigram
   *retrieval* stages are skipped — up to 24 shard reads saved for the most common query
   shape. It is a deferral, not a decision: if hydration cannot fill the page without them,
   they run before the search returns.
6. **Truncation accounting** (`retrieval.truncated`). The candidate list is cut to
   `resultBudget` from the weakest evidence upward; how many were dropped is reported and
   makes the result count a floor, instead of being invisible.

`retrieval.scored` reports the documents actually hydrated, so the number in the search
sidebar is the real work done, not the candidate budget. `retrieval.hydrationPasses`,
`hydrateBudget`, `budgetLimited`, `candidates` and `truncated` are the rest of the per-search
measurement, and the Worker adds `retrieval.r2` (objects, bytes, shard/partition reads, cache
hits) on the way out. The measurements, the before/after comparisons and the residual gaps
are in **`docs/search-quality.md`**.

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

**The trade-off, stated plainly.** The partition ceiling can return fewer rows than hydrating
every candidate, for broad low-precision queries whose matches are spread over more partitions
than the budget covers. `bun scripts/benchmark-hydration.mjs` measures exactly that on the
real-data sample (`.indexer-output`, 20,265 companies, 82 company partitions) and is the
command to re-run after any tuning change:

| strategy | rows returned (8 query classes) | rows lost vs the complete answer | top-25 of the reference kept | R2 bytes read per query | R2 GETs |
| --- | --- | --- | --- | --- | --- |
| fixed 16 (old default) | 70 | 20 | 56/90 | 421 KB | 36 |
| fixed 32 | 90 | 0 | 75/90 | 749 KB | 52 |
| fixed 64 | 90 | 0 | 90/90 | 1.34 MB | 84 |
| adaptive 16 → 32 (previous default) | 90 | 0 | 75/90 | 749 KB | 52 |
| **adaptive 16 → 32 → 64 (current)** | **90** | **0** | **75/90** | **1.15 MB** | **84** |
| reference (every partition) | 90 | 0 | 90/90 | 1.34 MB | 84 |

Broad queries ("global", "services", "consulting") were the ones losing 5–8 rows each; the
ladder recovers all of them, and the cost is paid only by a query whose page is still short
after the first sweep. Two consequences worth keeping in view:

- `rows lost` is a count and can hide a ranking difference: three of those queries return a
  *full* page of 25 rows at every strategy while keeping only 75 of the reference's 90 best
  rows. `top-25` is the column that shows it, which is why the benchmark prints it next to
  the row counts.
- a query whose true match count is **below** the page size pays the rungs on every search and
  cannot fill its page either way. Only knowing the match count before reading removes that
  cost, which is a format question, not a tuning one (see `docs/search-quality.md` §9).

Format v3 was taken by the association work (`docs/association.md`): it adds `association` to
contacts, `associations` to companies and the `unassigned/` object class. The *search* alternatives
below were evaluated for a later format version and are **not** adopted, because each needs a 1 M
run to measure it:

| candidate design | why it is not in v2 |
| --- | --- |
| candidate→partition clustering (refs ordered so one partition holds likely co-matches) | measured on this data and did not pay off: the 400-candidate sets still spanned 20–50 of 82 partitions |
| search-aware partition ordering during retrieval | already effectively present — partitions are taken in candidate (prominence) order, so the cap spends itself on the best candidates first |
| compact metadata side index (name/tokens/contact count per partition, one small object) | the honest fix for the sparse-query case above: it would let the engine stop early with a *proven* total instead of a floor. Needs a new object class + format version + a full rebuild, so it must be validated against the 1 M benchmark first |
| Top-K retrieval / score-bound early stopping | the existing `WEAK_CEILING` barrier already implements the provable case; a tighter bound needs per-partition max-score metadata (same dependency as above) |
| exact-match fast path / prefix optimisation | already present: exact hits short-circuit the fuzzy passes and short queries use the prefix index (`maxPrefixLength = 12`) |

Under-filled pages are reported as `N+` (`totalIsLowerBound`), never as a fake total, and the
search sidebar shows the real hydrated document count (`retrieval.scored`).

Match categories returned to the UI: `exact`, `alias`, `prefix`, `fuzzy`, `possible`. The UI
shows *"Showing similar results for …"* for corrected queries and *"Possible match"* for
weak ones; the typed query is never silently replaced.

## R2 layout (contract: `src/shared/search/index-format.ts`)

```
raw/                 original CSVs (app never writes here)
staging/<version>/   unpublished intermediate output
indexes/<version>/   exact|prefix|token|trigram|ids shards + contactToken|contactPrefix|contactTrigram
                     (the person-name index) + directory.json
companies/<version>/ company SEARCH PROJECTIONS — what a query matches, ranks, filters
                     and shows (gzip JSON; no source columns, no facets)
contacts/<version>/  contact projections grouped by company (gzip JSON)
details/<version>/   FULL records: companies/ and contacts/ objects on the same partition
                     boundaries, aligned by ref (format v4)
unassigned/<version>/ contacts preserved WITHOUT an employer (format v3)
manifests/<version>/ manifest.json, validation.json, progress.json, stats.json
manifests/active.json  the ONE mutable pointer object
app-data/            leads/, saved-searches.json, settings.json, activity.json, exports/
backups/app-data/    snapshots written before lead mutations
```

`unassigned/` is one object per Pass 1 spool partition, keyed by the hash of the *claimed*
company name, so a company profile can find its review list from the company record alone — no
listing and no scan. Format v2 indexes have no such prefix and stay readable; see
`docs/association.md` §6 for the full v2 → v3 delta and the compatibility rules.

Every search object is immutable and version-addressed, so browser and edge caches can treat
it as immutable for a year. Rollback = re-point `manifests/active.json`.

### Format v4 — search projections + detail objects

A source record here has 70–106 columns. Baking them into the objects a search hydrates made
every query pay for fields it never reads: a 20 K-row development index had **1.2 MB
partitions** and one exact query read **78.5 MB**. Format v4 splits the two uses:

| object | holds | read by |
| --- | --- | --- |
| `companies/<v>/#####.json.gz` | identity, canonical fields, aliases, counts, sources, **21 KB** per 250 companies | every search (sorted hydration) |
| `details/<v>/companies/#####.json.gz` | `attributes` (every source column, verbatim) and `facets` | a company record view — exactly one object |
| `contacts/<v>/#####.json.gz` | canonical contact fields, association record, source ref | contact lists, filters, search |
| `details/<v>/contacts/#####.json.gz` | contact `attributes` | a contact record view |

Design choices that matter:

- **Same partitions, same refs.** The detail object shares `firstRef` and record order with its
  projection, so the two halves cannot drift and the reader indexes the detail array by
  `ref - firstRef` — no mapping table, no second key space.
- **One detail object per partition, not per record.** At 250 companies per object the object
  count stays what it already was (~19 K for the full corpus), rather than the ~1.2 M tiny
  objects a per-record layout would need. Opening a record is one read of similar size to the
  v3 partition it replaces; a search no longer reads that object at all.
- **`details/` is cacheable.** It is immutable and version-addressed, so the same isolate cache
  that serves shards serves record views.
- **An index is still validated as a whole.** The builder fails validation if a populated
  index has no detail objects (`missing_detail_objects`), because that index would search fine
  and open every record without its columns — silent data loss a checksum cannot catch.
- **v3 stays readable.** The reader checks the directory's `formatVersion`; below 4 the
  partitions carry `attributes` inline and no detail object is read. The previously published
  `dev-r2-20k-fields-20261017` remains a valid rollback target without a rebuild.

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

## Contact search (`worker/src/contact-search.ts`)

Companies are found by document ref; people are found by id, because a contact lives *inside* its
company's contact object and its position there is not part of its identity. The person-name index
(`shards.contactIndex` in the directory) therefore stores contact ids, and hydration is two bounded
hops:

```
term  → contactToken / contactPrefix / contactTrigram shards        (ids in postings)
id    → the ids index  →  company ref, or -(partition+1) for a preserved contact
ref   → contacts/<version>/<partition>.json.gz  (batched)  →  the record
```

* the negative ids ref is how a contact kept WITHOUT an employer is addressed: it points at the
  `unassigned/<version>/<partition>.json.gz` object that holds it, and both search and
  `/api/contacts/:id` resolve it. A preserved contact stays fully searchable and its employer is
  reported as unconfirmed rather than invented;
* an index built before the contact index existed has no `shards.contactIndex`, and
  `/api/contacts/search` answers `400` with that reason instead of an empty result — "not indexed"
  and "no such person" are different claims and the API never conflates them;
* budgets mirror company search: deduplicated shard reads (concurrency 8), a fixed scored-candidate
  cap, at most 12 contact objects and 60 hydrated contacts per search, and the trigram stage only
  runs when the strong stages produced little to rank;
* ranking is name-shaped: exact name, whole-name prefix, per-word prefix ("Nade" → "Nadella"),
  token overlap, bounded per-token edit distance ("Nadela", "Umapathii") and trigram dice as the
  last resort. A candidate that retrieval accepted but no rule can justify is dropped, so a typo
  stage can never present an unrelated person as a hit.

## Frontend

- Routes (`src/main.tsx`): `/` landing, `/dashboard`, `/companies`, `/companies/:companyId`,
  `/contacts`, `/contacts/:contactId`, `/leads`, `/saved-searches`, `/exports`, `/dataset`,
  `/settings`.
- `/companies` is one search surface with a source selector (All / Companies / Contacts);
  `/contacts/:contactId` is the full person record, including every captured source column and the
  association evidence behind its employer.
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
4. **Isolate object cache** (`worker/src/search-cache.ts`) — a bounded LRU (512 entries,
   16 MiB, 10-minute maximum age) of *immutable* index objects only: `indexes/`, `companies/`,
   `contacts/`. Mutable `app-data/` and `manifests/` reads bypass it, concurrent reads of one
   key are joined into a single R2 GET, and the cache is held per R2 binding, so two datasets
   can never serve each other's bytes. Measured: a repeated query on a warm isolate reads
   **zero** objects from R2 (docs/search-quality.md §7).
5. **R2 versioned indexes** — immutable objects as the durable layer.

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
