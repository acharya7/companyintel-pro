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
             ▲   state.json · control.json · schema.json · run.json (heartbeat)
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
   so nothing is duplicated. A separate `bun tools/cloud/cli.ts interrupt` command lets the
   container record a stop it observed but the CLI could not. See "Keep-alive,
   interruption and resume" below.
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
| Deployed admin API + container orchestration | **DEPLOYED TO STAGING** through Workers Builds (the panel lists `stg-bench-2026-10-21`); the Resume/Pass 2 behaviour is regression-tested and proven against live R2 checkpoints |
| Container image and runner | **DEPLOYED**; the runner started a real bounded job (`stg-container-fix-20261021-80887`) that wrote 9,676 rows to the live bucket |
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

Restart is now checkpointed, not blind:

* `cloud/jobs/<version>/pass2/checkpoint.json` is written after every merged partition;
* when the merge finishes, the same object records `mergeComplete: true` plus everything
  the finalize phase needs (counters, stats, partition indices, the object list);
* a restart after that point **verifies the posting shard parts exist in R2** (count and
  total bytes) and then rebuilds only the index shards, manifests and validation — the
  merge is not repeated;
* a restart *during* the merge still replays from partition 1, because document refs are
  assigned sequentially across partitions and a partial replay would produce a different
  index. The checkpoint makes the cost visible and bounds the loss to the finalize tail.

The phases after the merge are observable and resumable in their own right:

* `state.pass2.phase` is `merge`, `finalize`, `validate` or `complete`, with
  `finalizeDone/finalizeTotal` (shards processed) and `validationDone/validationTotal`
  (objects read back). That is what the panel renders instead of a merge-era ETA;
* the same progress is written into `pass2/checkpoint.json` (which keeps the merge
  snapshot), so a stop during finalize restarts at finalize;
* finalize and validation **heartbeat** `run.json` (at most one write every 15 s), which
  is the only proof of life the Durable Object keep-alive has between partitions;
* empty shards write **no object** (a local run already skipped them, and the reader
  treats a missing shard as empty). A 2,816-shard layout used to upload 2,816 objects,
  most of them `{"terms":{}}`;
* shard parts are listed **once per kind** instead of once per shard, four shards are
  built concurrently, and validation reads eight objects at a time. The checks are
  identical; only the wall-clock time changes (a live finalize measured ~0.27 shards/s
  with the old sequential, one-LIST-per-shard path).

Only one output shard is serialised at a time, and it is streamed rather than stringified
whole (`shardJsonParts` → incremental gzip): peak memory is the largest single term plus
compressor state, not the payload plus two full copies of it. The measured worst case and
its arithmetic are in `docs/staging.md` §7.

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
conservative planning bound. The high scenario exceeds the $30 preference, so the operating rule is one **combined
budget for the whole job**, not a claim that Cloudflare enforces the alert. Both stages
read `CLOUD_JOB_BUDGET_USD` (30 in `wrangler.toml`, 5 on staging; the old
`CLOUD_BUDGET_USD` name is still accepted as a deprecated alias) and compare it with
`accounting.estimatedUsd + accounting.containerUsd` — R2 requests **and** measured
container seconds, from Pass 1 and Pass 2 together. Pass 1 stops at the next chunk
boundary, Pass 2 at the next partition boundary, and both leave a resumable checkpoint.
Benchmarks are exempt. The estimate excludes R2 storage and any request Cloudflare bills
after the snapshot, so this is a guard, not a guaranteed cap — pause/abort remain
authoritative and are one click in `/indexing`. Cloudflare's budget alert is a
notification only.

What the forecast includes: container CPU/memory/disk beyond the monthly allowances, R2
Class A/B beyond 1 M/10 M, intermediate spool storage (one month), and the final index.
It excludes: the $5 Workers Paid subscription (already active), egress (R2 egress is
free), and retries beyond the measured ones.

## Using the control panel

`/indexing` shows the durable state of every job and can:

* run a bounded benchmark (1–256 MB per source) through the real chunker/segment writer;
* start or resume **Cloud Pass 2** and watch its partition progress, shard-object count,
  index bytes, rate, ETA and running cost;
* pause or abort — the engine checks the flag between chunks/partitions;
* **resume** — an action, not just a flag: see below;
* verify every uploaded Pass 1 segment independently (re-reads sizes and row counts);
* activate a **completed full run** only; the button is disabled for benchmarks;
* view the last checkpoint, errors, source-row accounting and the R2 estimate.

### What Resume actually does

Clearing `pause` only helps a process that is still alive, and a detached job has no
process once its container stopped. `POST /api/cloud/jobs/<version>/control` with
`{"action":"resume"}` therefore restarts work from durable state:

1. **No duplicate runner.** A `run.json` heartbeat younger than 2 minutes answers
   `200 {started:false, alreadyRunning:true}`. The runner's own `409 job_already_running`
   is reported the same way, and `/start`, `/pass2` and `/jobs/benchmark` answer
   `409 job_already_running` while a run is live.
2. **The command is rebuilt, never guessed.** `state.json` → `config` records the stage,
   partition count, bounded limit and chunk size written when Pass 1 started.
3. **A pre-upgrade job is proven, not assumed.** A job started before `config` existed
   has no saved execution metadata. Its limit is recovered from R2 only when the
   checkpoint proves it: an operator stop, a signal or a crash is honoured at a chunk
   boundary, so `nextOffset === chunks * chunkBytes`; a run that ended on its per-source
   limit leaves a **partial** last chunk just past `maxSourceMb * MiB`. Rounding that
   offset down to the nearest MiB recovers the bound (16 MiB for
   `stg-bench-2026-10-21`), and only ever a bound no larger than the original.
4. **A reached limit is reconciled.** When every source is at its bound, the Worker
   publishes the checkpoints' progress, records `config`, sets `coverage: "bounded"`
   and marks `pass1-complete` — then starts bounded **Pass 2** (`--allow-bounded`, the
   recorded 16 partitions) in the same click. Pass 2 re-verifies every chunk manifest
   and segment size before it writes anything.
5. **An unknown limit is refused, not invented.** If the job stopped at a whole chunk
   boundary its original limit is genuinely unknown; the resume answers
   `400 benchmark_limit_unknown` and names the two actions that continue it at a known
   limit: `{"action":"resume","maxSourceMb":16}` (recorded in `config` for next time) or
   a bounded benchmark for the same version. It is never resumed as a full-corpus run,
   and staging refuses a full job outright.

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

### Container entrypoint contract

`cloud/runner.mjs` is the image's `CMD`. Its paths are fixed, not relative to a caller:

| | Value |
| --- | --- |
| Image working directory | `/app` (`WORKDIR` in both Dockerfiles) |
| Runner | `/app/cloud/runner.mjs` |
| Project root | `/app` — the **parent** of the runner's directory |
| CLI | `/app/tools/cloud/cli.ts`, spawned with `cwd: /app` |

The root is derived with `dirname(fileURLToPath(import.meta.url))` + `..`. It must never be
the runner's own directory: doing that produced `/app/cloud`, so `bun tools/cloud/cli.ts`
became `/app/cloud/tools/cloud/cli.ts`, the child exited instantly with "Could not find
module", and the runner still answered `202` — the job never started and R2 stayed empty.

`GET /health` reports the resolved `root`, the absolute `cli` path and `cliPresent`. It
answers **503** when the CLI is missing, so a broken image is visible instead of accepting
work. `POST /job` refuses to start when the CLI is missing (`503 cli_missing`) or when
another job is running (`409 job_already_running`).

A detached start answers `202` only if the child is still alive after a short settle
window (1.5 s). A child that fails sooner is `500 job_failed_to_start`, with its exit code
and the tail of its stderr; a command that exits 0 inside the window is
`200 {started:false, completed:true}`. Those become a `503`/`502` on the admin route with
the same code — never a false success.

The Durable Object waits for `/health` to answer 200 before proxying (`CONTAINER_READY_TIMEOUT_MS`,
default 60 s) and answers `503 container_not_ready` with the last probe error instead of a
bare 502 during a cold start.

### Keep-alive, interruption and resume

A detached job is a grandchild of the container's main process, and Cloudflare stops a
container once its Durable Object has been inactive for the inactivity timeout — sending
SIGTERM to the **main process only**. That combination is why the first live staging run
stopped after csv2's first chunk: the Worker had answered `202`, the DO went idle, the
instance was stopped, and nothing in R2 recorded it.

