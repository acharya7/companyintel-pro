# Verification report (phases A–F)

What was **executed** in this environment, what it proved, what is **BLOCKED**, and what you
must run on your own machine. Nothing here is inferred from type-checking alone: every claim
names the command or test that produced it.

Run everything below yourself with (all commands are read-only unless marked otherwise):

```bash
bun run check                          # 4 typechecks + the suite (354 tests, 0 fail)
bun run r2:doctor                      # credentials file, endpoint, one signed LIST of raw/
bun run r2:schema                      # both REAL files: encoding, delimiter, columns, mapping
bun run verify:r2                      # inventory, sizes, ETags, bounded body read, dataset state
bun run verify:r2:remote               # same ground truth through the Worker binding (no keys)
bun run index:profile                  # preflight over the real objects + per-file mapping
bun scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-dry5-250
bun scripts/benchmark-search.mjs       # engine + labelled relevance
bun run index:bench-pass2 --fs-count   # pass-2 merge: seconds + every file open counted
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

## Real-data benchmark failure and fix (executed)

This is the first defect in this project that was found by **running against the real corpus**
rather than by executing a test, and it is recorded here in full because a typecheck could never
have found it.

### What was executed

```
bun run index:benchmark-1m        # --sample 1000000 --version v1-bench-1m, real R2 objects
  preflight        PASSED
  pass 1           1,986,239 records (csv1 986,239 + csv2 1,000,000), ~5,015 rows/s,
                   checkpoint written (stage=pass2-merge)
  peak temp disk   2.49 GB (measured before the failure)
  pass 2           FAILED after 3,869 companies from 1/256 partitions:
                   JSON Parse error: Unterminated string      (exit 1)
