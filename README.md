# CompanyIntel

Private B2B company intelligence, contact discovery and lead management.

Search a large private company/contact database with typo tolerance, open a company to see its
contacts, save leads and searches, and export clean prospect lists.

**Runtime: Cloudflare Workers. Persistent cloud storage: Cloudflare R2 (only).**
No Convex, no SQL database, no KV/D1/Durable Objects, no Redis, no search server, no VPS.

- Frontend: React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui, TanStack Query, IndexedDB,
  Recharts, Framer Motion
- Backend: Cloudflare Worker (Hono), Zod-validated REST API, Workers Static Assets, R2 binding
  `COMPANY_DATA` → `company-intel-data`
- Access: Cloudflare Access JWT verification on every `/api/*` route (single approved identity)
- Indexing: streaming indexer in `tools/indexer` (Node/Bun, disk-backed) with two input modes:
  local CSV files, or `r2://company-intel-data/raw/…` objects streamed in bounded ranged reads
- R2 verification: four read-only tools — `bun run r2:doctor` (credentials + one signed LIST),
  `bun run r2:schema` (both files profiled), `bun run verify:r2` (inventory/sizes/ETags/dataset
  state) and an isolated read-only probe Worker (`probe/`, `bun run verify:r2:remote`) that needs no
  S3 keys at all and is never deployed
- Fixed server-side credentials: one private, git-ignored `.r2-credentials.json` (mode 600) read
  automatically by the indexer and the verification scripts — never by the browser bundle or the
  deployed Worker, which uses the `COMPANY_DATA` binding
- Association: company identity resolution and contact association are **two stages** — a
  contact is attached to a company only on evidence (row identity, email domain, country), never
  on a name match alone; ambiguous contacts are preserved under the name they claimed instead of
  being shown as employees (`docs/association.md`)
- Tests: `bun test` (479 tests, 0 fail) — normalization, relevance, prototype-chain safety,
  CSV/indexer, R2 store, end-to-end index + Worker API over a generated index, the bounded
  hydration funnel, two-stage association (identity ownership, reassignment, preservation,
  dedupe, reconciliation), the association audit, the isolated Pass 2 rebuild from an existing
  spool, lead recovery, security, the R2 probe and its runner, and the S3 verification scripts
  over a stub transport

## Documentation

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | components, data flow, canonical model, entity resolution, search, R2 layout, caching |
| `docs/association.md` | company identity rules, the contact-association evidence hierarchy and categories, preservation of unresolved contacts, format v3, the isolated Pass 2 rebuild from the existing spool, the audit |
| `docs/configuration.md` | frontend API mode, `wrangler.toml`, Worker secrets, indexer config, R2 credentials |
| `docs/r2-connection.md` | how R2 access really works (binding vs. S3 keys), the one-command read-only probe, what the Freebuff env panel can and cannot do, macOS commands, the S3-key fallback |
| `docs/indexing.md` | input Mode A/B, profiling → sample → full → validate → publish, preflight, cache/resume, credentials, estimated costs, troubleshooting |
| `docs/deployment.md` | beginner step-by-step Cloudflare setup: wrangler, secrets, Access application, deploy, verify, rollback |
| `docs/security.md` | threat model, Access verification, headers, validation, rate limits, deployment checklist, residual risks |
| `docs/cost.md` | documented Cloudflare pricing, storage/operation/CPU estimates, measured benchmarks |
| `docs/recovery.md` | dataset versions, rollback, indexing resume, snapshots, restore procedures, R2 consistency limits |
| `docs/verification.md` | phase-by-phase verification report: what was executed here, what is BLOCKED, defects found and fixed, manual browser/Access checklist |
| `docs/execution-plan.md` | the full-indexing plan: sources, mappings, commands, RAM/disk/duration/size/cost, checkpoint config, validation steps, approval gate |

## Quick start

```bash
bun install
bun run check             # typechecks (frontend, worker, indexer, probe) + full test suite
bun run bench:hydration   # completeness vs R2 cost of the search hydration budget (real-data sample)
bun run index:bench-assoc # association cost on an adversarial shared-name family (synthetic)
bun run r2:doctor         # credentials file + endpoint + one signed LIST of the real raw/ prefix
bun run r2:schema         # both real source files: encoding, delimiter, columns, mapping
bun run verify:r2         # inventory, sizes, ETags, bounded body reads, dataset state
bun run verify:r2:remote  # the same ground truth through the Worker binding (no keys, never deploys)
bun run dev               # frontend preview (sample dataset mode unless VITE_API_MODE=worker)
```

The preview ships a clearly-labelled **synthetic sample dataset** so the interface can be
explored without R2. Production behaviour requires `VITE_API_MODE=worker` plus a deployed Worker
(see `docs/configuration.md` and `docs/deployment.md`).

## Indexing your data

`tools/indexer/indexer.config.json` is already pointed at the real objects and carries the mapping
decisions (both files are **TAB separated**: `raw/file1.csv` = 10.22 GB of organizations,
`raw/file2.csv` = 54.04 GB of people).

