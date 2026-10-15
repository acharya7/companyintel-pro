# Verification report (phases A–F)

What was **executed** in this environment, what it proved, what is **BLOCKED**, and what you
must run on your own machine. Nothing here is inferred from type-checking alone: every claim
names the command or test that produced it.

Run everything below yourself with (all commands are read-only unless marked otherwise):

```bash
bun run check                          # 5 typechecks + 249 tests
bun run verify:r2:remote               # read-only probe of the REAL bucket (no keys at all)
bun run verify:r2:remote --json > raw-verification.json
bun scripts/benchmark-r2-path.mjs      # R2-backed search path
bun scripts/benchmark-search.mjs       # engine + labelled relevance
bun scripts/verify-raw.mjs --json      # (S3-key alternative) real object inventory
bun scripts/profile-raw.mjs --list     # (S3-key alternative) real object listing + schemas
```

## Fixes made in this phase (all found by executing, not reviewing)

| # | Defect found | Impact before the fix | Now covered by |
| --- | --- | --- | --- |
| 1 | Indexer uploaded gzip shards **without `content-encoding`**, while the Worker only gunzipped when that metadata was present | A real deployment would have shown an **empty dataset** after a perfect indexing run | `tests/r2-client.test.ts` (header is signed), `worker/src/store.ts` also sniffs the `1f 8b` magic bytes, `tests/e2e-index.test.ts` ("gzip without content-encoding metadata is still readable") |
| 2 | `HttpError` thrown by routes fell through to the generic handler | Every 404 / 503 / 400 became a **500**, so the UI could not distinguish "not found" from "broken" | `tests/api-e2e.test.ts` (404 on double delete, 404 on unknown company, 400 on bad params) |
| 3 | `publishVersion` always wrote `previousVersion: null` | Publishing **destroyed the rollback pointer** — the Dataset page could not offer a previous version | `tools/indexer/src/build.ts` now reads the current pointer first |
| 4 | The lead directory was trusted absolutely | A crash between the shard write and the directory write made saved leads **invisible** (users would call that data loss) | Self-healing read + `POST /api/leads/repair`; `tests/leads-recovery.test.ts`, `tests/api-e2e.test.ts` |
| 5 | A second, divergent R2 double lived in the old store test (no `arrayBuffer`) | Its passing results were meaningless — it drifted from the real binding | One shared `FakeR2Bucket` in `tests/helpers/fake-r2.ts` |

## Phase A — Real R2 data

**STATUS: BLOCKED in this environment** (no Cloudflare session, no credentials, and I will not ask
you to paste secrets into chat). No object was listed, no byte was read, no schema was reported, and
no claim of verification is made.

### Primary path — the isolated read-only probe (no credentials)

`bun run verify:r2:remote` starts `probe/` (a separate Worker, `127.0.0.1:8788`, `remote = true` on
the `COMPANY_DATA` binding, never deployed) with your existing Wrangler login, fetches one report,
stops it, and returns exit 0 (verified) / 1 (problem) / 2 (probe unavailable). It lists `raw/` under
a bound (≤ 25 objects per page, ≤ 2 pages, largest first), verifies both sources by name with real
sizes/ETags/timestamps and a **1 KB** ranged body read, samples **6 MB** per source for a schema
report (encoding, delimiter, header line, columns, fill rates, mapping suggestions with confidence
+ ambiguity, ready-to-paste `columns` override), and reports the published-dataset state.
Verification that it behaves that way, all executed here:

| Claim | Test |
| --- | --- |
| Routing, `/health`, `/verify`, `/schema`, `/report`, 404, 405 on write methods | `tests/r2-probe.test.ts` (17) |
| The probe refuses to answer when `ENVIRONMENT=production` | `tests/r2-probe.test.ts` |
| Query parameters can only ask for *less* than the config caps; a mistyped `?max=100000` clamps to 100 | `tests/r2-probe.test.ts` |
| Both sources confirmed by name/size/ETag with a bounded body read; missing object = problem | `tests/r2-probe.test.ts` |
| A 4 MB object is sampled, never downloaded (bytes read asserted < 120 KB) | `tests/r2-probe.test.ts` |
| Listing is pagination-aware, and a truncated listing is reported as a partial view, never a total | `tests/r2-probe.test.ts` |
| **Zero** `put`/`delete` calls and an unchanged bucket after every route is exercised | `tests/r2-probe.test.ts` |
| No cell value, name, email or phone appears in any response | `tests/r2-probe.test.ts`, `tests/r2-probe-schema.test.ts` |
| Encoding (BOM, UTF-16, invalid-UTF-8 → uncertain), delimiter, quoted multiline records, sample trimming at record boundaries | `tests/r2-probe-schema.test.ts` (13) |
| Mapping suggestions: confidence + evidence, ambiguity flagged, no invented fields | `tests/r2-probe-schema.test.ts` |
| The runner's exit codes 0/1/2, `--json` purity, and an unavailable probe failing with guidance | `tests/verify-r2-remote-script.test.ts` (7, over a stub probe on loopback) |
| The probe config cannot be deployed as a site (`workers_dev=false`, no `[assets]`, no routes), the production config is untouched, and no probe/shared-R2 source can write | `tests/worker-r2-binding.test.ts` |

What none of that proves: anything about your bucket. The probe has not been run against your
account — see the manual step below.

Measured, not assumed: `bun scripts/verify-raw.mjs` exits **2** here with "R2 credentials are not
set for this terminal session", i.e. `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` are not present in this workspace's process environment — so no variable
from a provider environment panel is reaching this app's server-side code, and the app itself
never reads `VITE_CONVEX_URL` / `CONVEX_DEPLOYMENT` (no Convex dependency exists). Details and
the ten answers: `docs/r2-connection.md`.

What is ready for you — two read-only scripts, neither writes to the bucket. `verify-raw.mjs` is
the connection test + inventory (access, bounded `raw/` listing, presence, exact byte size, ETag,
bounded body read, and the currently published dataset/manifest/validation state);
`profile-raw.mjs` samples the heads and prints the two schema reports.

Credentials go in **your own terminal session** (macOS shown; PowerShell equivalents and the full
rationale — including why they must not go in the provider's Frontend/Backend panel — are in
`docs/r2-connection.md`):

```bash
export R2_ACCOUNT_ID="<account id>"
export R2_ACCESS_KEY_ID="<access key id>"
export R2_SECRET_ACCESS_KEY="<secret access key>"

# 1. Connection test: access, one bounded LIST of raw/ (≤ 25 objects, largest first,
#    real names/sizes/timestamps), both sources' size + ETag + a 1 KB ranged body read,
#    and the published dataset state. --json gives one share-safe report.
bun scripts/verify-raw.mjs --json > raw-verification.json

# 2. Read the head of both files with ranged GETs (never the whole file) and
#    print two independent schema reports + a ready-to-paste sources block.
#    --json writes headers/fill-rates/mappings only — no cell values.
bun scripts/profile-raw.mjs --json > raw-schema-reports.json

# 3. Inventory only (no sampling)
bun scripts/profile-raw.mjs --list
```

What `verify-raw.mjs` guarantees, and what it refuses to do:

- **Bounded.** One `LIST` with `max-keys = 26`, at most 25 objects shown, ordered largest-first so
the source files are always inside the bound. `objectsRead` is what that one call returned — it is
never presented as a bucket total; `truncated: true` simply says more objects exist than were read.
- **Honest.** A missing object, a missing manifest, a non-passing validation record or a refused
credential is a *problem*, with exit code 1 (absent credentials exit 2). Nothing is assumed present.
- **Bounded bodies.** `HEAD` plus a 1 KB ranged `GET` per source proves readability without ever
downloading the 10 GB or 50 GB file. No `PUT`, `DELETE` or bucket-policy call exists in the script.
- **Not guessing which files are the sources.** Auto-selection takes the two largest `.csv` objects
and records `selection.mode = "two-largest-csv"`; naming them with `--keys` records `"explicit"`.
When more than two CSV objects exist, the choice is reported as a notice, not as fact.

`profile-raw.mjs` reads only the first ~6 MB of each object, trims the sample back to the last
**complete** record (a range boundary can land inside a quoted multiline row — `quoteCount` parity
decides), writes the sampled bytes to `.raw-samples/` (now gitignored, and it holds real records:
never commit or share it), prints per-file delimiter/encoding/fill-rates/sample values, the
canonical field mapping for **each** file separately, and a ready-to-paste `sources` block.

Without any S3 credentials you can still confirm presence with rclone or wrangler:

```bash
rclone lsl r2:company-intel-data/raw/
bunx wrangler r2 object list company-intel-data --prefix raw/
```

The app exposes the same bounded listing as `GET /api/dataset/sources` (≤ 25 objects, `raw/` only)
and renders it on the **Dataset Management** page — a second, independent confirmation once the
Worker is deployed and Access is configured. (The API returns the first 25 keys as R2 lists them;
the script orders by size, deliberately, so the two large sources cannot fall outside the bound.)

### Tooling verified here (script behaviour, not your bucket)

`tests/verify-raw-script.test.ts`, `tests/profile-raw-script.test.ts` and
`tests/raw-report.test.ts` run the real scripts as child processes over a stub S3 transport that
speaks ListObjectsV2 / HEAD / ranged GET and records every request. Verified for real: the
25-object bound and size ordering, 1 KB and 6 MB read budgets, `bytes=0-1023` / `bytes=0-5999999`
ranges, exactly one LIST per run, no non-GET/HEAD request ever issued, missing objects and 403s
producing the documented exit codes, `--json` being pure parseable JSON with no cell values, and no
credential value appearing in stdout or stderr. `tests/worker-r2-binding.test.ts` asserts the
Worker uses the `COMPANY_DATA` binding, declares `COMPANY_DATA: R2Bucket`, contains no `R2_*`
secret, no `cloudflarestorage.com` and no `process.env`, and that the config never publishes the
bucket. **None of this is evidence about your bucket.**

### Non-secret outputs I need from you (paste these; they contain no credentials)

1. `bun run verify:r2:remote --json > raw-verification.json` — object **keys**, **sizes**, ETags,
   timestamps, dataset state, and both schema reports (encodings, delimiters, headers, fill rates,
   mapping suggestions). One command, no credentials.
2. Alternatively (or in addition) `raw-schema-reports.json` from `bun scripts/profile-raw.mjs --json`.
3. For each file, any "unmapped columns" / "canonical fields absent" lines, so I can confirm the
   `columns` overrides.
4. Whether a 10,000-record sample run completed and its counters (`rows read`, `rejected`,
   `unique companies`, `unique contacts`, per-source breakdown).

From those I will finalise the two `columns` mappings, confirm both files contribute rows, and
fill in the real numbers in `docs/execution-plan.md` (filename, size, duration, index size).

Note on credentials: R2 API tokens are created in **Cloudflare dashboard → R2 → Manage R2 API
Tokens** (Object Read & Write is enough for indexing; Read only is enough for verification).
They are shown once. Keep them in your shell environment or a password manager — never in this
repository, and never in chat.

## Phase B — Indexing architecture validation

**STATUS: IMPLEMENTED AND TESTED** against two genuinely different source schemas, using the real
indexer and the real Worker read path (`tests/e2e-index.test.ts`, 18 tests; `tests/r2-client.test.ts`,
9 tests; `tests/api-e2e.test.ts`, 19 tests; `tests/leads-recovery.test.ts`, 7 tests).

| Requirement | Evidence |
| --- | --- |
| Streaming CSV parse, both files | `runIndex` over two fixture files; per-source counters asserted non-zero for `csv1` and `csv2` |
| Multiline quoted records | The fixture has a title spanning two lines. Asserted as **one** record with the full text (`Chief Executive Officer and Managing Director`) and the expected contact count — a split would add a malformed contact. `CsvParser` level assertion: `"line one\nline two"` preserved |
| Embedded comma / escaped quote | `Acme, Inc.` keeps its comma; `"Ravi" Kumar` keeps its quotes |
| Two different schemas | csv1 uses `Company Name/Website/Contact Name/Job Title`; csv2 uses `organization/domain/full_name/designation/work_email/linkedin_profile`. One unified index |
| Disk-backed grouping | Pass 1 spools to `workDir/spool/part-####.jsonl`; pass 2 processes one partition at a time (asserted indirectly by object counts and the checkpoint file) |
| Conservative identity resolution | Same name + different domains → two companies in results, each with only its own contacts (asserted on emails) |
| Contact deduplication | The duplicated `Kevin Scott` row appears **once**; `counters.duplicateRowsResolved > 0` |
| Cross-file association | Microsoft appears in both files; the merged record reports `multiSource: true`, `contactCount = 4`, and its contacts carry sources from **both** files |
| Exact / prefix / token / trigram indexes | Exact, fuzzy ("Microsft", "Mircosoft", "Microosoft"), prefix ("micro") queries all resolve the right company |
| Compressed, bounded shards | Every shard starts with `1f 8b`, decompresses to valid JSON, and is < 4 MB |
| No object-per-record layout | Keys are only `indexes|companies|contacts|manifests` + numeric shard names; the object count is bounded by the shard skeleton |
| Checkpoint / resume | `workDir/checkpoint.json` written with the completed stage; `runIndex` skips finished passes (`--no-resume` to start over) |
| Upload retries | `R2Client.put` retries 5xx/429 with exponential backoff (tested: 3 attempts observed), never retries other 4xx |
| Dataset checksums | `objects.jsonl` + `validation.json`; every generated object is re-hashed during validation; `validate` re-checks on disk |
| Atomic publication / rollback | A single pointer object (`manifests/active.json`); nothing is deleted, and the previous version is now recorded for one-step rollback |