```

### Root cause (reproduced, not inferred)

A spool row whose value contains **U+2028 (LINE SEPARATOR)** or **U+2029 (PARAGRAPH SEPARATOR)** was
written by `JSON.stringify`, which leaves both characters literal, and read back by
`node:readline`, which treats both as line terminators. One record became two "lines" and
`JSON.parse` threw `Unterminated string`. Both characters are common in scraped company exports
(they are the in-cell line break) and neither had ever appeared in a fixture.

Reproduced end to end with the real indexer on a two-row CSV before the fix (same error string), and
locked in by `tests/indexer.test.ts` → "the pass-2 merge survives the separators real data contains".

### Fix and verification

| Item | Result |
| --- | --- |
| `encodeJsonlLine` / `readJsonlFile` (new `tools/indexer/src/jsonl.ts`) | records carrying U+2028/U+2029 round-trip; a legacy spool written by the old build still reads as one record; `\n` is the only delimiter |
| Damaged intermediate files | truncated final record, malformed record and oversized record each fail with file, line number, byte offset, record length and file size — and with **no record content** in the message (`tests/jsonl.test.ts`, 17 tests) |
| Spool completeness | `workDir/spool-manifest.json` (bytes + record count + SHA-256 per partition, renamed into place after every stream flushed); pass 2 verifies and refuses truncation, record-count mismatch or checksum mismatch (`tests/indexer.test.ts`) |
| Read-only diagnosis | `bun run index:spool-doctor` reports every partition with positions only; verified read-only (file names, sizes and mtimes unchanged) and name/email-free by `tests/spool-doctor-script.test.ts` (4 tests) |
| Disks estimate | 1.87 GB → **5.31 GB** for the 1 M sample (measured peak was 2.49 GB) and → **135.42 GB upper / 122.04 GB expected** for the full corpus on the v2 spool (the v1 format's 182.09 GB was correct for v1 and was still exceeded by 217 GB of real spool); every term is printed. Re-executed against the real bucket to produce the figures in `docs/indexing.md` |
| Duration | 120,000 rows/s (synthetic) → **5,000 rows/s measured end to end**; the run now prints per-stage timings |
| Synthetic stress run (executed) | 20,200 rows, CRLF input, a comma- and newline-containing quoted field, U+2028/U+2029 in names/industries/titles, one 200 KB field, and 200 duplicated rows: **20,200/20,200 spool records, 0 unparseable, 0 literal separators, longest record 200,463 B, 20,000 companies, 20,000 contacts, validation passed**; resume reproduced identical counts |

### What was NOT run

- The 1 M benchmark itself was **not re-run** (it needs ~5.3 GB free; this sandbox has 0.63 GB). The
  preflight over the real bucket was re-run and is the evidence for the estimates above.
- Full indexing, any upload, any publish, and any Cloudflare change: none attempted.
- The recovered spool from the failed run is untouched, and `index:spool-doctor` is the supported way
  to decide whether to reuse it.

## Pass-2 restart safety and merge performance (executed)

The interrupted `index:benchmark-1m` left a verified Pass 1 checkpoint (`stage=pass2-merge`,
1,986,239 rows, 67,157 rejected, 256 partitions, ≈1.02 GB spool, doctor-clean) **plus** the abandoned
pass-2 output (153 company objects, 38 contact objects, temporary shard postings). Restarting against
that state could append duplicate postings and re-publish objects the new run never wrote, and the
merge was the slow half of the run.

### Root causes (code inspection, then reproduced)

| # | Defect | Impact before the fix | Now covered by |
| --- | --- | --- | --- |
| 6 | `ShardWriter` opened every shard `.lines` file with flag `a`, and pass 2 replays from partition 1 | A restart appended a second copy of every already-merged posting; finalization only drops a repeat of the *previous* line, so a duplicate separated by other postings survived into the published shard — one company returned twice, its quality byte counted twice | `tests/indexer-pass2-restart.test.ts` — no duplicate postings when a company's partitions are not adjacent |
| 7 | An interrupted pass 2 left its generated objects and `objects.jsonl` in `outputDir` | Objects this run never wrote were picked up by `validate`, `upload` and the local manifest, and could be hydrated as if it had | Same file: the stale company/contact object is gone after a restart, another version's files are untouched |
| 8 | Progress was `fileIndex / spoolEntries.length`, emitted every 16 partitions | A working run printed **0%** after completing partition 1, which reads as a stall | `tests/indexer-pass2-restart.test.ts` → "pass-2 progress reporting" (3): every partition reports counters, throughput and an ETA; the restart and what it reset are announced; working/slow/stalled are classified in plain language |
| 9 | One asynchronous stream (with a `mkdir` in front of it) per posting, through a 64-handle LRU over 1,792 shard files, with `end()` never awaited | The Windows merge appeared stalled: **550,958 stream lifecycles for ≈1.15 M postings** at 10,000 companies (measured with the fs counter) | `tests/indexer-pass2-restart.test.ts` (bounded handles and buffer), benchmark counters below |
| 10 | `group.sources.some(...)` per incoming record | O(rows²) for a company with thousands of contact rows | Same file: dedup by `source:row` key with first-seen order preserved |

### Executed

```
bun run check                  PASS ×5 (4 typechecks + suite): 354 tests, 0 fail, 93,508 expect() calls
bun run lint                   exit 0, 0 problems
bun run build                  exit 0 (tsc -b + vite build, 8.6 s)
bun run index:bench-pass2      merge timing + every fs call counted (table below)
CLI interrupted/resumed run    pass 1 + pass 2, output corrupted on purpose, restart: identical payloads
```

The CLI-level restart was run against a synthetic two-source corpus (1,500 companies, 3,000 rows, 16
partitions), because the real 1 M benchmark is not restarted here. After a clean run the state was
corrupted deliberately — one company object deleted, a stale `999999.json` company object added, a
junk posting appended to a shard scratch file, a foreign version directory created — and **both
sources were truncated to their headers**. Re-running the same command:

| Check | Result |
| --- | --- |
| Spool reused, sources not read | `pass 1  0.0 s  (skipped: resumed)`, `pass 2: reusing the Pass 1 spool in … the sources are NOT read again.`, and the output is identical with the sources emptied |
| Reset scope | `restart reset 1 shard file(s), 125 generated object(s) (0.3 MB)` |
| Data equality | All **120** company/contact/index payload objects byte-identical to the clean run (per-file `sha256`); only the bookkeeping timestamps (`createdAt`, `checkedAt`, `generatedAt`) differ |
| No duplicate postings | The junk posting is gone (its shard file was deleted and not recreated), and no company appears twice |
| No stale output | `999999.json` is absent from the final output **and** from `objects.jsonl` |
| Pass 1 preserved | 16 partitions and `spool-manifest.json` byte-identical across two restarts; checkpoint still `pass2-merge` |
| Other versions untouched | `companies/v1-other/keep.json` still present |
| Validation | `validation passed` |

### Measured merge performance

`bun run index:bench-pass2` (20,000 synthetic companies, the real config's 256 partitions and 1,792
shard files, **1,275,668 postings**, 1-vCPU Linux sandbox), with every `createWriteStream` /
`openSync` / `writeSync` / `closeSync` call counted (`--fs-count`):

| Write strategy | `pass 2 merge` | Shard file opens | `writeSync` calls | Peak open handles |
| --- | --- | --- | --- | --- |
| **Batched by shard (current)** | **2.1–2.5 s** (9,333 companies/s) | **5,376** in 3 flushes (237 postings per open) | 5,376 | **1** |
| One append per shard per flush, one write per posting | 3.9 s | 5,376 | 1,275,668 | 64 |
| One open + write + close per posting | 8.5 s (2,350 companies/s) | 1,275,668 | 1,275,668 | 1 |
| Pre-fix writer (64-entry LRU of async streams over 1,792 shard files) | not re-timeable | 550,958 opens for ≈1.15 M postings (10,000 companies, same counter) | 1 per posting | 64 |

Peak buffered posting bytes: **8.39 MB** (bounded by `SHARD_FLUSH_BYTES`, 8 MiB). Finalize+index
(1.9–2.1 s) and validate (0.1 s) are unchanged, and the per-object payloads are unaffected —the batching changes *when* bytes are written, not what is written (asserted by the restart test's
byte-for-byte output comparison and by `tests/indexer.test.ts` → "re-running the indexer is
idempotent and does not duplicate records").

These are seconds on this sandbox. Run the harness on the indexing machine before planning capacity:
it prints the counters next to the times.

### What was NOT run (this phase)

- The real 1 M benchmark was **not restarted here**: its checkpoint and 1.02 GB spool live on the
  Windows machine and a re-run needs several GB free (this sandbox has 0.63 GB). Every restart claim
  above is from local, repeatable synthetic runs and the test suite.
- No R2 write, upload, publish, deployment or Cloudflare change; no `--no-resume` anywhere.
- No profiling of the real 1 M merge was possible, so the *absolute* Windows merge duration is still
  unmeasured — only the mechanism (stream lifecycles per posting) and the local comparison are.

## Search accuracy, completeness and R2 efficiency (executed)

This phase changed the *search layer* only: the index format is still v2, nothing was rebuilt,
uploaded, published or deployed, and no index/spool/checkpoint file was touched. Full write-up:
**`docs/search-quality.md`**.

### What was executed

| Command | Result |
| --- | --- |
| `bun run check` | **5/5 PASS** — 4 typechecks + **407 tests, 0 fail** (31 files, up from 354; +53 this phase); `bun run lint` 0 problems; `bun run build` exit 0 (bundle-secret scan still green with `dist/` present) |
| `bun test` | 407 pass / 0 fail; the files added by this phase are `tests/search-ranking.test.ts` (15), `tests/search-cache.test.ts` (13) and `tests/association-audit.test.ts` (20), plus 3 scorer-gate cases in `tests/search.test.ts`, 2 `Pager` cases in `tests/pages-render.test.tsx` and the ladder/retry cases in `tests/search-funnel.test.ts` |
| `bun scripts/explain-query.mjs --query zzzzzzqqqqq` (real-data sample) | 2 candidates, both from the **trigram** stage on term `zz`: `ZZP'er` and `zz`; both score 0 with gate `short-name`, coverage 0.167; **0 hits** |
| `bun scripts/benchmark-hydration.mjs --version v1-dry5-250 --repeat 2` | fixed 16 loses 20/90 rows; the 16→32→64 ladder loses 0 and keeps 75/90 of the reference's top-25 (fixed 64 keeps 90/90); **0 duplicate object reads for every strategy and query** |
| `bun scripts/benchmark-search.mjs --index-dir .indexer-output --version v1-dry5-250` | per query: up to 1,600 candidates, up to 1,200 truncated, ≤ 4 hydration sweeps, ≤ 84 R2 objects cold (≤ 1.66 MB), **0 objects and 0 bytes warm** |
| `bun scripts/benchmark-search.mjs --companies 200000` (synthetic) | recall@1 1.0, recall@5 1.0, 0 false positives on "no match" queries |
| `bun scripts/association-audit.mjs` (child process, real output layout) | four association classes with per-evidence counts; sample contains company ids/names only, no contact value |
| `bun scripts/association-audit.mjs --version v1-dry5-250 --sample 5` | 20,265 companies / 19,414 contacts, 87 families (208 companies); `confirmed` 10,143 · `plausible` 8,904 · `unresolved` 104 · `conflict` 263; sample rows are company ids + names only |
| `bun scripts/sample-report.mjs --version v1-dry5-250` | still works unchanged (exit 0) and now points at `bun run index:audit` when ambiguous companies exist |

### Root causes, established by execution

1. Whole-string similarity was normalized by length, so a 3-character company name could score
   above the threshold for an 11-character nonsense query. Nine short-name patterns measured at
   0.378–0.680 against a 0.36 threshold under the old rule; all dropped now, while every labelled
   typo/prefix/variant case still ranks first.
