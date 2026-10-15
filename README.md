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
- R2 verification: an isolated read-only probe Worker (`probe/`) started locally by
  `bun run verify:r2:remote` — native binding, remote R2, no S3 keys, never deployed
- Tests: `bun test` (249 tests, 1099 assertions) — normalization, relevance, CSV/indexer, R2 store,
  end-to-end index + Worker API over a generated index, lead recovery, security, the R2 probe and
  its runner, and the S3 verification scripts over a stub transport

## Documentation

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | components, data flow, canonical model, entity resolution, search, R2 layout, caching |
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
bun run verify:r2:remote  # read-only check of the REAL R2 bucket (no keys, never deploys)
bun run dev               # frontend preview (sample dataset mode unless VITE_API_MODE=worker)
```

The preview ships a clearly-labelled **synthetic sample dataset** so the interface can be
explored without R2. Production behaviour requires `VITE_API_MODE=worker` plus a deployed Worker
(see `docs/configuration.md` and `docs/deployment.md`).

## Indexing your data

```bash
# 1. Put the two real object keys in tools/indexer/indexer.config.json
#    (Mode B: "r2://company-intel-data/raw/<key>.csv", or Mode A: a local path)
bun run index:profile                 # headers, fill rates, mapping suggestions, preflight
# 2. Sample runs first (both source schemas are always represented)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 10000  --version v1-sample-10k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 100000 --version v1-sample-100k
# 3. Full run + upload, then activate (each step is documented in docs/indexing.md)
bun run index:upload
bun run index:validate
bun run index:publish
```

Iterating on search quality or the theme does not require data:
`bun run bench` measures latency, retrieval cost and labelled relevance (recall@1/@5, false
positives) on a synthetic corpus.

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
| Test suite (249 tests, 1099 assertions) | **IMPLEMENTED AND TESTED** — normalization, relevance, CSV parsing, indexer pipeline + R2 streaming sources, R2 store, Access security, end-to-end index build + Worker route handlers, the read-only probe |
| Worker → R2 access path | **IMPLEMENTED AND TESTED** — `tests/worker-r2-binding.test.ts` proves the Worker reaches R2 only through the `COMPANY_DATA` binding, never with S3 secrets, and that the bucket is not published |
| Read-only R2 probe (native binding, no keys) | **IMPLEMENTED AND TESTED locally** — `tests/r2-probe.test.ts`, `tests/r2-probe-schema.test.ts`, `tests/verify-r2-remote-script.test.ts` cover routing, bound clamping, the production refusal, 405 on writes, no write/delete call existing anywhere in the probe, 1 KB/6 MB read budgets, missing-object handling, the schema report and the runner's 0/1/2 exit codes. **Not run against your account** |
| Read-only R2 verification scripts (S3 keys) | **IMPLEMENTED AND TESTED over a stub transport** — bounded 25-object `raw/` listing, size/ETag + 1 KB ranged body read, missing-object and denied-credential exit codes, `--json` reports with no cell values. Real bucket still unread |
| Indexer Mode B (read the CSVs straight from R2) | **IMPLEMENTED AND TESTED over a stubbed S3 transport** — bounded 8 MiB ranged reads, chunk-boundary-safe parsing, Mode A/Mode B parity, disk cache + resume, 404/403/credential failures. Real 60 GB run not started |
| Search engine + ranking | **IMPLEMENTED AND TESTED** — recall@1 0.939 / recall@5 0.97 on the labelled fixture set |
| R2 object layout, manifests, rollback | **IMPLEMENTED, PARTIALLY TESTED** — layout and pointer logic tested; the real R2 path needs a deployed bucket |
| Worker API + R2 reads | **IMPLEMENTED, PARTIALLY TESTED** — routing, validation and Access verified by tests; end-to-end reads require a published dataset |
| Streaming indexer | **IMPLEMENTED AND TESTED on synthetic CSVs** — both schemas, multiline records, cross-file association, shard bounds, checkpoint, upload retries, checksums, atomic publish/rollback. Real 10 GB/50 GB run pending your approval gate |
| Real data in R2 (`raw/`) | **NOT VERIFIED** — measured here: no R2 credentials reach this environment, so nothing has been listed or read. Run `bun scripts/verify-raw.mjs --json` and `bun scripts/profile-raw.mjs --json` on your machine (`docs/r2-connection.md`, `docs/verification.md` → Phase A) |
| Browser-rendered UI | **BLOCKED here** — no browser in this sandbox; manual checklist in `docs/verification.md` → Phase C |
| Cloudflare deployment + Access policy | **NOT STARTED** — manual steps are in `docs/deployment.md`, awaiting your go-ahead |
| Full 60 GB indexing | **BLOCKED (by design)** — requires your explicit approval after the sample benchmarks |
| Cost/performance figures | **MEASURED in the dev sandbox**, to be reconfirmed on your machine and in production (`docs/cost.md`) |

## Manual actions required from you

1. In **your own** terminal, run `bun run verify:r2:remote --json > raw-verification.json` and send
   that file back. It needs **no** R2 credentials — just your Wrangler login — and it holds object
   keys, sizes, ETags, timestamps, headers, fill rates and mapping suggestions, with no secrets and
   no cell values. (The S3-key variant, `bun scripts/verify-raw.mjs` + `bun scripts/profile-raw.mjs`,
   is still available.) Do **not** enter R2 credentials in the provider's Frontend/Backend
   environment panel (see `docs/r2-connection.md`).
2. Copy the two exact object keys from that report into `tools/indexer/indexer.config.json`
   (`r2://company-intel-data/raw/…`, Mode B) and run `bun run index:profile`. Mode B needs the three
   `R2_*` variables in that shell; the least-privilege recipe is in `docs/indexing.md`.
3. Run the sample runs, then approve the full indexing job (approval gate 1) — see `docs/execution-plan.md`.
4. Create the Cloudflare Access application and set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
   `ALLOWED_EMAILS` as Worker secrets (never in chat, never in a file).
5. Approve production deployment and, if the benchmarks show the Free plan's 10 ms CPU ceiling is
   hit on heavy fuzzy queries, decide on Workers Paid (approval gate 2).

Nothing paid or destructive has been performed: no deployment, no full indexing, no bucket
changes, and the original CSVs remain untouched.
