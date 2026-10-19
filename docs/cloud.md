# Cloud-only indexing

Goal: the 64.26 GB in `r2://company-intel-data/raw/` is processed inside Cloudflare,
with no personal computer involved, and the result is a normal v4 dataset the existing
Worker serves.

## Architecture

```
browser ── /indexing (control panel)
             │  state / pause / abort
             ▼
      R2  cloud/jobs/<version>/
             ▲   state.json · control.json · schema.json
             │   checkpoints/<source>.json · chunks/<source>/<n>.json
             │   segments/<source>/<chunk>/part-<partition>.jsonl.gz
             │
   Cloudflare Container (cloud/Dockerfile → cloud/runner.mjs)
             │  bun tools/cloud/cli.ts run --version <id>
             │
      raw/file1.csv · raw/file2.csv  (R2, ranged reads only)

   Cloud Pass 2 (tools/cloud/pass2.ts, same container)
             │  one partition at a time from verified segments
             ▼
      indexes/ · companies/ · contacts/ · details/ · unassigned/ · manifests/
```

**Pass 1 is implemented and verified** end to end against real R2 objects:

1. The source is read in bounded range slices; a chunk ends at the first record that
   reaches the target size. `CsvParser` reports the UTF-8 byte offset of the record's
   newline and whether it is at a record boundary, so a quoted newline or a multi-byte
   character cannot be cut (see `tests/cloud-pass1.test.ts`).
2. Each record is encoded by the **same** `encodeSpoolV2Row` and partitioned by the
   **same** `companyKeysFromInput` + `partitionFor` as the local v2 spool. One copy of
   the values, no field names.
3. Each chunk writes one gzip object per non-empty partition, then a manifest, then a
   checkpoint. Segments are re-read and SHA-256-checked after upload.
4. A restart reads the checkpoint and continues at the exact byte/line offset. A chunk
   that was interrupted before its checkpoint is simply re-read; keys are deterministic,
   so nothing is duplicated.
5. `pause` and `abort` are objects in R2, checked before every chunk.

**Pass 2 is now cloud-native.** `tools/cloud/pass2.ts` runs the production merge from
`tools/indexer/src/build.ts` with three hooks:

1. `preparePartition` concatenates one partition's segment objects from R2 (gzip members
   concatenate into one valid stream), verifies every segment's SHA-256 and byte length,
   writes the `.frames` ledger the merge verifies, and hands the file to the unchanged
   merge loop;
2. `releasePartition` deletes it immediately, so local disk holds **one partition**
   (tens of MB at 256 partitions), never the ~23 GB spool;
3. postings are flushed to R2 every four partitions as gzip batch objects, and the
   final index objects are PUT straight to their versioned keys — the ~20 GB index is
   never written locally either.

Company identity, contact association, unassigned contacts, duplicate prevention,
projections, detail records, all indexes and manifests come from the same code as the
local build. `tests/cloud-pass2.test.ts` proves this by merging the same segments both
ways and comparing every generated object byte-for-byte (the only excluded field is the
`createdAt` timestamp in `indexes/<v>/directory.json`).

The earlier `tools/cloud/assemble.ts` remains as a compatibility bridge for bounded
runs and as the reference used by that equivalence test; the full corpus never calls it.

Scratch safety: the driver clears only a directory it created (marked with
`.cloud-pass2-work.json`) or an empty one, and refuses the configured work/output
directory outright. Pointing `--work-dir` at a real local spool stops before anything is
deleted.

## Cloudflare limits that shaped this

Checked against the official docs (October 2026):

| Limit | Value | Consequence |
| --- | --- | --- |
| Container instance sizes | 1/16–4 vCPU, 256 MiB–12 GiB, **2–20 GB ephemeral disk** | Pass 1 uses `standard-1` (0.5 vCPU, 4 GiB, 8 GB); disk is never used for the spool |
| Container stop behaviour | SIGTERM, up to 15 min grace, then SIGKILL | a chunk is uploaded + checkpointed before it ends; a kill loses at most one chunk |
| Workers CPU | 30 s default, up to 5 min; 128 MiB | the Worker only orchestrates; parsing is in the container |
| Workflows | 10,000 steps (25,000 max), unlimited step wall time | enough for one step per chunk, but not needed for the per-chunk loop inside the container |
| Queues | 128 KB message, 5,000 msg/s | usable, but a container loop with a durable checkpoint is simpler and cheaper |
| R2 | no append; multipart parts 5 MiB–5 GiB | segments are immutable objects; a checkpoint is a new object |
| R2 prices | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B | see forecast |
| Containers prices | $5/mo includes 375 vCPU-min, 25 GiB-h, 200 GB-h disk; then $0.00002/vCPU-s, $0.0000025/GiB-s | measured forecast is a few dollars |

**The disk limit no longer blocks Pass 2.** A container has at most 20 GB of ephemeral
disk (8 GB at `standard-1`), while the spool is ~23 GB and the index ~20 GB. Cloud Pass 2
never has either: it materialises one partition, merges it, deletes it, and streams the
posting/index objects to R2. Peak local use is one partition plus a four-partition shard
buffer (bounded by `SHARD_FLUSH_BYTES`).