2. The real benchmark's nonsense-query rows come from short junk source records (`zz`,
   `ZZP'er` on the sample) reaching the trigram stage — not from stale postings, normalization or
   scoring.
3. One hydration retry reached `fixed 32`'s completeness, not `fixed 64`'s.
4. The candidate-budget truncation was invisible; it is now counted and makes the total a floor.
5. Every request re-read the directory and shards a previous request in the same isolate had
   already read; a bounded immutable-object cache now makes a repeat query read **nothing**.

### What was NOT run (this phase)

- **The 1 M index was not available here**: `v1-bench-1m` lives on the Windows machine. All
  real-data numbers above are the 20,265-company format-v2 sample (`.indexer-output @
  v1-dry5-250`). The seven names the 1 M benchmark returned for `zzzzzzqqqqq`, the 1 M hydration
  ladder table and the 1 M association audit are produced by the PowerShell block in
  `docs/search-quality.md` §10.
- No index build, no `v1-bench-1m` regeneration, no R2 write/upload/publish, no deployment, no
  Cloudflare change, and no change to the durable index format.
- Worker CPU time and end-to-end R2 latency cannot be measured without a deployment; the local
  milliseconds are a Bun proxy for CPU + gunzip + `JSON.parse`.

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
| B. Checkpoint/resume, upload retries, checksums, atomic publish + rollback | Yes — the run identity (version, sample limit, partitions, source paths/delimiters/overrides) and `workDir/spool-manifest.json` (bytes, records, SHA-256 per partition) are verified before merging, and a **pass-2 restart** reuses the Pass 1 spool, resets only its own generated output and temporary postings, then replays from partition 1 | `tests/indexer.test.ts`, `tests/indexer-pass2-restart.test.ts` (13: byte-identical resumed output, no duplicate postings, no stale objects, spool+manifest unchanged, twice-interrupted cleanup, other versions untouched, hydration across partition boundaries, progress counters, determinism, bounded handles/memory), `tests/spool-doctor-script.test.ts`, `tests/indexer-r2-source.test.ts` (cache/resume), `tests/r2-client.test.ts` (retry counts), `tests/e2e-index.test.ts` | Partition-level pass-2 resume does not exist (deliberately: a full replay is provably identical, and is what the tests assert) | Interrupt a real sample run and resume it |
| Quality gates (typecheck ×4, tests, lint, build, both bundles, indexer CLI) | **Yes — executed with exit codes recorded**: `bun run check` 0 (5/5 PASS), `bun run lint` 0 (0 problems), `bun run build` 0, `wrangler deploy --dry-run` 0 for the Worker and the probe, indexer `--help`/`--preflight-only` as documented, `bun run index:spool-doctor` exit 0/1/2 as documented | `bun run check` (**407 tests, 0 fail**, up from 354; 5/5 PASS), `tests/indexer-pass2-restart.test.ts`, `tests/jsonl.test.ts`, `tests/spool-doctor-script.test.ts`, `tests/search-funnel.test.ts`, `tests/search-ranking.test.ts`, `tests/search-cache.test.ts`, `tests/association-audit.test.ts`, `tests/frontend-secrets.test.ts` | Bundle validation is `--dry-run` only; nothing was deployed | Deploy to the preview environment after the Access app exists |
| C. Worker API routes on a real handler | Yes (Bun runtime) | `tests/api-e2e.test.ts` (19) | Not workerd; no browser | Run the 12-step browser checklist after deployment |
| C. Browser rendering, all screens, loading/empty/error states | **BLOCKED here** | — | Real rendering unverified | Follow the Phase C checklist in this document |
| D. Access protection of frontend + API | Yes | `tests/security-access.test.ts` (20) incl. fail-closed in production and no `Cf-Access-*` header spoofing | Exact production config unverified | Create the Access app, set the 3 secrets, confirm `curl` → 401 |
| D. JWT signature/iss/aud/exp validation | Yes | `tests/security-access.test.ts` (real RS256 keys, tampered/expired/nbf/alg-none rejected) | JWKS rotation handled by cache TTL | — |
| D. No workers.dev bypass, no preview exposure, private bucket, no cached private data | Yes — `workers_dev = false` is now set in `wrangler.toml` (only `env.development` keeps it true), and the Worker fails closed on any hostname because it verifies the Access JWT itself | `tests/api-e2e.test.ts` (CORS 403, `no-store` on private responses, security headers), `tests/security-access.test.ts` (20), `tests/frontend-secrets.test.ts` | Removing the alias hostname means the Worker needs your custom-domain `[routes]` entry to be reachable | Add the route, confirm Access covers it, then deploy (steps 1–10 of the Phase D list) |
| D. No credentials in the frontend bundle | **Yes, now including the built bundle.** `bun run build` exits 0, and the `dist/` scan finds no server-only identifier (`R2_*`, `CF_ACCESS_*`, `ALLOWED_EMAILS`, the R2 binding name) and no Access team domain. The scan caught one real leak while being enabled: the preview-mode error string named the Worker's R2 binding, so it was reworded — a user-facing sentence is not an excuse to ship a server identifier | `tests/frontend-secrets.test.ts` (all 5 assertions real) | — | Re-run the scan after any bundle-affecting change |
| E. Median/p95 latency, R2 requests, bytes | Yes — re-measured against the **real-data** sample index after the hydration bound: 16–25 ms, 24–35 GETs, 0.43–0.51 MB per cold query (was 0.10–0.24 s, 19–30 GETs, ≤ 2.07 MB) | `scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-dry5-250`, `scripts/benchmark-search.mjs` | Sandbox variance ~2×; corpus is a 20 K sample; reads are local, not networked | Re-run both on your machine, then re-measure with the 1 M sample |
| E. Search completeness under the hydration cap | Yes — `bun run bench:hydration` measures six hydration strategies against the real-data sample and the complete answer: the old fixed-16 default lost 20 of 90 rows on broad queries, the **16→32→64 ladder** loses 0 (`rows lost 0`, `top-25 75/90`, 2.38 sweeps, 0 duplicate object reads), and stops climbing as soon as the page fills or the partition cap was not the limit, so a precise query still pays one round of reads | `scripts/benchmark-hydration.mjs`, `tests/search-funnel.test.ts` (ladder, retries, no duplicate reads), `tests/search-ranking.test.ts` (partition budget, early stop, pagination) | The ladder's third rung bought **no** extra `top-25` rows on the 20 K sample (75/90 with one rung, 75/90 with two); its value at 3,950 partitions is unmeasured. `SEARCH_MAX_HYDRATE=64` (a flat 64-partition sweep, `top-25 90/90`) is the operator dial either way | Re-run on `v1-bench-1m`; if the third rung still adds nothing there, drop to one rung and halve the bytes |
| Search accuracy, ranking gates and R2 reuse (this phase) | Yes — whole-string fuzzy scoring is length- and coverage-gated (`score.ts`), domain evidence is a band-internal tie-break, whole-name retrieval defers the fuzzy stages and recovers them only when the page is short, truncation and budget limits are reported (`retrieval.truncated`, `totalIsLowerBound`, short-page notice), and a bounded per-isolate immutable-object cache makes a repeat query read **0 objects / 0 bytes** | `tests/search-ranking.test.ts` (15), `tests/search-cache.test.ts` (13), `tests/search-funnel.test.ts` (9), `scripts/explain-query.mjs`, `scripts/benchmark-search.mjs`, `scripts/benchmark-hydration.mjs` | Measured on the 20 K real-data sample + synthetic 200 K, not on `v1-bench-1m`; Worker CPU is not measurable without a deployment | Run the PowerShell block in `docs/search-quality.md` §10 |
| Company↔contact association audit (read-only, company ids only) | Yes — four evidence classes (`confirmed` 10,143 / `plausible` 8,904 / `unresolved` 104 / `conflict` 263 on the real-data sample), domain, country and name evidence reported separately, a normalized-name match alone is never `confirmed`, and provenance limitations are printed with the numbers | `tests/association-audit.test.ts` (20), `tests/association-report.test.ts` (7), `scripts/association-audit.mjs` (run as a child process, exit 0, no contact value in the output) | The index holds no source-level join key, so no association can be verified against the original rows — stated, not worked around | Read the recommendations; fix the join rules before the full production index, then re-run `bun run index:audit` |
| Bundle validation (Worker + probe) | Yes — `wrangler deploy --dry-run` builds both bundles: Worker 737 KiB (126 KiB gzip) with the R2 + assets bindings, probe 39 KiB, `workers_dev = false`, `ENVIRONMENT` correct in each. The first run exposed a **deployment blocker**: a duplicated `SEARCH_MAX_HYDRATE` key made `wrangler.toml` invalid TOML | `bunx wrangler deploy --dry-run`, `bunx wrangler deploy --dry-run -c probe/wrangler.toml` | `--dry-run` validates config + bundling only; it does not contact Cloudflare or prove a deploy succeeds | Deploy to the preview environment once the Access application exists |
| E. CPU time, memory, cache hit rates, real index size | **Partly** — local CPU/bytes measured; workerd CPU and browser cache hits are not measurable without a deployment | Phase E tables | After the hydration bound a cold query reads ~0.45 MB and scores ~20 docs (was ~2 MB and 400), but the local figure is still ~20 ms on one sandbox vCPU — a Free-plan 10 ms CPU budget is **not proven** either way without workerd measurement | Decide Free vs Paid from `wrangler tail` CPU on a real deployment; `SEARCH_MAX_HYDRATE` tunes the trade-off |
| F. Lead-loss scenarios identified and recovered | Yes | `tests/leads-recovery.test.ts` (7), `tests/worker-store.test.ts` (6), `tests/api-e2e.test.ts` (repair route) | R2 has no cross-object transaction | Use `POST /api/leads/repair` if the app ever reports a mismatch |
| F. No new database introduced | Yes — R2 objects only, directory is derived data | `tests/leads-recovery.test.ts` | — | — |
| G. Full execution plan with sources, mappings, resources, costs, validation | Drafted with explicit placeholders | `docs/execution-plan.md` | Real numbers unknown until sample runs | Approve after sending the Phase A outputs + sample timings |

