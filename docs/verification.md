# Verification report (phases A–F)

What was **executed** in this environment, what it proved, what is **BLOCKED**, and what you
must run on your own machine. Nothing here is inferred from type-checking alone: every claim
names the command or test that produced it.

Run everything below yourself with (all commands are read-only unless marked otherwise):

```bash
bun run check                          # 4 typechecks + the suite (299 tests, 1,271 assertions)
bun run r2:doctor                      # credentials file, endpoint, one signed LIST of raw/
bun run r2:schema                      # both REAL files: encoding, delimiter, columns, mapping
bun run verify:r2                      # inventory, sizes, ETags, bounded body read, dataset state
bun run verify:r2:remote               # same ground truth through the Worker binding (no keys)
bun run index:profile                  # preflight over the real objects + per-file mapping
bun scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-dry5-250
bun scripts/benchmark-search.mjs       # engine + labelled relevance
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

**STATUS: VERIFIED against the real bucket on 2026-10-16** with the fixed server-side credentials in
the private, git-ignored `.r2-credentials.json` (`tools/indexer/src/credentials.ts`). Every number
below came out of a live signed request; the commands that produced them are listed at the top of
this document and each one is read-only (LIST / HEAD / ranged GET only — no PUT, no DELETE, no
manifest, no publish). Credential values are never printed by any of these tools; the doctor refuses
to print a report in which a credential survived redaction.

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

What none of that proves: anything about your bucket. The probe itself has **not** been run against
your account (it needs your Wrangler login, which exists only on your machine) — but the S3-key path
has, and its live results are in "Phase A results" below. The two paths read the same bucket.

Measured, not assumed — the connection test, verbatim (values redacted here, not in the tool):

```
Credentials
  source            private local file
  file              <repo>/.r2-credentials.json (mode 0600)
  endpoint          <account-id>.r2.cloudflarestorage.com
  bucket            company-intel-data
  access key id     present (value never printed)
  secret access key present (value never printed)

Probe (read-only ListObjectsV2 on the raw prefix)
  ok    HTTP 200 in 308 ms — access key id + secret access key are a matching pair
  objects under raw/: 3 returned
           0 B  raw/                2026-10-15T09:58:52.938Z
       9.52 GiB  raw/file1.csv       2026-10-15T12:13:37.665Z
      50.33 GiB  raw/file2.csv       2026-10-15T13:22:30.524Z
```

The account id in the endpoint and the configured `accountId` agree, the bucket name is valid for
R2, and the endpoint/account mismatch check did not fire — i.e. the endpoint, the bucket and the
credential pair all belong together. The app itself still never reads a `VITE_*` or provider-panel
variable and has no Convex dependency. Details: `docs/r2-connection.md`.

What was run here — four read-only tools, none of which can write to the bucket (the S3 verbs used
are `ListObjectsV2`, `HeadObject` and ranged `GetObject` only):

| Command | What it proves |
| --- | --- |
| `bun run r2:doctor` | the private credentials file is found, the endpoint and bucket are valid, and one signed `ListObjectsV2` is accepted (exit 0) — no credential value is ever printed |
| `bun run r2:schema` | 6 MB per file sampled with bounded ranged GETs: encoding, delimiter, header line, fill rates, per-file mapping with confidence, a ready-to-paste `columns` block — no cell values |
| `bun run verify:r2` | inventory (one bounded `raw/` listing), exact sizes, ETags, a 1 KB body read per source, and the published-dataset state |
| `bun run index:profile` | preflight over the real objects (sizes, free disk/memory/CPU, estimated output and spool space) plus the per-file canonical mapping |

Credentials live in ONE private file that every server-side tool reads automatically, so no exports
are needed for any of them:

```bash
chmod 600 .r2-credentials.json   # repository root; listed in .gitignore, never committed
bun run r2:doctor                # proves the file, the endpoint and the key pair
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

### Phase A results — the real bucket, read-only

**Objects.** One bounded LIST returned three objects under `raw/`; the two source files are present,
readable, and byte-size verified by HEAD, with a 1 KB ranged body read proving content (not just
metadata):

