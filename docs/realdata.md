# REAL DATA — live search without a full-corpus index

This document describes the real-data launch: what is active, how a search is
answered, what the coverage numbers mean, and what is deliberately **not** done
yet. It is the operating record for the launch dataset and the bounded source
scanner.

## Status at a glance

| Item | State |
| --- | --- |
| Starter dataset built from **both** original R2 files | **DONE** — `stg-real-2026-10-21` |
| Starter dataset activated (staging pointer, Access-protected host) | **DONE** — `staging/active.json` → `stg-real-2026-10-21` |
| Coverage record (`realdata/<version>/coverage.json`) | **DONE** — 0.1328% of 64.26 GB measured |
| Cloudflare deployment of this code | **PENDING** — see “Deployment” below |
| Bounded direct R2 scan (container command + API + UI) | **IMPLEMENTED**, container route tested; live start awaits the deploy |
| Full 64 GB indexing | **NOT STARTED** (separate authorisation) |

The production pointer (`manifests/active.json`) is untouched. Staging has its own
pointer, its own Worker and its own container instance; nothing here can change the
production dataset.

## The launch dataset

Built by the existing indexer from the original objects, read with ranged requests:

```
version            stg-real-2026-10-21
sources            raw/file1.csv, raw/file2.csv   (read-only)
rows read          59,266  (1,889 rejected by the schema)
companies          30,300
contacts           29,291
association        15,925 high confidence · 13,180 plausible · 186 preserved without an employer
index objects      516 (61.0 MB)
source bytes read  85.4 MB of 64.26 GB  (0.1328%)
```

Both files contribute: `csv1` supplies companies (27,899), `csv2` supplies contacts
and the company names that attach them. Every record is an original row; no
synthetic record can enter this version — the build path is the same one the
benchmark and production use (`tools/indexer`, `tools/cloud/pass2.ts`).

The dataset is **versioned** and activated through the normal validated pointer:

* `manifests/stg-real-2026-10-21/manifest.json` — `validationPassed: true`
* `manifests/stg-real-2026-10-21/validation.json` — every object read back
* `realdata/stg-real-2026-10-21/coverage.json` — measured bytes/records per source
* `staging/active.json` — `{version, previousVersion, activatedAt, label, coveragePercent}`

The staging benchmark `stg-bench-2026-10-21` was **not** modified or activated.

### Why only a prefix?

The workspace has 148 MB of free disk, one CPU and 1 GB RAM; a larger local build
does not fit, and the full corpus is explicitly out of scope for this launch. The
build is a bounded sample (`--sample 30000` records per source) through the real
reader, real mapping and real association code. That is why the UI says **REAL DATA
— PARTIAL COVERAGE** and shows the measured byte coverage, not an estimate.

## How a search is answered

The order is enforced by the UI and the API, not by hope:

| Level | Path | Cost | Where |
| --- | --- | --- | --- |
| 1 | **Cache** — a completed direct-scan result for the same dataset version, kind, normalised query and budget | 1 small R2 GET | `realdata/cache/<version>/<hash>.json` |
| 2 | **Indexed coverage** — the existing sharded index, exact → prefix → token → trigram, bounded hydration, isolate cache | shards + ≤16 profile partition reads | `indexes/…`, `companies/…`, `contacts/…`, `details/…` |
| 3 | **Direct R2 scan** — a background container job reads ranged slices of the original files | ≤ 48 MB per source, once per explicit click | `raw/file1.csv`, `raw/file2.csv` |

A new query never triggers a scan automatically. The scan starts only from the
**Scan source files** button (or `POST /api/realdata/scan`), and its budget is capped
by `REALDATA_SCAN_MAX_MB` (48 in both Wrangler configs).

### Direct scan properties

`tools/realdata/scan.ts`, run by the container as:

```
bun tools/cloud/cli.ts scan --version scan-<id> --query "…" --kind both \
  --max-mb 48 --limit 50 --dataset-version stg-real-2026-10-21
```

* **Ranged streaming.** 8 MiB `Range` GETs, the same `CsvParser` as the indexer, so
  quoted newlines, tabs, UTF-8 boundaries and the header row are handled exactly;
  the header is re-read to build the field mapping rather than assumed.
* **Never in a Worker request.** The Worker validates, writes `request.json`, starts
  the container detached and returns `202`. Results are written progressively to
  `realdata/scans/<id>/status.json` and `results.json`.
* **Committed record boundaries.** `bytesScanned` is only ever the end of a complete
  record, so a stop or restart continues from there — never from zero, never
  mid-record. The one allowed overshoot is the record that crosses the budget
  (≤ 256 KiB).
* **Honest completion.** `complete` means “the requested scan scope was processed”,
  with `bytesScanned`, `bytesTotal` and `coveragePercent` attached. The UI never
  renders “not found” from a bounded scan; it says how many bytes were read and how
  much source remains outside the scan.
* **Cancellation** is a durable `cancel.json` checked between windows; the job keeps
  what it already found and marks itself `cancelled`.