## Phase H — two-stage company ↔ contact association

Scope: replace the immediate name-join attachment with Stage A (company identity) + Stage B
(per-contact evidence), stop identifier ownership from being reassigned, preserve contacts whose
employer cannot be established, and measure the result. Rules and procedures: `docs/association.md`.

**All measurements below are synthetic.** This environment has no access to the Windows Pass 1
spool, the 64 GB sources or the `v1-bench-1m` index, so nothing here is a real-data claim.

| Item | Result | Evidence |
| --- | --- | --- |
| Identifier ownership cannot be reassigned | Confirmed fixed. `CompanyResolver.claim()` is first-owner-wins; a later row carrying an owned domain/LinkedIn/source id is refused, counted (`identifierConflicts`) and sampled. Replay never moves a key, in either input order. | `tests/indexer-association.test.ts` → "identifier ownership is never reassigned" (5 cases) |
| A contradicting row is not treated as a verified company | Confirmed fixed. A record whose strong keys were all refused reports `identityClaimed: false` / `strong: false`, so Stage B never offers it as a credible employer. | same file, "a contradicting row creates its own record and claims nothing that is taken" |
| Repeated contradicting rows stay bounded | Confirmed fixed: one record per evidence pattern (`bySignature`), 25 repeats → 0 new records. | same file, "a repeated contradicting pattern joins one record …" |
| Contacts are associated on evidence, not on the name join | Implemented as `associateContact()` (pure, order-independent, no percentages) over four categories; 32 unit cases plus an end-to-end fixture where every outcome occurs once, including a run that reverses the company rows and gets identical employers and verdicts. | `tests/association.test.ts` (32), `tests/indexer-association.test.ts` |
| A personal address is not corporate evidence; a domain mismatch does not relocate a contact; country never relocates on its own | Confirmed by unit tests. A foreign domain is `conflicting` **only** when the row identified an employer it can contradict; for a row that carried just a name there is no claim to accuse, so the evidence that does exist (country) attaches it as `plausible`. | `tests/association.test.ts` → "a contact row that carried no employer identity has no employer claim" |
| A contact row that carried only a company name has no employer claim (defect found and fixed in this phase) | Fixed: `build.ts` passes `NO_CLAIM_REF` for such rows, so they are never attached to whichever record owns the shared name key. Order-independence, the parent/subsidiary case and the ambiguous family are all asserted. | `tests/indexer-association.test.ts` → "reversing the company rows changes neither the employer nor the verdict"; `scripts/lib/association-scenarios.mjs` |
| Ambiguous contacts are not shown as employees | `unresolved` contacts are written to `unassigned/<version>/…`, are not counted in `contactCount`, are absent from contact search, and appear only in the company profile's review panel. | `tests/indexer-association.test.ts` (preservation + Worker `/unassigned`), `tests/pages-render.test.tsx` |
| No contact silently disappears; counts and facets reconcile | End-to-end fixture: `contactCount` sum, `associations` split and every facet equal what is stored; 0 duplicate ids; manifest `uniqueContacts` = attached + preserved. The audit recomputes all of this from the objects, not the counters. | `tests/indexer-association.test.ts` → "the association audit, on a real generated index" |
| Deterministic output | Two builds of the same fixture are byte-for-byte identical except `createdAt`; a resumed/restarted pass 2 stays identical. | `tests/indexer-association.test.ts`, `tests/indexer-pass2-restart.test.ts` |
| Format v2 stays readable; v3 is additive | `SUPPORTED_INDEX_FORMAT_VERSIONS = [2, 3]`; a missing category is "not classified", the association filter is inert on v2, and `unassigned` is optional in the directory. | `tests/worker-store.test.ts`, `tests/worker-r2-binding.test.ts`, `tests/association.test.ts` |
| Audit reports both rule sets and the new counters | `bun run index:audit` prints stored categories, preserved contacts, moves, legacy-class → stored-category cross-tab and reconciliation; `unclassified` is never folded into `plausible`; no contact value is read into the report. | `tests/association-audit.test.ts` (25; includes the real generated index run) |
| Cost of the change, measured (`bun run index:bench-pass2`, `bun run index:bench-assoc`) | Pass 2 merge on the one-company-per-name corpus (20,000 companies, 1,275,668 postings): **2.9 s / 6,947 companies/s** versus the pre-change 2.1–2.5 s / 9,333 companies/s, with identical objects (1,896), postings, shard appends (5,376 in 3 flushes) and peak buffer (8.39 MB). On the adversarial one-name family (1,000 companies × 10,000 contacts): **0.9 s, 11,682 contacts/s, 98 MB RSS**, after capping the stored candidate ids (the same corpus took 2.1 s and 335 MB while every candidate id was stored). | `docs/association.md` §7b | These are synthetic corpora on a 1-vCPU sandbox | Re-run both harnesses on your machine before the full run |
| Quality gates | `bun run typecheck` 0 (4 projects), `bun test` **456 pass / 0 fail**, `bun run lint` 0 problems. Production build deliberately not run (not requested; the Worker bundle is unchanged in shape). | commands run in this phase |
| Real benchmark before/after | **NOT RUN — blocked by design.** The comparison procedure, the fields to compare and the exact PowerShell is in `docs/association.md` §7; `v1-bench-1m` is never opened for writing. | — |