Two fixture-only caveats, stated plainly: the fixture is small (7 companies), and the real 10/50
GB run has **not** happened. Sample runs (10k → 100k → 1M) are the next gate; a 1M-record run is
the point at which duration/RAM/disk/output-size estimates become trustworthy.

## Phase C — Application runtime

**PARTIALLY VERIFIED. Browser check: BLOCKED.**

Executed: **every API route the UI uses, through the real Worker fetch handler**
(`app.fetch(request, env, ctx)`) over the real generated index — `tests/api-e2e.test.ts`, 19
tests: health, dataset status, `raw/` listing, exact/fuzzy/prefix search, invalid-parameter 400,
company detail + facets, contact pagination (no overlap between pages), server-side contact
filtering, single contact, lead save/list/patch/delete + 404s + repair, saved searches + re-run,
settings, activity, CSV export (headers, row count, `no-store`, correct content type),
structured 404 for unknown routes, cross-origin 403, security headers, and **fail-closed**
behaviour when no Access identity exists.

Honest limits: this runs on Bun, not workerd. It exercises the same code path but not the
Cloudflare runtime itself (CPU accounting, subrequest limits, cold starts). No browser has
rendered the UI here.

Manual browser checklist (5 minutes, after deployment — or now against the preview):

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open `/` | Landing page renders, theme toggle works, "Open console" leads to the app |
| 2 | `/dashboard` | Summary cards; before indexing it must say **"Dataset not indexed"**, not invented numbers |
| 3 | `/companies`, search `Microsoft` then `Microsft` | Exact hit, then the same company with a "similar results" notice |
| 4 | Open a company → `/companies/:id` | Header, industry/location, coverage, facets |
| 5 | Filter contacts by department, page through | Server-side filtering, stable pagination, no duplicates across pages |
| 6 | Save a company and a contact | Toast confirms; `/leads` lists them |
| 7 | `/leads` → change status, add a note, reload | Values persist (R2-backed) |
| 8 | `/saved-searches` → save "MSFT", re-run it | Saved search appears; re-run navigates to results |
| 9 | `/exports` → export the selected contacts | Download produces a valid CSV with a header row |
| 10 | `/dataset` | Bucket reachable, version list, `raw/` objects with real sizes |
| 11 | `/settings` → clear cache, toggle theme, change page size | No errors; cache-cleared toast |
| 12 | Empty/error states | Search nonsense → clear empty state; stop the Worker → readable error, not a blank page |

## Phase D — Cloudflare Access and privacy

**Code-level: VERIFIED. Deployment-level: NOT STARTED (needs your Cloudflare account).**

Verified in code and tests:

- Every `/api/*` route passes through `verifyAccess` before any handler runs; the only bypass is
  an explicit `DEV_ALLOW_UNAUTHENTICATED=true` **and** `ENVIRONMENT !== "production"` **and** no
  team domain configured. `tests/security-access.test.ts` proves the bypass cannot engage in
  production, that a bare `Cf-Access-*` header cannot impersonate the owner, and that production
  refuses to serve when Access is unconfigured or the allowlist is empty (fail closed).
- Signature, issuer, audience and expiry are all validated against the team JWKS, with
  `alg: none`, unknown keys, tampering, expired and not-yet-valid tokens rejected.
- CORS is same-origin only (403 otherwise); security headers on every response; error payloads
  carry a code/message/request-id and never secrets or stack traces.