```bash
bun run index:profile                 # preflight over the real objects + mapping + estimates
# Sample runs first (the limit applies per source, so both schemas are represented)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 20000   --version v1-dry5-250
# The 1 M-record readiness benchmark: prepared, NOT run automatically (see docs/indexing.md)
bun run index:benchmark-1m
# New version from that FINISHED spool without re-reading the sources (experimental, isolated:
# no upload, no publish, never touches the spool or v1-bench-1m)
bun run index:benchmark-1m-assoc
# After ANY failure: read-only spool diagnosis — partition/line/byte offsets, never records
bun run index:spool-doctor
# Association audit of an existing index: stored categories vs. the audit's own classification,
# preserved contacts, moved contacts, count/facet reconciliation (read-only, no credentials)
bun run index:audit -- --version v1-bench-1m
# Pass-2 (merge) timing and file-handle load, on this machine, without the real corpus
bun run index:bench-pass2 --fs-count
# Full run + upload, then activate (each step is documented in docs/indexing.md)
bun run index:upload
bun run index:validate
bun run index:publish
```

Iterating on search quality or the theme does not require data:
`bun run bench` measures latency, retrieval cost and labelled relevance (recall@1/@5, false
positives) on a synthetic corpus, and `bun run bench:hydration` measures what the per-search
hydration budget costs in rows lost vs. bytes read against the real-data sample index.

The 1 M-record benchmark checks its prerequisites first and writes nothing until they hold:
`bun run index:benchmark-1m:preflight` verifies R2 credentials, both object keys, the TSV mapping
and free disk/memory, then stops; its estimate itemises the spool, the Mode B staging file, the
index and bookkeeping (1.87 GB → 5.31 GB for the 1 M sample after the first real run showed the old
figure was too low). `workDir/checkpoint.json` records the run it belongs to and
`workDir/spool-manifest.json` records which partitions pass 1 actually finished, so a resumed run
never merges a spool from another run or a partition that was never completed —
`bun run index:spool-doctor` reports exactly what a failed run left behind (positions only, never
records). An **interrupted pass 2** reuses that spool without reading the sources again, resets only
its own partial output and temporary postings, and replays the merge from partition 1: no
`--no-resume`, no pass-1 rebuild. See `docs/indexing.md` → "The 1 M real-data failure" and
"The interrupted Pass 2".

Changing only the **output version** (a new Pass 2 over the same rows) is a separate, explicit
command: `pass2-from-spool`. It validates the recorded source checkpoint, the complete spool
manifest, the source configuration/sample limit/partition count and every partition's length and
SHA-256, then writes a new version into isolated work/output directories. The source checkpoint,
manifest, partitions, generated index and `manifests/active.json` are never written; ordinary
resume keeps its strict, version-inclusive identity check. `--no-resume` is the wrong tool for this
(it clears the spool). See `docs/association.md` §7 and `docs/indexing.md` → "Rebuilding Pass 2
under a different version".

Before any of that, Phase A verifies what is really in R2 — read-only, bounded, both source files
untouched (`docs/r2-connection.md`). The recommended path needs **no credentials at all**: it uses
your Wrangler login and the same native `COMPANY_DATA` binding the deployed app uses.

```bash
bun run verify:r2:remote            # starts a local read-only probe, prints the report, stops it
bun run verify:r2:remote --json > raw-verification.json
bun run verify:r2:remote --keys raw/<file1>.csv,raw/<file2>.csv
```

It lists `raw/` under a bound, confirms both source objects by name with real sizes/ETags and a
**1 KB** body read, samples **6 MB** per source for a schema report (encoding, delimiter, headers,
fill rates, mapping suggestions with confidence), reports the published-dataset state, and never
includes a cell value. Exit codes: 0 verified, 1 a problem, 2 the probe would not start.
The equivalent S3-key path remains available: `bun scripts/verify-raw.mjs[--json]` and
`bun scripts/profile-raw.mjs[--list|--json]`.

## Verification status