Remaining unverified for this change: the real-data category distribution, the number of contacts
reassigned on real data, and Worker CPU/memory for the `unassigned` read path (it is one extra
small object per company-profile review request, and is cached like any immutable object).

## Phase I — experimental Pass 2 rebuild from an existing spool

Scope: make the documented `v1-bench-1m` association comparison actually runnable. The old procedure
(`run --version v1-bench-1m-assoc`) is refused because the run identity includes the dataset version;
its documented fallback (`--no-resume`) would delete the 1.02 GB Pass 1 spool and re-read 64 GB from
R2. The fix separates **source run identity** from **output index version** for one explicit command
(`pass2-from-spool`) and leaves ordinary resume strict.

| Item | Result | Evidence |
| --- | --- | --- |
| Ordinary resume still rejects an incompatible version | Confirmed by test, including a sample-limit and a partition-count difference; the source work directory is byte-identical afterwards | `tests/indexer-spool-import.test.ts` → "ordinary resume still owns its run identity" (3) |
| Explicit rebuild accepts a verified compatible spool | Confirmed: `resumed: true`, `pass1Ms: 0`, `profilingMs: 0`, **0** source/R2 requests, validation passed, and the same counters as the source run | same file → "accepts a verified compatible source spool …" |
| Source configuration mismatch is rejected | Path, delimiter, partition count and an asserted sample limit each stop before anything is merged | same file → "source validation" (path, delimiter, partitions, sample limit) |
| The engine itself never clears an imported spool | `runIndex` called directly with an import whose derived checkpoint is missing refuses, and the source `spool/` is byte-identical with no directory created | same file → "the engine never clears an imported spool …" |
| Corrupted spool is rejected | Truncated partition (length) and same-size byte flip (SHA-256) both refused; an incomplete manifest too | same file (3) |
| The original checkpoint, manifest and partitions are byte-identical | Whole source work directory digested before/after an import (`toEqual`) | same file → "checkpoint, manifest and every partition stay byte-identical" |
| The original generated index is unchanged | Whole source output directory digested before/after, plus `manifests/active.json` at file level | same file → "the original generated index and manifests/active.json …" |
| The experimental index has its own version and output files | `directory.json` version, `manifests/<new>/`, `companies/<new>/`, **no** `active.json` in the experimental output, and no `<new>` directory in the source output | same file → "the experimental index is its own artifact" |
| Interruption and restart create no duplicate postings or stale objects | The real process is killed mid-merge (`process.exit(97)` from the progress callback); the restart is byte-identical to a clean import (timestamps excluded), has the same object keys, and every shard's `refs` list is duplicate-free. A workspace interrupted between the import record and the checkpoint is recovered too | same file → "interruption and restart" (3) |
| The two-stage association works on the imported spool | high-confidence (email-domain identified, no invented `movedFrom`) and unresolved contacts are all present after import; the unresolved one is only in `unassigned/`, with `companyId: ""`; counters match the source run; every company's `contactCount` equals its association total | same file → "association on the imported spool" |
| The CLI is the operator interface | `--check-only` validates and writes only the isolated bookkeeping; the full command builds and validates the new version; `--upload` and malformed flags are refused with exit 1 and nothing written | same file → "the CLI is the interface an operator actually uses" (3) |
| Quality gates | `bun run typecheck` **0** (4 projects), `bun test` **479 pass / 0 fail** (34 files; +23 this phase), `bun run lint` **0** problems, `bun run build` **0** | commands run in this phase |

**Not run here (and why):** the real 1 M rebuild. This environment has no access to the Windows
Pass 1 spool (`v1-bench-1m`), so nothing was read from R2, no index was uploaded, published or
deployed, and `manifests/active.json` was never written. The exact PowerShell is in
`docs/association.md` §7; the safety properties above are asserted against synthetic corpora using
the real indexer, including a real mid-merge process kill.

## Phase J — independent verification of the association rules (this round)

Scope: re-verify the two-stage association and the experimental import end to end, look for defects
rather than confirm the implementation, and report quantitatively. All measurements are synthetic;
the real spool is not in this environment.