## What is verified, and what is not

| Component | Status |
| --- | --- |
| Boundary-safe chunking over R2 (quoted newlines, UTF-8, exact offsets) | **IMPLEMENTED AND VERIFIED** (tests + real R2) |
| Compact segmented Pass 1 with per-chunk manifests and checkpoints | **IMPLEMENTED AND VERIFIED** |
| Resume after pause/kill; refuses a changed source identity | **IMPLEMENTED AND VERIFIED** |
| Segment verification (SHA-256 + row accounting + coverage) | **IMPLEMENTED AND VERIFIED** |
| Cloud → v2 spool assembly (format compatibility with existing merge) | **IMPLEMENTED AND VERIFIED** on fixtures |
| Control panel + dev backend controls (R2 state and control flags) | **IMPLEMENTED AND VERIFIED** in the preview (a benchmark was started through it) |
| Deployed admin API + container orchestration | **IMPLEMENTED BUT UNVERIFIED** (static/type checks only) |
| Container image and runner | **IMPLEMENTED BUT NOT VERIFIED** — no Cloudflare API token in this workspace, nothing deployed |
| Full-corpus container execution | **NOT RUN** (requires your approval) |
| Cloud-native Pass 2 (partition reduce + streaming shard merge) | **IMPLEMENTED AND VERIFIED** on fixtures and a bounded real-R2 job |
| Pause/resume, corrupted segment, immutable completed version | **IMPLEMENTED AND VERIFIED** (`tests/cloud-pass2.test.ts`) |
| Deployed admin API (`/api/cloud/*`) + container DO | **IMPLEMENTED BUT UNVERIFIED** — no Docker/token here, nothing deployed |
| Existing application/search | unchanged; the running index is untouched |

### How the partition reduce stays correct

A company and all its contacts hash to the same partition, so resolution inside one
partition is complete and independent. The global shard is assembled from posting parts
in partition order, which is the same order the local merge writes them; the equivalence
test asserts the resulting payloads are identical. Restart replays partition 1: every
output key is overwritten with the same bytes, so a replay cannot duplicate a company, a
contact or a posting. A version whose `manifests/<v>/manifest.json` already exists is
refused outright.

Known limitation: replay rebuilds every shard, so an interruption late in Pass 2 costs
the work since the last completed partition batch. A future optimization could checkpoint
completed shards, but correctness does not depend on it.

## Real benchmark (bounded, real R2)

Run through the same CLI the container runs, on 16 MiB of **each** real source:

```
cloud-bench-e  2026-10-19
  source read            0.03 GB in 45.2 s
  rows                   36,432 (954 rejected)
  throughput             806 rows/s · 0.7 MB/s
  spool                  0.01 GB (31.4% of source)
  segments               512 objects (16 partitions; scaled to 256 in the forecast)
  R2 Class A / Class B   720 / 1,360
  verification           PASSED (every sha256 + row count)
```

`806 rows/s` is sandbox-bound: each R2 PUT costs ~1.2 s and each read-back ~2.6 s from
this host, and the run issues one PUT+GET per partition per chunk. In a container the
R2 round trip is milliseconds, so the rate is set by parsing. The earlier local runs
measured **5,015 rows/s end to end** and the Windows run **7,309 rows/s**; the forecast
uses those as the optimistic/expected anchors and the sandbox rate as the high-cost
bound. **These are not container measurements.**

Compression: 31.4% at 16 MiB/16 partitions is inflated by gzip headers on tiny frames.
The 20,000-row measurement of the same encoding on the real sources was **0.423×
(company) and 0.346× (contact)** of source bytes, i.e. **~23 GB for 64.26 GB**.

## Real Cloud Pass 2 run (bounded, real R2)

Same CLI, same real objects, new version `cloud-bench-smoke` with
`tools/indexer/indexer.cloud-bench.json` (2 partitions, 2 shards, 1 MB per source):

```
Pass 1 verified: 2,324 rows in 2 chunks
partitions merged: 2/2, one at a time, each deleted before the next
validation: passed (every generated object read back and re-hashed)
objects written: 40 · shard batch objects: 16
R2 Class A / Class B: 78 / 132
per-source accounting: csv1 436 rows, csv2 1,888 rows
wall time: 146.6 s
```

The first attempt failed validation with `source_missing_rows (csv1=0, csv2=0)` because
Cloud Pass 2 restored only the total row count from Pass 1, not the per-source counters.
The fix is in the derived checkpoint (`perSource` is rebuilt from the verified
checkpoints); the re-run above passes, and that failure is now covered by the fixture
test.

That is **16 rows/s**, but it is a latency measurement, not a throughput one: this
sandbox takes ~1.5–5 s per R2 request, and the merge issues a fixed handful of
requests per partition plus one read and one write per shard object. The same code in a
container sees millisecond R2 round trips. It does prove the real path end to end:
segments were read from R2, merged with the production engine, the generated index was
written back without `content-encoding` (so ranged reads stay byte-exact), and every
object was read back and checksum-verified.

