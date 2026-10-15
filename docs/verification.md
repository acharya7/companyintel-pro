# Verification report (phases A–F)

What was **executed** in this environment, what it proved, what is **BLOCKED**, and what you
must run on your own machine. Nothing here is inferred from type-checking alone: every claim
names the command or test that produced it.

Run everything below yourself with:

```powershell
bun run check                          # 4 typechecks + 167 tests
bun scripts/benchmark-r2-path.mjs      # R2-backed search path
bun scripts/benchmark-search.mjs       # engine + labelled relevance
bun scripts/verify-raw.mjs             # (needs R2 credentials) real object inventory
bun scripts/profile-raw.mjs --list     # (needs R2 credentials) real object listing + schemas
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

**STATUS: BLOCKED in this environment.** I have no R2 credentials and I will not ask you to
paste them into chat. No object was listed, no byte was read, no schema was reported, and no
claim of verification is made.

What is ready for you — two read-only scripts, neither writes to the bucket. `verify-raw.mjs` is
the inventory/verification script (presence, exact byte size, ETag, and the currently published
dataset/manifest/validation state); `profile-raw.mjs` samples the heads and prints the two schema
reports.

```powershell
# Session-only credentials (never committed, never pasted into chat)
$env:R2_ACCOUNT_ID="<account id>"
$env:R2_ACCESS_KEY_ID="<access key id>"
$env:R2_SECRET_ACCESS_KEY="<secret access key>"

# 1. What actually exists under raw/ — names, sizes, timestamps, readability
bun scripts/profile-raw.mjs --list

# 2. Presence + size + ETag of both originals, plus the active dataset state.
#    Pass the real keys from step 1 — the built-in default names are a placeholder.
#    (`bun run verify:r2` is the same command without --keys.)
bun scripts/verify-raw.mjs --keys raw/<file1>.csv,raw/<file2>.csv

# 3. Read the head of both files with ranged GETs (never the whole file) and
#    print two independent schema reports + a ready-to-paste sources block
bun scripts/profile-raw.mjs
```

`profile-raw.mjs` reads only the first ~6 MB of each object (never the 10/50 GB), cuts the last
partial record so a truncated line cannot distort the profile, writes the samples to
`.raw-samples/`, prints per-file delimiter/encoding/fill-rates/sample values, the canonical field
mapping for **each** file separately, and a ready-to-paste `sources` block.

Without credentials you can still confirm presence with wrangler (no keys in the shell):

```powershell
bunx wrangler r2 object list company-intel-data --prefix raw/
```

The app exposes the same bounded listing as `GET /api/dataset/sources` (≤ 25 objects, `raw/` only)
and renders it on the **Dataset Management** page — a second, independent confirmation once the
Worker is deployed and Access is configured.

### Non-secret outputs I need from you (paste these; they contain no credentials)

1. The `--list` output (object **names**, **sizes**, timestamps).
2. Both schema reports: header line, delimiter, encoding, sampled record count.
3. For each file, the canonical mapping lines and any "unmapped headers" / "canonical fields
   absent" lines.
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
| A. List real `raw/` objects, verify sizes/readability, sample + report both schemas, map to canonical model | Tooling ready, run not executed (no R2 creds here) | `scripts/verify-raw.mjs`, `scripts/profile-raw.mjs` (ranged GETs only) | Real headers may differ from the fixture | Run both scripts locally, send listings + both schema reports |
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