| Item | Result | Evidence |
| --- | --- | --- |
| **Defect found and fixed: a name-only contact row was judged against an arbitrary company of its name family** | The resolver returns the record that owns the shared `n:` key for a row that carries only a company name (the first company of that name in the input), and Stage B was passed that ref as if the row had claimed it. Reversing the two company rows flipped a contact between `plausible` and `conflicting` and changed which company it was attached to. Build now passes `NO_CLAIM_REF` for every row without an employer identifier, so only the contact's own evidence may attach it. | `tools/indexer/src/build.ts`, `src/shared/association.ts`; `tests/indexer-association.test.ts` → "reversing the company rows changes neither the employer nor the verdict" (fails on the pre-fix code); `tests/association.test.ts` → 4 new no-claim cases |
| No fabricated provenance | A domain match on a row that carried only a name is now `email_domain_matches_assigned_company` with **no** `movedFrom`; a move is recorded only from an employer the row actually identified. | `tests/indexer-association.test.ts` (Gina Rossi), `tests/indexer-spool-import.test.ts` (Omar Farouk), scenario corpus (6 former moves → 0) |
| Every association situation the specification lists is covered by one repeatable corpus | `scripts/lib/association-scenarios.mjs` builds the 11 required situations (identical names in different countries, subsidiaries, similar brands, corporate domains, public providers, conflicts, job changes, duplicates, missing identifiers, missing country/domain, ambiguous names), indexes them with the real pipeline, checks each contact's expected category/reason/employer, and reconciles the result independently: **36 rows → 32 stored + 4 duplicates; 16 high, 9 plausible, 3 conflicting, 4 unresolved, 4 preserved, 0 fabricated moves**; 0 lost contacts, 0 duplicated ids, 0 count/split/facet mismatches. | `bun run index:assoc-scenarios`; `tests/association-scenarios.test.ts` (6 cases) |
| Uncertain contacts are never presented as confirmed employees | In the corpus: personal-address-only contacts are plausible (never high); a parent-company domain at a subsidiary is plausible; ambiguous families stay `unresolved` and are preserved with `companyId: ""`; every `conflicting` contact is attached and labelled, never counted as verified. | `tests/association-scenarios.test.ts` → "uncertain contacts are never presented as confirmed employees" |
| The scenario report contains no contact values | The printed report is counts, reason-free labels and invariants only; asserted to contain no `@` and none of the synthetic names. | same file → "the printed report is counts only" |
| Experimental import still verified after the association change | The full spool-import suite passes unchanged: identity validation, isolation, corruption refusal, byte-identical originals, mid-merge restart, and the association result on the imported spool. | `tests/indexer-spool-import.test.ts` (23) |
| Quality gates | `bun run typecheck` **0** (4 projects), `bun test` **491 pass / 0 fail** (35 files), `bun run lint` **0** problems, `bun run build` **0**. | commands run this round |
| Real benchmark | **NOT RUN.** The 1.02 GB Pass 1 spool, the `v1-bench-1m` index and the 64 GB sources are not present in this environment; nothing was read from R2, uploaded, published or deployed, and `manifests/active.json` was not written. | — |

Remaining unverified: the real-data effect of the no-claim rule (how many `v1-bench-1m` contacts
move from `conflicting` to `plausible`/`unresolved`), real reassignment counts, and real-data
category shares. The scenario corpus is adversarial and synthetic and is not an accuracy estimate.

## Phase K — full-field preservation, activation path and the full-index automation (this cycle)

Scope: close the field-preservation gap (the reported 400-character / 80-column caps), make the
activation path verified end to end, and harden the one-command full-dataset pipeline. Every item
below was executed, not reviewed; the R2 measurements are against the real bucket.

| Item | Result | Evidence |
| --- | --- | --- |
| **Real schemas measured (read-only, from R2)** | `raw/file1.csv`: 51 columns; longest values `organization_all_possible_domains` 3,539, `organization_short_description` 3,011, `organization_current_technologies` 2,841, `job_functions` 1,164. `raw/file2.csv`: 39 columns; longest `prospected_by_team_ids` 168, `person_linkedin_url` 152. The old 400-character cap therefore destroyed real data. | `bun run r2:schema --json --bytes 1500000` |
| **Defect fixed: field truncation and column cap** | `MAX_CAPTURED_VALUE_LENGTH` (400) and `MAX_CAPTURED_FIELDS` (80) are gone. Every column is captured verbatim, **mapped ones included** (the canonical value is normalised, the raw one is not); a duplicate header becomes `header#2` in file order; a company built from rows of both files unions their columns and keeps a genuine conflict as `<header> (source <id>)`; empty cells are omitted (a TSV cannot distinguish an empty cell from a short row). | `tools/indexer/src/mapping.ts`, `tools/indexer/src/build.ts`; `tests/captured-attributes.test.ts` (7) |
| No lossless capture without a bound on cost | A search result is a summary: `CompanySearchHit`/`ContactSearchHit` carry no `attributes`, and the full row is returned only by `GET /api/companies/:id` and `/api/contacts/:id`. Long text is collapsed in the UI by `LongText` (“Show all N characters”), never shortened in storage. | `tests/api-e2e.test.ts` (hit has no attributes, detail has all of them), `tests/pages-render.test.tsx` (collapsed render + character count) |
| Verified on real data, in the running preview | Active version rebuilt as `dev-r2-20k-fields-20261017` (20,259 companies / 19,414 contacts, 491 objects, 40.4 MB). Live API: Tesla → 72 columns, longest 756 chars; Microsoft (merged from both files, 106 columns, six values > 400 chars, none ellipsis-marked); a contact → 29 columns; a 1,345-character description returned whole. Search hits carry no attributes. | `curl` against the preview, recorded above; `bun scripts/dev-index-r2.mjs verify` 491/491 byte-for-byte |
| **Defect fixed: `validate` proved nothing about the bucket** | `validate` only re-hashed local files. Added `validate --remote` (bounded by `--offset`/`--limit`), which reads each object back from R2 and compares content after gzip normalisation, then confirms the uploaded manifest + validation report. | `tools/indexer/src/cli.ts`, `verifyRemoteObjects` in `tools/indexer/src/build.ts`; run against the real bucket (12 objects + manifest/validation confirmed) |
| **Defect fixed: `publish` trusted the local validation report** | Publishing could point the application at a version that was never uploaded, or was half-uploaded. `publish` now requires R2's own manifest (same version, `validationPassed`) and validation report (`passed: true`) before flipping the pointer, and it still records `previousVersion` as the rollback target. | `tools/indexer/src/build.ts`; `tests/publish-verification.test.ts` (5) |
| Manifests can no longer look complete mid-upload | `uploadOutput` orders the objects so `manifests/<version>/*` are written last (the progress object very last), regardless of the writer's order. | `tests/upload-activation-order.test.ts` (2 ordering + 3 rollback cases) |
| **Defect fixed: the preview could not follow a new activation** | The served version was resolved once at dev-server start, so a newly published index would never be served without a restart the platform does not perform. The shim now resolves the pointer per request: an explicit `COMPANYINTEL_DEV_DATASET_VERSION` pins, otherwise the newest activation of {this process, R2} wins, with the R2 pointer re-read at most every 5 s. `tools/dev-api/*` is loaded through Vite's module runner, so a shim fix takes effect without a restart. | `tools/dev-api/dev-bucket.mjs`, `tools/dev-api/vite-plugin.mjs`; `tests/dev-bucket-pointer.test.ts` (6) |
| Activation verified end to end, live | The new version was built (28.2 s), uploaded resumably (491 objects), verified object-by-object from R2, published with the new guard, and the **running preview switched to it automatically** (`/api/dataset/status` → `dev-r2-20k-fields-20261017`), then served real full-field records. | commands + `curl`, this cycle |
| **Defect fixed: flat disk guards blocked small runs** | A 256 MB flat bookkeeping charge and a flat 512 MB mid-run floor refused a 3 MB fixture run on a volume with 300 MB free — 44 suite tests failed for that reason alone. Both now scale with the run (bookkeeping `rows × 8 B`, floor `min(512 MB, output × 1.5)` with a 16 MB minimum); explicit `--disk-floor` still wins. | `tools/indexer/src/build.ts`; `tests/indexer.test.ts` (scaling case), fixture + pipeline tests |
| One-command pipeline hardened | `bun run index:full` / `index-full.cmd` now run 20 labelled stages: dependencies, source version (git commit + dirty flag), cost estimate (R2 storage/Class A/Class B), resume state (checkpoint stage, version, sample limit, spooled partitions), preflight, index, **coverage gate** (a `--sample` run is PARTIAL and `--activate` is refused before anything is built), upload, bounded remote verification, activation, and a JSON summary with counters, objects, bytes, cost and coverage. `--no-upload` and `--sample` are the test/smoke paths. | `scripts/full-index.mjs`, `index-full.cmd`, `tools/indexer/indexer.dev-smoke.json`; `tests/full-index-pipeline.test.ts` (4, real child process) |
| Hydration ladder: cost analysed, then made affordable by the index layout | The ladder's cost is `partitions × partition bytes`, not the number of rungs: on a v3 index a sparse query walked to 64 partitions of 1.2 MB (78.6 MB). A "stop when a rung ranks nothing" rule was tried and **rejected** — it is not evidence about the partitions a later rung would reach, and it drops reachable rows. Phase L removes it and pays for the safe ladder by shrinking the partition instead. | `src/shared/search/engine.ts`; `tests/search-funnel.test.ts` (later-partition recall, pagination vs exhaustive reference); `docs/search-quality.md` §5 |
| Quality gates | `bun run typecheck` **0** (4 projects), `bun test` **541 pass / 0 fail** (41 files), `bun run lint` **0** problems, `bun run check` **5/5 PASS**. | commands run this cycle |
| **NOT DONE: the full 64.26 GB index** | This sandbox has ~0.4 GB free; the preflight requires ~182 GB (132 GB with `rawCacheDir: null`). Nothing about the source objects was modified, no spool was deleted, and no benchmark version was touched. | See the delivery report: the one command for the machine that holds the corpus |
| **NOT DONE: real-data accuracy on the full corpus** | Every accuracy statement above is measured on the 20 K-row development sample; the full-index run is what turns them into full-corpus statements. | — |