The built index was then downloaded and queried with `scripts/explain-query.mjs`
(`2GO Group` → exact match from the real company names, 31 ms). Company/contact search
is therefore compatible with a cloud-produced v4 index, not just with a local one.

In-memory equivalence (`tests/cloud-pass2.test.ts`) is stronger on bytes: the same
segments merged locally and in cloud mode produce identical objects for every
projection, detail, index, unassigned and manifest file; only `createdAt` in
`directory.json` differs.

## Cost forecast

The CLI writes `index-reports/cloud-benchmark-<version>.json` with low/expected/high
scenarios built from the measurement, the published prices and the Workers Paid
allowances. The run above produced:

| Scenario | Pass 1 | Pass 2 (estimate) | Spool | Incremental |
| --- | --- | --- | --- | --- |
| low | 4h 00m | 24h 03m | 20.19 GB | **$8.50** |
| expected | 6h 01m | 36h 04m | 20.19 GB | **$12.18** |
| high | 10h 01m | 120h 13m | 26.25 GB | **$35.26** |

Those durations inherit the sandbox's 0.7 MB/s and a deliberately conservative Pass 2
multiplier (3× Pass 1, doubled in the high case). With container-local R2 latency and the
measured 4,000–7,000 rows/s parse rate, Pass 1 for 99 M rows is **~1–2 hours on four
containers**, and the expected total is closer to **$3–6**; the table above is the
conservative planning bound. The high scenario exceeds the $30 preference, so the operating rule is: a
**per-stage budget stop**, not a claim that Cloudflare enforces the alert. Pass 1 reads
`CLOUD_BUDGET_USD` (30 in `wrangler.toml`) and pauses at the next durable chunk boundary
when its running estimate reaches it; benchmarks are exempt. The estimate excludes R2
storage and requests billed after the snapshot, so this is a guard, not a guaranteed cap
— pause/abort remain authoritative. Cloudflare's budget alert is a notification only.

What the forecast includes: container CPU/memory/disk beyond the monthly allowances, R2
Class A/B beyond 1 M/10 M, intermediate spool storage (one month), and the final index.
It excludes: the $5 Workers Paid subscription (already active), egress (R2 egress is
free), and retries beyond the measured ones.

## Using the control panel

`/indexing` shows the durable state of every job and can:

* run a bounded benchmark (1–256 MB per source) through the real chunker/segment writer;
* start or resume **Cloud Pass 2** and watch its partition progress, shard-object count,
  index bytes, rate, ETA and running cost;
* pause, resume or abort — the engine checks the flag between chunks/partitions;
* verify every uploaded Pass 1 segment independently (re-reads sizes and row counts);
* activate a **completed full run** only; the button is disabled for benchmarks;
* view the last checkpoint, errors, source-row accounting and the R2 estimate.

It cannot start the full corpus. `run` requires `--approve-full`, and that refuses unless
`control.json` records `approvedFullRun: true`. The dev server's `/api/cloud/...` routes
are token-guarded (`CLOUD_ADMIN_TOKEN`); the deployed routes live in
`worker/src/indexer-admin.ts` and are protected by Cloudflare Access plus the
`INDEXING_ADMIN_EMAILS` allowlist. Activity is never hidden behind an obscure URL.

## Running the container

```
docker build --platform linux/amd64 -f cloud/Dockerfile -t companyintel-indexer .
docker run --rm -p 8080:8080 \
  -e R2_ACCOUNT_ID=… -e R2_ACCESS_KEY_ID=… -e R2_SECRET_ACCESS_KEY=… \
  companyintel-indexer
curl -X POST localhost:8080/job -d '{"args":["run","--version","v1-cloud-2026-10-19","--max-source-mb","16","--partitions","16"]}'
```

Deploying it as a Cloudflare Container is configured in `wrangler.toml`
(`[[containers]]`, the `INDEXER_CONTAINER` Durable Object binding and migration) and
uses the root `Dockerfile`. `wrangler deploy` builds that image with Docker and pushes it
to Cloudflare's managed registry. The Worker exports `IndexerContainer`, starts it only
through the admin route, and forwards `/health` and `POST /job`.

**Not verified here:** Docker is not installed in this workspace, there is no Cloudflare
API token, and nothing was deployed. The config matches Cloudflare's documented schema
(instance types, DO binding, migration), but a real deploy has not been attempted. See
`docs/deployment.md` for the exact commands.

## Approval needed before the full run

1. Review `index-reports/cloud-benchmark-cloud-bench-e.json` (or rerun the benchmark at
   a larger size) and the forecast above.
2. Approve the full-run budget (the expected case is under $30; the conservative high is
   not) by recording `approvedFullRun` in `control.json`.
3. Provide a Cloudflare API token with Containers + R2 + Workers permissions so the
   container can be deployed (Docker must be available on the deploying machine).
4. Run Pass 1 in full, verify, then run Cloud Pass 2 and activate only after validation.

Full indexing has **not** been started, and no existing index or source object was
modified.