| Key | Bytes | ETag | Last modified | Body read |
| --- | --- | --- | --- | --- |
| `raw/file1.csv` | 10,223,471,749 (10.22 GB) | `9802eccace4215e92763b71e51248c8c-98` | 2026-10-15T12:13:37.665Z | 1.02 KB |
| `raw/file2.csv` | 54,038,527,871 (54.04 GB) | `050a094261a96474e83e87baa55c39fd-516` | 2026-10-15T13:22:30.524Z | 1.02 KB |
| `raw/` | 0 | — | 2026-10-15T09:58:52.938Z | — |

64.26 GB total, matching the expected ~10 GB + ~50 GB. **Published dataset: none** —
`manifests/` holds no active pointer, so the app correctly reports "Dataset not indexed" until a
version is published. Nothing was written, moved or deleted.

**Schemas (6 MB sampled per file, trimmed to a complete record, zero cell values in the report).**
The two files are **not** the same shape, and they are not even comma separated:

| | `raw/file1.csv` | `raw/file2.csv` |
| --- | --- | --- |
| Content | **organizations** | **people** |
| Encoding / delimiter | UTF-8, no BOM / **TAB** | UTF-8, no BOM / **TAB** |
| Columns | 51 | 39 |
| Identity | `organization_id` (high confidence) | none of its own; `current_organization_ids` |
| Company name | `organization_name` | `sanitized_organization_name_unanalyzed` |
| Company web | `organization_website_url` **and** `organization_domain` (both URL-shaped → ambiguous) | none |
| People | none | `person_name`, `person_title`, `person_email`, `person_linkedin_url`, `person_seniority`, `person_functions` |
| Company link | — | sanitized company **name** only |

The full per-file column→canonical mapping, with confidence and the ambiguous columns flagged, is
produced by `bun run r2:schema` and the resolved decisions live in `tools/indexer/indexer.config.json`
(`columns` overrides). Two deliberate calls: `companywebsite` ← `organization_website_url` (a website
and a domain are different fields; the domain goes to `companydomain`), and the organization's
switchboard `organization_phone` is **not** mapped onto a contact `phone` — attaching a company
number to a person would invent contact data. The people file's own `person_email_analyzed`
duplicate is not used either: `person_email` is the field.

**Is an id join possible between the two files?** Measured: no. An 8 MB sample of each file gave
3,675 organization rows / 3,526 ids and 14,348 person rows; 4,616 person rows (32.2%) matched an
organization by normalized name, but **0 of them** had that organization's `organization_id` inside
their `current_organization_ids` list (which is a JSON-style array on 98.5% of rows). The two
exports use different id namespaces, so the normalized company name is the only usable cross-file
link — which is exactly how the indexer joins them.

**Association quality on real data** (measured on the generated sample index, counts only):

| Metric | Value |
| --- | --- |
| companies / contacts | 20,265 / 19,414 |
| companies with a domain | 14,937 (73.7%) |
| companies contributed by **both** files (cross-file association) | 13,761 (67.9%) |
| contacts with a LinkedIn URL (`person_linkedin_url`, fill rate 500/500 in the profiler sample) | 19,414 (100%) |
| contacts with an email (`person_email`, profiler fill rate 276/500) | 12,012 (61.9%) |
| contacts with a phone (`person_phone`) | 3 — the source column is **empty** (profiler fill rate 0/500, and `person_sanitized_phone` is empty too), so this is source data, not a mapping defect |
| contacts on an identified company (the company has a domain) | 14,515 (74.8%) |
| contacts on a name-only company (kept separate, never merged on a name match alone) | 4,899 |
| contacts whose `companyId` points at a company that does not exist in the sample | **0** |
| ambiguous companies (same name, contradictory identity — kept apart) | 220 |
| contacts sitting on a company whose name is shared by >1 record | 227 (1.17%) |
| …of those, disambiguable by country evidence | 50 |

So the name-only cross-file join is wrong-or-uncertain for about **1.2%** of contacts in the sample,
and every one of the colliding records is flagged `ambiguous` in the index rather than silently
merged. The remaining ~25% of contacts sit on name-only companies (the people file names a company
the organizations file does not contain); they are labelled name-only in the UI instead of being
given invented domains.

**Real-data sample index run (dry run, not published, not uploaded).**

```
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json \
    --sample 20000 --version v1-dry5-250
```