- No client code reads a server-side secret or non-`VITE_` env var; the API client never touches
  an Access token (`tests/frontend-secrets.test.ts`). That test also scans `dist/assets/**` for
  secret names **when a production build exists**; it currently reports that scan as skipped
  because no bundle was built here.
- Caching: dataset/contact/lead/settings responses are `no-store` or browser-only. The edge cache
  is used only for the Access JWKS and immutable hashed static assets, so a cached response can
  never bypass Access or leak private data.
- There are no preview endpoints in the Worker; the only listing is the bounded `raw/` page.

Manual Cloudflare Access configuration (do this before deploying anything private):

1. Zero Trust → **Access → Applications → Add → Self-hosted**. Name: `CompanyIntel`.
2. Add every hostname you will serve: your `*.workers.dev` hostname, any custom domain, and any
   preview alias you keep. A hostname without a policy is a bypass.
3. Policy: **Allow** where **Emails** = your address. Do **not** add a `Bypass` policy.
4. Session duration 24h (or shorter). Enable MFA on your identity provider.
5. Copy the application **AUD** tag; note your **team domain** (`<team>.cloudflareaccess.com`).
6. Set the Worker secrets (values typed into your own terminal):
   `bunx wrangler secret put CF_ACCESS_TEAM_DOMAIN`, `... CF_ACCESS_AUD`, `... ALLOWED_EMAILS`.
7. Set `workers_dev = false` in `wrangler.toml` once a custom domain works, so the alias
   hostname disappears entirely.
8. Verify from outside Access: `curl.exe -i https://<host>/api/health` → **401/403, never 200**.
9. Optional hardening: a WAF rate-limiting rule on `/api/*` (the in-isolate limiter is
   best-effort).
10. Keep the R2 bucket private: no public bucket access, no `r2.dev` URL.

## Phase E — Performance and cost verification

Measured here (`bun scripts/benchmark-r2-path.mjs`, built-in two-schema fixture, R2-backed read
path — gzipped objects loaded exactly as the bucket stores them). Figures are from one run; the
sandbox varies by roughly 2× between runs, so treat them as an order of magnitude:

Index built for the run: 41 objects (36 index objects), 9.2 KB total, 7 companies, 13 contacts.

| Query class | median | p95 | R2 GETs | bytes read | candidates scored |
| --- | --- | --- | --- | --- | --- |
| exact "Microsoft Corporation" | 0.33 ms | 0.86 ms | 12 | 2.6 KB | 1 |
| alias/legal suffix "Infosys Ltd" | 0.40 ms | 0.87 ms | 14 | 2.9 KB | 2 |
| short prefix "micro" | 0.23 ms | 0.67 ms | 7 | 1.9 KB | 1 |
| typo "Microsft" | 0.29 ms | 0.74 ms | 8 | 2.1 KB | 1 |
| transposition "Mircosoft" | 0.28 ms | 10.6 ms | 9 | 2.1 KB | 1 |
| multi-token "international business machines" | 0.41 ms | 1.74 ms | 11 | 2.5 KB | 6 |
| no result "zzzzzzqqqqq" | 0.16 ms | 0.50 ms | 7 | 0.9 KB | 0 |

`R2 GETs` is the cold-start count per query class (repeats inside one isolate are absorbed by the
directory cache), and the byte column is the largest read volume observed. Browser cache hit rates
are visible in Settings, not measurable from here.

Engine-level benchmark at 50,000 companies, excluding R2 (`bun scripts/benchmark-search.mjs
--companies 50000 --repeat 5`, this run; index build 1261 ms, heap 94.7 MB): exact 3.83 ms /
5.15 ms p95, legal-suffix variant 9.90 ms / 12.64 ms, single typo 0.03 ms, transposition 2.41 ms /
10.40 ms p95, word split 10.06 ms / 16.71 ms p95; labelled relevance recall@1 0.939, recall@5
0.97, 0 false positives on the "no match" queries. `docs/cost.md` records an earlier run of the
same benchmark (exact 2.8/3.3 ms, word split 5.9/10.1 ms) — repeat runs on this shared sandbox vary
by about 2×, which is exactly why the figures must be re-measured on your machine. Object counts
per search are bounded by design
(≤ ~30 shard objects worst case, ≤ 24 hydration partitions), independent of corpus size — which is
why R2 operations stay inside the 10M/month free allowance even at 1,000 searches/day
(see `docs/cost.md`).

