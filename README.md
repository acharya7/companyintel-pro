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
- Indexing: Windows-compatible streaming indexer in `tools/indexer` (Node/Bun, disk-backed)
- Tests: `bun test` (108 tests) — normalization, relevance, CSV/indexer, worker store, security

## Documentation

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | components, data flow, canonical model, entity resolution, search, R2 layout, caching |
| `docs/configuration.md` | frontend API mode, `wrangler.toml`, Worker secrets, indexer config, R2 credentials |
| `docs/indexing.md` | the profiling → sample → full → validate → publish workflow, preflight, resume, troubleshooting |
| `docs/deployment.md` | beginner step-by-step Cloudflare setup: wrangler, secrets, Access application, deploy, verify, rollback |
| `docs/security.md` | threat model, Access verification, headers, validation, rate limits, deployment checklist, residual risks |
| `docs/cost.md` | documented Cloudflare pricing, storage/operation/CPU estimates, measured benchmarks |
| `docs/recovery.md` | dataset versions, rollback, indexing resume, snapshots, restore procedures, R2 consistency limits |

## Quick start

```powershell
bun install
bun run check        # typechecks (frontend, worker, indexer) + full test suite
bun run dev          # frontend preview (sample dataset mode unless VITE_API_MODE=worker)
```

The preview ships a clearly-labelled **synthetic sample dataset** so the interface can be
explored without R2. Production behaviour requires `VITE_API_MODE=worker` plus a deployed Worker
(see `docs/configuration.md` and `docs/deployment.md`).

## Indexing your data

```powershell
# 1. Point tools/indexer/indexer.config.json at your two CSV files
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

## Verification status

| Area | Status |
| --- | --- |
| Frontend, Worker, indexer typechecks | **IMPLEMENTED AND TESTED** — `bun run check` → 4/4 PASS |
| Test suite (108 tests) | **IMPLEMENTED AND TESTED** — normalization, relevance, CSV parsing, indexer pipeline, R2 store, Access security |
| Search engine + ranking | **IMPLEMENTED AND TESTED** — recall@1 0.939 / recall@5 0.97 on the labelled fixture set |
| R2 object layout, manifests, rollback | **IMPLEMENTED, PARTIALLY TESTED** — layout and pointer logic tested; the real R2 path needs a deployed bucket |
| Worker API + R2 reads | **IMPLEMENTED, PARTIALLY TESTED** — routing, validation and Access verified by tests; end-to-end reads require a published dataset |
| Streaming indexer | **IMPLEMENTED AND TESTED on synthetic CSVs** — real 10 GB/50 GB run pending your approval gate |
| Cloudflare deployment + Access policy | **NOT STARTED** — manual steps are in `docs/deployment.md`, awaiting your go-ahead |
| Full 60 GB indexing | **BLOCKED (by design)** — requires your explicit approval after the sample benchmarks |
| Cost/performance figures | **MEASURED in the dev sandbox**, to be reconfirmed on your machine and in production (`docs/cost.md`) |

## Manual actions required from you

1. Point `tools/indexer/indexer.config.json` at your local CSV paths and run `bun run index:profile`.
2. Approve the full indexing job after the sample runs (approval gate 1).
3. Create the Cloudflare Access application and set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
   `ALLOWED_EMAILS` as Worker secrets (never in chat, never in a file).
4. Approve production deployment and, if the benchmarks show the Free plan's 10 ms CPU ceiling is
   hit on heavy fuzzy queries, decide on Workers Paid (approval gate 2).

Nothing paid or destructive has been performed: no deployment, no full indexing, no bucket
changes, and the original CSVs remain untouched.