| Counter | Value |
| --- | --- |
| rows read | 39,505 (csv1 19,505 · csv2 20,000) |
| rows rejected | 1,376 (csv1 900 · csv2 476), each with a reason in `workDir/rejected.jsonl` |
| unique companies / contacts | 20,265 / 19,414 |
| contacts contributed per file | csv1 0 (organizations carry no people) · csv2 19,414 |
| duplicate rows resolved | 2 |
| validation | passed (`validation.json`, `state: validated`) |
| wall clock | 102 s for 1,899 gzipped objects |
| published / uploaded | **no** — local `.indexer-output` only |

The last run above was also a **resume** (pass 1 skipped from `workDir/checkpoint.json`), which is
what verified the counter-restore fix described below.

The run also proved two crash-level defects that only appear on real data — both fixed and covered
by `tests/prototype-safety.test.ts`: a company whose name contains the token `constructor` made the
normalizer call `Object.prototype.constructor` (a function) and killed the run, and the same
prototype-chain lookup broke shard postings. Every dynamic-key lookup in the pipeline is now an
own-property lookup.

Note on credentials: the R2 API token was created in **Cloudflare dashboard → R2 → Manage R2 API
Tokens** (Object Read for indexing/verification; Object Read & Write only for the upload step). Put
the pair in the private, git-ignored `.r2-credentials.json` (`chmod 600`) and run `bun run r2:doctor`
to prove it works. Never commit it and never paste it in chat.

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

Two caveats, stated plainly: the fixture is small (7 companies) and the real **full** run has not
happened. What has happened against real data is the bounded dry run in Phase A (20,000 records per
source, 39,505 rows, 1,826 objects, validation passed, nothing uploaded) — it exercises the same
pipeline end to end on real rows and is where two real-data crashes were found and fixed. The
1,000,000-record sample is still the gate at which duration/RAM/disk/output-size estimates become
trustworthy, and it is yours to approve.

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

Measured here through the real Worker read path (`R2Store` + `R2CandidateSource` + the shared
engine, gzipped objects loaded exactly as the bucket stores them). Figures are from one run on a
1-vCPU sandbox and vary by roughly 2× between runs; treat them as an order of magnitude.

**Pre-optimization baseline against the real-data sample index** (`.indexer-output`,
`v1-dry4-20k`: 1,828 objects, 10.0 MB, 20,265 companies, 19,414 contacts):

```bash
# this version predates INDEX_FORMAT_VERSION 2 and is no longer readable by the current reader
bun scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-dry4-20k
```

| Query | median | p95 | R2 GETs | bytes read | candidates scored |
| --- | --- | --- | --- | --- | --- |
| exact "Microsoft Corporation" | 157.2 ms | 238.6 ms | 27 | 2.04 MB | 400 |
| alias/legal suffix "Infosys Ltd" | 109.4 ms | 124.7 ms | 27 | 2.04 MB | 400 |
| short prefix "micro" | 124.6 ms | 134.9 ms | 19 | 1.99 MB | 400 |
| typo "Microsft" | 112.0 ms | 114.7 ms | 22 | 2.01 MB | 400 |
| transposition "Mircosoft" | 108.0 ms | 115.5 ms | 23 | 2.02 MB | 400 |
| multi-token "international business machines" | 121.7 ms | 182.2 ms | 30 | 2.07 MB | 400 |
| no result "zzzzzzqqqqq" | 19.6 ms | 26.3 ms | 11 | 0.41 MB | 2 |

That table is the **pre-optimization baseline** (indices with 2,000 companies per object and
unbounded hydration of up to 400 candidates) and it is kept here on purpose: it is what justified
the change. It reads honestly: the object count per query stayed bounded (11–30), but each query
pulled ~1–2 MB and spent ~0.1–0.24 s of Bun CPU, which is outside any 10 ms budget.

**After the hydration bound** (250 companies per object, a 16-partition per-search ceiling and the
confident-page early stop — see `docs/architecture.md`), same machine, same 20 K sample, one fresh
source per query:

| Query | median | p95 | R2 GETs | bytes read | candidates scored |
| --- | --- | --- | --- | --- | --- |
| exact "Microsoft Corporation" | 25.3 ms | 28.3 ms | 32 | 478 KB | 23 |
| alias/legal suffix "Infosys Ltd" | 23.2 ms | 25.5 ms | 32 | 478 KB | 24 |
| short prefix "micro" | 16.1 ms | 16.7 ms | 24 | 431 KB | 20 |
| typo "Microsft" | 23.5 ms | 24.4 ms | 27 | 442 KB | 24 |
| transposition "Mircosoft" | 18.8 ms | 19.0 ms | 28 | 457 KB | 20 |
| multi-token "international business machines" | 21.4 ms | 22.1 ms | 35 | 512 KB | 21 |
| no result "zzzzzzqqqqq" | 2.9 ms | 3.6 ms | 11 | 77 KB | 2 |

Bytes per query dropped ~4.5×, scored candidates ~400 → ~20, and worst-case latency ~6×, with the
read count rising slightly (smaller objects are what buy the byte reduction; Class B reads are the
cheap side of that trade at $0.36/million). The byte cost is now bounded by constants —
`SEARCH_MAX_HYDRATE × partition size` ≈ 400 KB — instead of growing with the collection, because
the partition size is fixed while the number of partitions is not.

What is still **not** proven: workerd CPU. ~20 ms here is Bun on one sandbox vCPU including
decompression and scoring; V8 on Cloudflare with a warm isolate can be several times faster, but a
Free-plan 10 ms budget cannot be claimed either way without measuring on a deployment. The recall
trade-off of the ceiling is documented with numbers in `docs/architecture.md`; `SEARCH_MAX_HYDRATE`
and the browser-side IndexedDB cache are the dials if a deployment measures too high — and both
are configuration-level changes that need your decision, not a silent tweak.

> **Index format note.** The partition-size change is a format change (`INDEX_FORMAT_VERSION 2`).
> Any index built before it (including the earlier `v1-dry4-20k` sample) cannot be read by the
> current Worker path and must be rebuilt before it is uploaded or published; the old objects can
> stay in the bucket until the new version is validated.

The smaller fixture run (41 objects, 7 companies) is kept for comparison; it is unrepresentative of
real object sizes and shows sub-millisecond timings.

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