**Workers Free verdict: plausible, not yet confirmed.** Median queries are far inside the 10 ms
CPU budget, but the worst observed case here is a **10.6 ms p95** for a transposed misspelling —
right at the Free plan's ceiling — and the engine-level benchmark puts heavy word-split queries at
~10 ms p95 too. Assume the heaviest fuzzy queries can trip `1102 Worker exceeded CPU time` on the
Free plan until production measurement says otherwise. Still needs real Cloudflare measurement:

- CPU time per request — `bunx wrangler tail` (or Workers analytics) under real traffic.
- Real index object sizes (they grow with corpus, so bytes/read grows even though the object
  count does not).
- Cold-start latency and subrequest behaviour.
- Browser cache hit rates (TanStack + IndexedDB) — visible in the app's Settings screen.

No paid plan has been activated, and none is needed to finish development.

## Phase F — Saved-lead consistency

**IMPLEMENTED AND TESTED.** Failure scenarios and what now happens:

| Scenario | Before | Now |
| --- | --- | --- |
| Crash between shard write and directory write | Leads present in the shard, **invisible** to the app | The read detects a missing/empty directory and rebuilds it from the shards; `tests/leads-recovery.test.ts` |
| Directory references a shard that no longer exists | Entry kept, silently contributing nothing | Missing entries are dropped, surviving leads are still returned, directory rewritten |
| Directory corrupted (invalid JSON) | Threw/null depending on path | Treated as missing → rebuilt |
| Concurrent tabs on the same partition | Compare-and-set already prevented a lost update; the losing write retried | Unchanged, and now covered by two tests (store-level + recovery-level) |
| Interrupted delete (shard updated, count stale) | Stale `total` | Directory total recomputed on repair; leads authoritative |
| Operator suspicion | No remedy short of manual R2 edits | `POST /api/leads/repair` (or Dataset/Leads page action) rebuilds from the authoritative shards; one bounded LIST of ≤ 500 objects |

Recovery snapshots (`backups/app-data/<date>/…`) preserve the pre-mutation state, and restoring a
shard is documented in `docs/recovery.md`. No second database was introduced: lead shards remain
authoritative objects in R2, and the directory is explicitly derived data.

## Final delivery matrix