| Area | Status |
| --- | --- |
| Frontend, Worker, indexer, probe typechecks | **IMPLEMENTED AND TESTED** — `bun run check` → 5/5 PASS |
| Test suite (479 tests, 0 fail) | **IMPLEMENTED AND TESTED** — normalization, prototype-chain safety, relevance, CSV parsing, indexer pipeline + R2 streaming sources, R2 store, Access security, end-to-end index build + Worker route handlers, the bounded hydration funnel (including checkpoint provenance), the read-only probe, the newline-safe JSONL codec (U+2028/U+2029, truncation, chunk boundaries, CRLF), spool-manifest integrity, the read-only spool doctor, and the isolated Pass 2 rebuild from an existing spool (identity separation, isolation, corruption, byte-identical originals, mid-merge restart) |
| Build and bundles | **IMPLEMENTED AND TESTED** — `bun run build` exits 0 and the `dist/` scan finds no server identifier; `wrangler deploy --dry-run` bundles the Worker (737 KiB) and the probe (39 KiB) with the expected bindings and `workers_dev = false` |
| Worker → R2 access path | **IMPLEMENTED AND TESTED** — `tests/worker-r2-binding.test.ts` proves the Worker reaches R2 only through the `COMPANY_DATA` binding, never with S3 secrets, and that the bucket is not published |
| Read-only R2 probe (native binding, no keys) | **IMPLEMENTED AND TESTED locally** — `tests/r2-probe.test.ts`, `tests/r2-probe-schema.test.ts`, `tests/verify-r2-remote-script.test.ts` cover routing, bound clamping, the production refusal, 405 on writes, no write/delete call existing anywhere in the probe, 1 KB/6 MB read budgets, missing-object handling, the schema report and the runner's 0/1/2 exit codes. **Not run against your account** |
| Read-only R2 verification scripts (S3 keys) | **VERIFIED ON THE REAL BUCKET** (`r2:doctor`, `r2:schema`, `verify:r2`, `index:profile`) — plus the stub-transport tests: bounded 25-object `raw/` listing, size/ETag + 1 KB ranged body read, missing-object and denied-credential exit codes, `--json` reports with no cell values |
| Indexer Mode B (read the CSVs straight from R2) | **VERIFIED ON THE REAL OBJECTS, BOUNDED** — a 20,000-records-per-source dry run (39,505 rows, 1,826 objects, validation passed, nothing uploaded or published); full 64.26 GB run not started (needs your approval) |
| Company ↔ contact association | **IMPLEMENTED AND TESTED on synthetic fixtures with the real code paths** — identifier ownership is first-owner-wins (a later row can never take a domain from the record that carried it first), resolution and association are separate stages, and every contact is either attached with a stored category or preserved in `unassigned/` under the name it claimed. **Not yet measured on the real benchmark** — this environment has no access to the Windows spool; the PowerShell verification is in `docs/association.md` §7 |
| Search engine + ranking | **IMPLEMENTED AND TESTED** — recall@1 0.939 / recall@5 0.97 on the labelled fixture set |
| R2 object layout, manifests, rollback | **IMPLEMENTED, PARTIALLY TESTED** — layout and pointer logic tested; the real R2 path needs a deployed bucket |
| Worker API + R2 reads | **IMPLEMENTED, PARTIALLY TESTED** — routing, validation and Access verified by tests; end-to-end reads require a published dataset |
| Streaming indexer | **IMPLEMENTED, TESTED on synthetic CSVs and RUN against real data** — both schemas, multiline records, cross-file association, shard bounds, checkpoint + spool manifest, restart-safe pass 2, upload retries, checksums, atomic publish/rollback. Two defects were found by real runs: `JSON Parse error: Unterminated string` (U+2028/U+2029 were line terminators to the old reader) and an unsafe/slow interrupted pass 2 (postings appended on replay; one async stream per posting over 1,792 shard files — measured 550,958 stream lifecycles for ≈1.15 M postings, now 5,376 appends). Both are fixed and regression-tested; the 1 M re-run plus the real 64.26 GB run are pending your approval gate |
| Real data in R2 (`raw/`) | **VERIFIED** — `raw/file1.csv` 10,223,471,749 B and `raw/file2.csv` 54,038,527,871 B listed, HEADed and read with signed ranged GETs; schemas profiled per file; no published dataset. Results: `docs/verification.md` → Phase A |
| Browser-rendered UI | **BLOCKED here** — no browser in this sandbox; manual checklist in `docs/verification.md` → Phase C |
| Cloudflare deployment + Access policy | **NOT STARTED** — manual steps are in `docs/deployment.md`, awaiting your go-ahead. `workers_dev = false` is already set in `wrangler.toml`, so add your custom-domain route before deploying |
| Full 60 GB indexing | **BLOCKED (by design)** — requires your explicit approval after the sample benchmarks |
| Cost/performance figures | **MEASURED against the real-data sample index** on a 1-vCPU sandbox: 0.02–0.24 s and ≤ 2.07 MB per query locally, which is above a Workers Free CPU budget — see `docs/verification.md` → Phase E and `docs/cost.md` |

## Manual actions required from you

1. **Recreate the private credentials file on your own machine** — it is git-ignored, so it was
   never pushed: `<repo>/.r2-credentials.json` with `endpoint`, `accountId`, `accessKeyId`,
   `secretAccessKey`, `bucket: "company-intel-data"`, `region: "auto"`, `rawPrefix: "raw/"`, then
   `chmod 600 .r2-credentials.json` and `bun run r2:doctor` to prove it. Schema:
   `docs/configuration.md` §5.
2. **Approve the 1,000,000-record sample** (`--sample 1000000`), then the full 64.26 GB run
   (`bun run index:upload`), then `bun run index:validate` and `bun run index:publish`
   (approval gate 1) — see `docs/execution-plan.md` and `docs/indexing.md`.
3. Create the Cloudflare Access application for your custom domain and set
   `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS` as Worker secrets (never in chat,
   never in a tracked file), then add the `[routes]` entry to `wrangler.toml`.
4. Approve production deployment, and decide Workers Free vs Paid: the real-data benchmark puts a
   query at 0.1–0.24 s of local CPU and ~2 MB of index, so the Free plan's 10 ms ceiling is not
   realistic for this workload (approval gate 2).

Nothing paid or destructive has been performed: no deployment, no full indexing, no bucket
changes, and the original CSVs remain untouched.