* **Dedupe** by normalised name **and domain** for companies (so “Acme Corporation”
  and “Acme, Inc.” stay separate records) and by email → LinkedIn → name+employer
  for contacts. The result limit is explicit (`truncated` + `dropped`).
* **Matching** is exact, case-insensitive, prefix, token and bounded edit distance
  (`editBudgetFor`), so a first-letter typo still finds a record; names are
  deaccented for the search (`José` matches `Jose`).
* **Keep-alive** writes the same `cloud/jobs/<id>/{state,run}.json` heartbeat the
  Durable Object already watches, so the existing alarm resumes a stopped scan from
  its committed offsets.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/realdata/coverage` | active version, counts, measured coverage, scan availability/budget |
| `POST /api/realdata/scan` | start or reuse a bounded scan (`{q, kind?, maxMb?, force?}`) |
| `GET /api/realdata/scan/:jobId` | status, progressive results, cache hit; writes the cache on first completion |
| `POST /api/realdata/scan/:jobId/cancel` | durable cancel flag |

All four sit behind the app-wide Cloudflare Access verification, same-origin rule and
rate limit. A job records its owner; another identity gets `403`. A deterministic job
id (dataset version + kind + normalised query + budget) makes a double click a
reuse, and one live scan per account is enforced with
`realdata/scans/active/<email-hash>.json`.

## Refreshing or extending the starter data

```bash
# 1. Build another bounded version from both real sources (resumable, no raw/ writes)
bun tools/indexer/src/cli.ts run \
  --config tools/indexer/indexer.early-access.json \
  --sample 30000 --version stg-real-2026-10-22 \
  --work-dir .realdata-work --disk-floor 128

# 2. Measure the exact prefix each source contributed
bun scripts/early-access.mjs measure --version stg-real-2026-10-22 \
  --rows csv1=30000,csv2=30000 --out .realdata-output/coverage.json

# 3. Publish (resumable, concurrent, manifest last, refuses to overwrite)
bun scripts/early-access.mjs publish --dir .realdata-output --version stg-real-2026-10-22

# 4. Read every object back, then activate the staging pointer
bun scripts/early-access.mjs verify  --dir .realdata-output --version stg-real-2026-10-22
bun scripts/early-access.mjs activate --dir .realdata-output --version stg-real-2026-10-22
```

Activation refuses unless the manifest says `validationPassed`, the validation object
has no missing objects, every listed object exists at the recorded size, and the
coverage record matches the version. A dataset version change also invalidates the
scan cache automatically (the key includes the version).

## Cost and limits

Measured on this workspace (real R2):

| Operation | Measured | Cost |
| --- | --- | --- |
| Starter build (59,266 rows, both sources) | 52 s, 0.11 GB read, 516 objects / 61 MB written | well under $0.01 of R2 operations |
| Publisher (516 objects + coverage + manifest) | one call, 61 MB uploaded | < $0.01 |
| One direct scan at the 48 MB/source budget | ~96 MB read, a few container seconds | ≈ $0.00004 R2 GETs + container time (fractions of a cent) |
| Indexed search | shards + ≤16 partitions per query | fractions of a cent; repeat reads hit the isolate cache |

There is no request path that can read more than `REALDATA_SCAN_MAX_MB` per source
per scan, and no automatic scan per query. The full-corpus run remains the only
material expense and is still not started.

## Deployment

The code, the dataset and the activation are in place. Publishing this workspace to
GitHub is performed by Vly (git commands are blocked in this environment), and
Cloudflare Workers Builds then runs:

```
bun install --frozen-lockfile && bun run verify && bun run build
bun scripts/deploy.mjs staging      # wrangler deploy -c wrangler.staging.toml --keep-vars
```

`wrangler whoami` reports **not authenticated** here and no Cloudflare API token is
available, so the deploy and the post-deploy checks cannot be performed from this
workspace. The staging host is also behind Cloudflare Access, which returns 302 to
the login page for an unauthenticated probe. After the build, the first check is:

```
GET https://companyintel-staging.acharya-priyank7.workers.dev/api/realdata/coverage
```

after signing in through Access. It should answer
`{"dataOrigin":"r2","version":"stg-real-2026-10-21","partial":true,…}` with the
counts above. The seven existing runtime settings and `--keep-vars` behaviour are
unchanged; `REALDATA_SCAN_MAX_MB` was added as an eighth var with a code default, so
an older deployment still behaves conservatively (48 MB) if the var is absent.

## What is deliberately not implemented

* **Full-corpus indexing** — not started; requires the separate authorisation and
  the measured forecast in `docs/cost.md`.
* **Merging scan finds into the index** — a scan caches its verified result per
  dataset version and shows it with full provenance, but it does not rewrite the
  activated index. Incremental index merge is a full-indexing concern; the UI/API
  contract (`coverage.partial`, versioned cache) already supports the transition.
* **A “first two letters” browse index** — the design and measured trade-offs are in
  `docs/two-letter-design.md`; it is not needed for this launch and was not added to
  the working search path.