| Requirement | Implemented | Test evidence | Remaining risk | Manual action required |
| --- | --- | --- | --- | --- |
| A. List real `raw/` objects, verify sizes/readability, sample + report both schemas, map to canonical model | Tooling implemented and tested over a stub transport; real run not executed (no R2 creds reach this environment) | `tests/verify-raw-script.test.ts` (7), `tests/profile-raw-script.test.ts` (3), `tests/raw-report.test.ts` (9); `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs` | Real headers may differ from the fixture | Run both scripts locally, send both `--json` reports |
| Production Worker reaches R2 only through the `COMPANY_DATA` binding | Yes | `tests/worker-r2-binding.test.ts` (11): binding + bucket name, no published bucket, no `R2_*`/`cloudflarestorage.com`/`process.env` in `worker/**`, S3 client confined to `tools/` + `scripts/`, plus the probe guards (remote binding, `workers_dev=false`, no write call in `probe/**` or `src/shared/r2/**`, no env/secret access) | Custom domain/`workers.dev` routing is account config | Create the Access app (Phase D) |
| Read-only probe: no-credential connection test, bounded reads, schema report, no writes | Yes (locally, against an in-memory bucket and a stub probe) | `tests/r2-probe.test.ts` (17), `tests/r2-probe-schema.test.ts` (13), `tests/verify-r2-remote-script.test.ts` (7) | Not run against the real account | `bun run verify:r2:remote --json` on your Mac |
| Indexer Mode B: read the source objects straight from R2 | Yes (over a stubbed S3 transport) | `tests/indexer-r2-source.test.ts` (13): bounded 8 MiB ranged reads, chunk-boundary parsing, Mode A/Mode B parity, cache/resume, 404/403/credential errors | The real 60 GB stream needs your credentials | Set the `R2_*` variables in one shell when you start Mode B |
| A. Mapping corrections identified | Mechanism tested, real overrides pending | `tests/e2e-index.test.ts` (two schemas → one model) | A column may need a `columns` override | Approve the `columns` blocks I return |
| B. Streaming, multiline, dual-schema parsing | Yes | `tests/e2e-index.test.ts`, `tests/csv.test.ts` | None known | — |
| B. Disk-backed grouping, identity resolution, dedupe, cross-file association | Yes | `tests/e2e-index.test.ts` (multiline record = 1, dup contact once, Microsoft merged from both files, same-name/different-domain kept apart) | Real data may expose new ambiguity | Review ambiguous-count in the manifest after the sample runs |
| B. Exact/prefix/token/trigram indexes, bounded gzip shards | Yes | `tests/e2e-index.test.ts` (magic bytes, size bound, object count), `tests/r2-client.test.ts` (gzip metadata) | Object sizes grow with corpus | Confirm bytes/company from the 1 M sample |
| B. Checkpoint/resume, upload retries, checksums, atomic publish + rollback | Yes | `tests/e2e-index.test.ts`, `tests/r2-client.test.ts` (retry counts), `tests/indexer.test.ts` | Very long runs still need a real interruption drill | Optionally kill and resume one sample run to see it work |
| C. Worker API routes on a real handler | Yes (Bun runtime) | `tests/api-e2e.test.ts` (19) | Not workerd; no browser | Run the 12-step browser checklist after deployment |
| C. Browser rendering, all screens, loading/empty/error states | **BLOCKED here** | — | Real rendering unverified | Follow the Phase C checklist in this document |
| D. Access protection of frontend + API | Yes | `tests/security-access.test.ts` (20) incl. fail-closed in production and no `Cf-Access-*` header spoofing | Exact production config unverified | Create the Access app, set the 3 secrets, confirm `curl` → 401 |
| D. JWT signature/iss/aud/exp validation | Yes | `tests/security-access.test.ts` (real RS256 keys, tampered/expired/nbf/alg-none rejected) | JWKS rotation handled by cache TTL | — |
| D. No workers.dev bypass, no preview exposure, private bucket, no cached private data | Yes in code/config | `tests/api-e2e.test.ts` (CORS 403, `no-store` on private responses, security headers), `tests/frontend-secrets.test.ts` | `workers_dev` must be turned off in your account | Steps 1–10 of the Phase D Access list |
| D. No credentials in the frontend bundle | Source-level yes; bundle scan skipped (no `dist` built here) | `tests/frontend-secrets.test.ts` (4 of 5 assertions real; bundle scan reports skipped) | Bundle scan runs only after a build | Build once locally and re-run that test file |
| E. Median/p95 latency, R2 requests, bytes | Yes | `scripts/benchmark-r2-path.mjs`, `scripts/benchmark-search.mjs` (both re-run for this report) | Sandbox variance ~2× | Re-run both on your machine, optionally `--companies 200000` |
| E. CPU time, memory, cache hit rates, real index size | **Not measurable here** | — | Free-plan 10 ms ceiling may be hit on heavy fuzzy queries (worst p95 seen: 10.6 ms) | `wrangler tail` after deployment; decide Free vs Paid yourself |
| F. Lead-loss scenarios identified and recovered | Yes | `tests/leads-recovery.test.ts` (7), `tests/worker-store.test.ts` (6), `tests/api-e2e.test.ts` (repair route) | R2 has no cross-object transaction | Use `POST /api/leads/repair` if the app ever reports a mismatch |
| F. No new database introduced | Yes — R2 objects only, directory is derived data | `tests/leads-recovery.test.ts` | — | — |
| G. Full execution plan with sources, mappings, resources, costs, validation | Drafted with explicit placeholders | `docs/execution-plan.md` | Real numbers unknown until sample runs | Approve after sending the Phase A outputs + sample timings |

## Remaining risk (unchanged by this phase)

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| Real CSV schemas differ from the fixture | Their headers are unknown until Phase A runs | `profile-raw.mjs` + per-source `columns` overrides; the fixture proves the mechanism, not their data |
| Two files may not share a strong identifier | Cross-file merge then relies on domain/LinkedIn | Same-name-different-domain stays separate by design; per-source contribution is reported in the manifest |
| Full-run resource exhaustion | Only a real sample run can measure it | Preflight refuses to start on insufficient temporary space; checkpoint/resume |
| Workers Free CPU ceiling | Needs production measurement | Documented; decision deferred to you |
| R2 eventually consistent writes | Two tabs, different objects | ETag preconditions + repair path |