## Phase L — search/detail split (format v4), ladder correction, measured end to end

Scope: stop a search from paying for columns it never reads, without losing a single field, a
record or a result. Everything below was executed against the real bucket and the running
preview, not estimated.

| Item | Result | Evidence |
| --- | --- | --- |
| **Format v4: search projections + detail objects** | `companies/` and `contacts/` now hold only what a query matches, ranks, filters and shows; `attributes` (every source column) and `facets` moved to `details/<version>/{companies,contacts}/` on the **same** partition boundaries and refs. | `src/shared/search/index-format.ts` (`INDEX_FORMAT_VERSION = 4`, keys, payloads), `tools/indexer/src/build.ts` (both halves written together), `worker/src/store.ts` (merge on record reads) |
| Partition size | 20,259-company dev index: company partitions **1.2 MB → 21 KB** (min 21.4 KB … max 22.8 KB across 82 objects). | `du`/`ls` of `.indexer-dev-output`, `directory.json` bytes |
| Record views stay complete | Opening a record reads its projection + exactly one detail object. Tesla: 72 columns, longest 756 chars; Microsoft: 106 columns, longest 839; contact: 27–33 columns. Search hits carry no `attributes`. | live `curl` against the preview on `dev-r2-20k-proj-20261017`; `tests/e2e-index.test.ts` (attributes present on the record, absent from the hit, exactly one detail read) |
| Search never reads a detail object | Asserted directly: a search over the generated fixture reads **0** `details/` objects; the record view reads exactly 1. | `tests/e2e-index.test.ts` |
| **Ladder rule corrected** | The `no_new_hits` stop was removed: an unproductive rung says nothing about the partitions it did not reach. Remaining stops are the confident-page barrier (`WEAK_CEILING`), an exhausted candidate set (`ladderStopped = "candidates_exhausted"`), the source reporting the cap did not bite, and the 64-partition ceiling. | `src/shared/search/engine.ts`; `tests/search-funnel.test.ts` — later-partition recall after an unproductive rung, page 2 vs an exhaustive reference, large sets, equal scores, many partitions |
| Company-search performance, same queries and records | exact: 78.5 MB / 6.19 s → **8.0 MB / 5.08 s**; fuzzy: 78.4 MB / 5.86 s → **1.24 MB / 1.95 s**; sparse: 74.9 MB / 7.75 s → **1.51 MB / 2.30 s**; broad: 79.0 MB / 6.21 s → **1.33 MB / 1.98 s**. Warm repeats **~0.09–0.10 s, 156 bytes**. Same hit counts and ids. | `bun scripts/benchmark-preview.mjs before|after` through the preview |
| Contact-search performance | exact 3.07 s → 2.55 s, fuzzy 3.20 s → 1.51 s (warm 0.11 s); same 25-hit pages and totals (164 / 300). Contact projections carry no source columns. | same run |
| Index size | Total 40.4 MB → 41.1 MB (+1.7%): the split moves bytes rather than deleting them (details 23.5 MB, projections 3.8 MB, shards 13.8 MB). The saving is at query time, not on disk. | `directory.json` `bytes` |
| Compatibility + rollback | v2/v3 indexes remain readable inline (no detail read). Activated v4 in the preview, then rolled back to `dev-r2-20k-fields-20261017` (served, searched), then re-activated v4. The R2 pointer is untouched by the preview. | `POST /api/dataset/activate` + `GET /api/dataset/status`; `tests/index-detail-split.test.ts` (v4 merge, v3 inline, missing detail object still opens) |
| Index build, upload, remote verification | Built `dev-r2-20k-proj-20261017` from the same real sample (20,259 companies / 19,414 contacts, 594 objects, 41.1 MB, validation passed) in **26.6 s** with **0.56 GB peak RSS** and **0.16 GB peak temp disk**; uploaded resumably and verified **594/594 objects byte-for-byte from R2**. | `tools/indexer/src/cli.ts run --sample 20000 --no-upload`, `scripts/dev-index-r2.mjs upload|verify` |
| Audit still checks real values after the split | `facets` moved to `details/`, so the facet reconciliation would have reported "0 disagree" for a field it never read. `scripts/association-audit.mjs` now merges the detail records (format ≥ 4) before auditing: **20,259 companies checked, 0 disagree** on the dev index, and the test asserts `facets.checked > 0` and `detailsMerged > 0`. | `scripts/association-audit.mjs`; `tests/indexer-association.test.ts` |
| Quality gates | `bun test` **550 pass / 0 fail** (42 files), `tsc -b --noEmit` 0, `eslint .` 0 problems. | commands run this cycle |
| **NOT DONE: the full 64.26 GB corpus** | This sandbox has ~0.12 GB free; the run needs ~182 GB (or ~94 GB with `rawCacheDir: null`). The optimized indexer is what `index-full.cmd` drives; it has not been run on the full corpus. | see “the single remaining action” in the delivery report |