| Piece | What it does |
| --- | --- |
| `ctx.container.setInactivityTimeout()` | Set when `/job` is accepted (default 1 h, max 6 h, `CONTAINER_JOB_INACTIVITY_MS`) and restored in the DO constructor if the container is already running. |
| DO alarm (`CONTAINER_KEEPALIVE_MS`, default 10 min) | Each firing is DO activity: it renews the timeout **only** while the runner's `/health` reports `job.running`, then re-arms. A finished job stops renewing, so it stops costing container time. |
| Automatic resume | When the durable state says the attempt stopped — `run.json` is `failed`/`interrupted`/`terminated`, a `running` heartbeat is older than `CONTAINER_STALL_MS` (default 15 min, longer than one 128 MiB chunk at the measured rate), or `state.json` is `failed`/`paused` — the alarm restarts the container and re-issues the **recorded** arguments, detached. It never overrides `control.pause`/`control.abort` or a full run that reached `CLOUD_JOB_BUDGET_USD`, and it is bounded to `CONTAINER_MAX_RESUMES` (default 5) with 1/5/15/30/60 min backoff. `CONTAINER_AUTO_RESUME=false` disables it. |
| Continuity | The job record (version, stage, args, attempts) lives in Durable Object storage and is re-armed in the constructor, so a rollout restarts neither the counter nor the wake-up. A 409 from the runner means the CLI is already working, so the alarm simply re-arms. |
| Runner signal handling | SIGTERM/SIGINT is forwarded to the detached child, which stops at the next chunk boundary (`JOB_STOP_GRACE_MS`, 90 s). If it does not exit, it is ended forcibly and the stop is recorded as `terminated`. |
| `cloud/jobs/<version>/run.json` | One object per attempt: `running` with a heartbeat after every committed chunk/partition, then `completed`, `failed`, `interrupted` or `terminated` with a reason, pid, exit code and signal. Written by the CLI; the runner fills it in when the CLI could not. |
| `bun tools/cloud/cli.ts interrupt --version <v> --reason <text>` | Idempotent writer used by the runner on a stop or a non-zero child exit. It publishes the durable checkpoints' progress into `state.json`, appends the reason to `errors[]`, sets `interruption` and leaves the job `paused` so it can be resumed — it never relabels a finished job. |

`state.json` is written after each checkpoint, so a process stopped in that window could leave
the state one chunk behind. The engine now publishes each checkpoint's progress into the
state before reading on, and `interrupt` reconciles from checkpoints — progress only ever
moves forward, and a resume never re-reads a committed chunk (segment keys are
deterministic).

`GET /api/cloud/jobs` lists job directories with R2's `/` delimiter, so a job with thousands
of segments is found in one delimited listing (bounded to 5 pages / 25 rendered jobs, with
`truncated: true`). Each entry carries `state`, `control`, `run` and a `warning`:
`stale` when an in-flight stage has had no heartbeat for 3 minutes, or the explicit
`failed` / `interrupted` / `terminated` reason. The panel renders that warning — a stopped
Pass 1 can no longer look like a slow one.

Deploying it as a Cloudflare Container is configured in `wrangler.toml`
(`[[containers]]`, the `INDEXER_CONTAINER` Durable Object binding and migration) and
uses the root `Dockerfile`. `wrangler deploy` builds that image with Docker and pushes it
to Cloudflare's managed registry. The Worker exports `IndexerContainer`, starts it only
through the admin route, and forwards `/health` and `POST /job`.

Both images pin `oven/bun:1.4.3-slim`. `bun.lock` is lockfile format 2, and the previous
`oven/bun:1.2-slim` image (Bun 1.2.23) refused it during the Container build with
`Unknown lockfile version`. Keep the image on the Bun line the repository is tested with;
`bun install --frozen-lockfile --production` is the only install the image performs.

**Verified against real R2 without Docker:** the runner was started from the repository in
the same relative layout as the image (`root/cloud/runner.mjs` + `root/tools/…`), given a
bounded `benchmark --max-source-mb 4 --partitions 8` job through `POST /job`, and it wrote
to the live bucket: `cloud/jobs/stg-container-fix-20261021-80887/state.json`
(9,676 rows read, 16 segments) plus `checkpoints/csv1.json` and `checkpoints/csv2.json`
(4,194,594 / 4,194,487 bytes consumed). `bun tools/cloud/cli.ts verify --version …`
returned **PASS** for every segment checksum and row count. That proves the entrypoint,
paths and R2 writes the image depends on, not that Cloudflare's runtime executed it.

**How it is deployed:** Workers Builds builds the image and deploys the Worker from
`acharya7/companyintel-pro` (deploy command `bunx wrangler deploy -c wrangler.staging.toml
--keep-vars`), so a change is live only after it is published to that repository. This
workspace cannot run `git` (Vly owns version control) and has no Cloudflare API token, so
a deploy from here is impossible; the deployed staging Worker is what served the panel
that lists `stg-bench-2026-10-21`. See `docs/deployment.md` for the exact commands and
`docs/staging.md` for the isolated staging Worker (`wrangler.staging.toml`) and the
benchmark plan.

## Approval needed before the full run

0. Run the staging benchmark first (`docs/staging.md` §6) on a real Cloudflare Container.
1. Review `index-reports/cloud-benchmark-cloud-bench-e.json` (or rerun the benchmark at
   a larger size) and the forecast above.
2. Approve the full-run budget (the expected case is under $30; the conservative high is
   not) by recording `approvedFullRun` in `control.json`.
3. Provide a Cloudflare API token with Containers + R2 + Workers permissions so the
   container can be deployed (Docker must be available on the deploying machine).
4. Run Pass 1 in full, verify, then run Cloud Pass 2 and activate only after validation.

Full indexing has **not** been started, and no existing index or source object was
modified.