**Workers Free verdict: not viable at real object sizes.** The fixture numbers (below) looked
comfortable only because those objects are tiny. Against the real-data index every query class costs
**0.1–0.24 s of CPU and ~2 MB of decompressed index here**, which is one to two orders of magnitude
over a Free-plan 10 ms CPU budget; a Paid plan, a smaller candidate/hydration budget, or leaning on
the browser-side cache is the realistic answer. This is a decision to make before deploying, and it
is not something I will change silently. Still needs real Cloudflare measurement:

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
| A. List real `raw/` objects, verify sizes/readability, sample + report both schemas, map to canonical model | **Yes — executed against the real bucket** (`bun run r2:doctor`, `r2:schema`, `verify:r2`, `index:profile`) | `tests/verify-raw-script.test.ts` (7), `tests/profile-raw-script.test.ts` (3), `tests/raw-report.test.ts` (9), `tests/r2-client.test.ts` (13); results in the Phase A section | Two files use **different id namespaces**, so the cross-file link is the company name (measured: id join impossible) | Approve the `columns` mapping in `indexer.config.json` |
| Production Worker reaches R2 only through the `COMPANY_DATA` binding | Yes | `tests/worker-r2-binding.test.ts` (11): binding + bucket name, no published bucket, no `R2_*`/`cloudflarestorage.com`/`process.env` in `worker/**`, S3 client confined to `tools/` + `scripts/`, plus the probe guards (remote binding, `workers_dev=false`, no write call in `probe/**` or `src/shared/r2/**`, no env/secret access) | Custom domain/`workers.dev` routing is account config | Create the Access app (Phase D) |
| Read-only probe: no-credential connection test, bounded reads, schema report, no writes | Yes (locally, against an in-memory bucket and a stub probe) | `tests/r2-probe.test.ts` (17), `tests/r2-probe-schema.test.ts` (13), `tests/verify-r2-remote-script.test.ts` (7) | Not run against the real account | `bun run verify:r2:remote --json` on your Mac |
| Indexer Mode B: read the source objects straight from R2 | **Yes — executed against the real objects** (20,000 records per source, 39,505 rows) | `tests/indexer-r2-source.test.ts` (13): bounded 8 MiB ranged reads, chunk-boundary parsing, Mode A/Mode B parity, cache/resume, 404/403/credential errors; counters in the Phase A section | The full 64.26 GB stream has not been run (needs your approval) | Approve the 1 M sample, then the full run |
| A. Mapping corrections identified and applied | **Yes** — both files are TSV with different, non-obvious schemas; the overrides are committed in `tools/indexer/indexer.config.json` | `tests/indexer.test.ts`, `tests/e2e-index.test.ts` (two schemas → one model) | Ambiguous columns (`organization_website_url` vs `organization_domain`) are resolved by hand, not by the profiler | Confirm the two decisions at the top of the config's `$comment` |
| B. Streaming, multiline, dual-schema parsing | Yes | `tests/e2e-index.test.ts`, `tests/csv.test.ts` | None known | — |
| B. Disk-backed grouping, identity resolution, dedupe, cross-file association | Yes | `tests/e2e-index.test.ts` (multiline record = 1, dup contact once, Microsoft merged from both files, same-name/different-domain kept apart) | Real data may expose new ambiguity | Review ambiguous-count in the manifest after the sample runs |
| B. Exact/prefix/token/trigram indexes, bounded gzip shards | Yes | `tests/e2e-index.test.ts` (magic bytes, size bound, object count), `tests/r2-client.test.ts` (gzip metadata) | Object sizes grow with corpus | Confirm bytes/company from the 1 M sample |
| B. Checkpoint/resume, upload retries, checksums, atomic publish + rollback | Yes — the checkpoint now records the **run identity** (version, sample limit, partitions, source paths/delimiters/overrides) and refuses to resume a spool from a different run; `--no-resume` clears the stale spool and rebuilds | `tests/indexer.test.ts` (different-run refusal, stale-spool clearing, counters restored on resume), `tests/r2-client.test.ts` (retry counts), `tests/e2e-index.test.ts` | Very long runs still need a real interruption drill | Optionally kill and resume one sample run to see it work |
| Quality gates (typecheck ×4, tests, lint, build, both bundles, indexer CLI) | **Yes — executed with exit codes recorded**: `bun run check` 0 (5/5 PASS), `bun run lint` 0 (0 problems), `bun run build` 0, `wrangler deploy --dry-run` 0 for the Worker (737 KiB) and the probe (39 KiB), indexer `--help`/`--preflight-only` as documented | `bun run check` (304 tests, 1296 assertions), `tests/search-funnel.test.ts`, `tests/frontend-secrets.test.ts` | Bundle validation is `--dry-run` only; nothing was deployed | Deploy to the preview environment after the Access app exists |
| C. Worker API routes on a real handler | Yes (Bun runtime) | `tests/api-e2e.test.ts` (19) | Not workerd; no browser | Run the 12-step browser checklist after deployment |
| C. Browser rendering, all screens, loading/empty/error states | **BLOCKED here** | — | Real rendering unverified | Follow the Phase C checklist in this document |
| D. Access protection of frontend + API | Yes | `tests/security-access.test.ts` (20) incl. fail-closed in production and no `Cf-Access-*` header spoofing | Exact production config unverified | Create the Access app, set the 3 secrets, confirm `curl` → 401 |
| D. JWT signature/iss/aud/exp validation | Yes | `tests/security-access.test.ts` (real RS256 keys, tampered/expired/nbf/alg-none rejected) | JWKS rotation handled by cache TTL | — |
| D. No workers.dev bypass, no preview exposure, private bucket, no cached private data | Yes — `workers_dev = false` is now set in `wrangler.toml` (only `env.development` keeps it true), and the Worker fails closed on any hostname because it verifies the Access JWT itself | `tests/api-e2e.test.ts` (CORS 403, `no-store` on private responses, security headers), `tests/security-access.test.ts` (20), `tests/frontend-secrets.test.ts` | Removing the alias hostname means the Worker needs your custom-domain `[routes]` entry to be reachable | Add the route, confirm Access covers it, then deploy (steps 1–10 of the Phase D list) |
| D. No credentials in the frontend bundle | **Yes, now including the built bundle.** `bun run build` exits 0, and the `dist/` scan finds no server-only identifier (`R2_*`, `CF_ACCESS_*`, `ALLOWED_EMAILS`, the R2 binding name) and no Access team domain. The scan caught one real leak while being enabled: the preview-mode error string named the Worker's R2 binding, so it was reworded — a user-facing sentence is not an excuse to ship a server identifier | `tests/frontend-secrets.test.ts` (all 5 assertions real) | — | Re-run the scan after any bundle-affecting change |
| E. Median/p95 latency, R2 requests, bytes | Yes — re-measured against the **real-data** sample index after the hydration bound: 16–25 ms, 24–35 GETs, 0.43–0.51 MB per cold query (was 0.10–0.24 s, 19–30 GETs, ≤ 2.07 MB) | `scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-dry5-250`, `scripts/benchmark-search.mjs` | Sandbox variance ~2×; corpus is a 20 K sample; reads are local, not networked | Re-run both on your machine, then re-measure with the 1 M sample |
| E. Search completeness under the hydration cap | Yes — `bun run bench:hydration` measures five hydration strategies against the real-data sample and the complete answer: the old fixed-16 default lost 20 of 90 rows on broad queries, the adaptive 16→32 pass loses 0 at the same byte cost as a fixed 32 | `scripts/benchmark-hydration.mjs` | Retrieval quality is measured against a reference run limited only by the 20 K sample and its 25-row page size | Re-run after the 1 M sample exists; a v3 layout is only worth it if the benchmark shows the same losses at 20× the partitions |
| Bundle validation (Worker + probe) | Yes — `wrangler deploy --dry-run` builds both bundles: Worker 737 KiB (126 KiB gzip) with the R2 + assets bindings, probe 39 KiB, `workers_dev = false`, `ENVIRONMENT` correct in each. The first run exposed a **deployment blocker**: a duplicated `SEARCH_MAX_HYDRATE` key made `wrangler.toml` invalid TOML | `bunx wrangler deploy --dry-run`, `bunx wrangler deploy --dry-run -c probe/wrangler.toml` | `--dry-run` validates config + bundling only; it does not contact Cloudflare or prove a deploy succeeds | Deploy to the preview environment once the Access application exists |
| E. CPU time, memory, cache hit rates, real index size | **Partly** — local CPU/bytes measured; workerd CPU and browser cache hits are not measurable without a deployment | Phase E tables | After the hydration bound a cold query reads ~0.45 MB and scores ~20 docs (was ~2 MB and 400), but the local figure is still ~20 ms on one sandbox vCPU — a Free-plan 10 ms CPU budget is **not proven** either way without workerd measurement | Decide Free vs Paid from `wrangler tail` CPU on a real deployment; `SEARCH_MAX_HYDRATE` tunes the trade-off |
| F. Lead-loss scenarios identified and recovered | Yes | `tests/leads-recovery.test.ts` (7), `tests/worker-store.test.ts` (6), `tests/api-e2e.test.ts` (repair route) | R2 has no cross-object transaction | Use `POST /api/leads/repair` if the app ever reports a mismatch |
| F. No new database introduced | Yes — R2 objects only, directory is derived data | `tests/leads-recovery.test.ts` | — | — |
| G. Full execution plan with sources, mappings, resources, costs, validation | Drafted with explicit placeholders | `docs/execution-plan.md` | Real numbers unknown until sample runs | Approve after sending the Phase A outputs + sample timings |

## Remaining risk (unchanged by this phase)

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| Real CSV schemas differ from the fixture | Resolved: both real files are TAB-separated, and their headers/columns are now measured and mapped | `bun run r2:schema` + per-source `columns` overrides; the mapping is committed in `indexer.config.json` |
| Two files do not share a strong identifier | Confirmed by measurement: the id namespaces differ, so the cross-file link is the normalized company name | Name-only rows merge only with name-only records; a strong-identity conflict keeps records apart **and** flags them; on the sample this affected 1.17% of contacts, all flagged |
| Full-run resource exhaustion | Only a real sample run can measure it | Preflight refuses to start on insufficient temporary space; checkpoint/resume |
| Workers Free CPU ceiling | Needs production measurement | Documented; decision deferred to you |
| R2 eventually consistent writes | Two tabs, different objects | ETag preconditions + repair path |