## Remaining risk (unchanged by this phase)

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| Real CSV schemas differ from the fixture | Resolved: both real files are TAB-separated, and their headers/columns are now measured and mapped | `bun run r2:schema` + per-source `columns` overrides; the mapping is committed in `indexer.config.json` |
| Two files do not share a strong identifier | Confirmed by measurement: the id namespaces differ, so the cross-file link is the normalized company name | Name-only rows merge only with name-only records; a strong-identity conflict keeps records apart **and** flags them; on the sample this affected 1.17% of contacts, all flagged |
| Full-run resource exhaustion | Only a real sample run can measure it | Preflight counts the spool (v2: 23.02 expected / 33.71 upper), the Mode B staging file, the generated index and bookkeeping and refuses on the upper sum (135.42 GB; ~68 GB with `rawCacheDir: null`); `--spool-max-gb` is a hard ceiling, a mid-run floor stops a filling volume, and checkpoint/resume + segment manifest make the stop safe |
| Real data contains characters that are line terminators to a reader | Found once already (U+2028/U+2029), which is why the intermediate format now escapes them **and** the reader splits on `\n` only | Both halves of the fix are independently tested, including reading a legacy file written by the buggy build |
| Workers Free CPU ceiling | Needs production measurement | Documented; decision deferred to you |
| Cold search latency is round-trip-bound | 64 small partitions + ~13 shards per search; on this 1-vCPU sandbox that is 2–5 s cold, 0.1 s warm. A real Worker's RTT is far lower, but the number is unmeasured there. Per-partition score bounds (a future format change) would end the climb sooner without risking recall. | warm path proven (156 bytes); cold cost reported honestly |
| R2 eventually consistent writes | Two tabs, different objects | ETag preconditions + repair path |

## Phase M — Cloudflare staging preparation and the controlled benchmark (this cycle)

Executed here, in this workspace. Nothing was deployed and no full-corpus job was started.

| Check | Result | How |
| --- | --- | --- |
| Production build | **PASS** — `tsc -b` + Vite, 43 assets, no errors | `bun run build` |
| Complete test suite | **PASS — 612 pass, 0 fail** across 51 files (run twice after the final edit) | `bun test` |
| Lint | **PASS** — 0 problems | `bun run lint` |
| Typechecks (app, worker, indexer, probe) | **PASS** | `bun run typecheck` |
| Wrangler configuration + Worker dry-run (production) | **PASS** — binds `INDEXER_CONTAINER`, `COMPANY_DATA`, `ASSETS`, `CLOUD_JOB_BUDGET_USD`; lists `companyintel-indexercontainer` | `bunx wrangler deploy --dry-run --containers-rollout=none` |
| Wrangler configuration + Worker dry-run (staging) | **PASS** — `companyintel-staging`, `STAGING_MODE`, `ACTIVE_MANIFEST_KEY=staging/active.json`, `companyintel-staging-indexercontainer` | `bunx wrangler deploy -c wrangler.staging.toml --dry-run --containers-rollout=none` |
| Container image build | **NOT RUN HERE** — Docker is not installed in this workspace. Workers Builds builds Dockerfiles inside Cloudflare, which is the intended first build. | — |
| Secret-binding validation without values | **PASS (static)** — `tests/staging-config.test.ts` asserts neither Wrangler config contains a secret name or value; `tests/worker-r2-binding.test.ts` asserts `R2_*` appears only in the container bridge, exactly once each. `wrangler secret list` is the post-deploy check (needs a token). | same tests |
| Staging isolation | **PASS** — `tests/staging-isolation.test.ts` drives the real admin router: an unauthenticated, unconfigured request is refused (no Access application, no dev bypass), non-`stg-` version refused (400), full-corpus start refused (403), staging lists only `stg-` jobs, activation writes `staging/active.json` while `manifests/active.json` stays byte-identical, production still activates `manifests/active.json`, and an unverifiable version cannot be activated | same test |
| Pass 2 finalize-phase resume | **PASS** — with the finalize phase interrupted, a restart reads **0** Pass 1 segments, completes, and produces objects byte-identical to an uninterrupted run (version ids normalised) | `tests/cloud-pass2.test.ts` |
| Combined job budget | **PASS** — `CLOUD_JOB_BUDGET_USD` pauses Pass 2 at a partition boundary using R2 + container cost; `CLOUD_BUDGET_USD` still works as a deprecated alias | `tests/cloud-budget.test.ts`, `tests/cloud-pass2.test.ts` |
| Streamed shard serialization | **PASS** — bytes identical to `JSON.stringify` (including U+2028 and a term named `constructor`), each term released as it streams | `tests/shard-stream.test.ts` |
| Pass 2 shard memory | **MEASURED** — `bun run bench:shard-memory`: 500 k / 2 M / 8 M postings → 10.7 / 29.0 / 300 MB peak RSS; fitted ≈ 47 B RSS and ≈ 2.27 B gzip per posting; a realistic worst case (4 M postings in one term) projects ≈ 181 MB against a 4 GiB instance | `scripts/benchmark-shard-memory.mjs` |
| Source preservation | **PASS** — `bun scripts/source-archive.mjs`: 310 entries, 0.92 MB, sha256 `5c35f1c6…` printed, no `node_modules`, no credentials/secrets/data, working tree unmodified | script output |

Two real defects were found and fixed while adding these tests:

1. **`/api/cloud/*` would have answered 404 on a deployed Worker.** The admin router registered
   `/jobs`, `/preflight`, … while the entrypoint dispatches the full path; the preview worked only
   because the dev server serves those routes itself. Fixed with `basePath("/api/cloud")` and
   covered by `tests/staging-isolation.test.ts`.
2. **A refused Pass 2 partition leaked an open file handle.** A checksum mismatch destroyed the
   merge but left the write stream open, so cleanup raced a pending write (an unhandled `ENOENT`
   that failed a later test). `preparePartition` now destroys the stream and removes the partial
   file before rethrowing.

Remaining unverified: the Cloudflare deploy itself, the container image build, Access against a
real deployment, every benchmark number (estimates until measured), and the full corpus.
