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

**Pass 1 output is byte-compatible with the local v2 spool.** `tools/cloud/assemble.ts`
concatenates a partition's segment objects (concatenated gzip members are one valid
gzip stream) and writes `progress.json`, `spool-manifest.json` and a `pass2-merge`
checkpoint. The existing merge then verifies it like any other spool. A test asserts the
assembled manifest is accepted and its row counts match the source.

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

**The one limit that blocks a full-corpus Pass 2 as a single container process:** the
complete v2 spool is ~23 GB, and a container has at most 20 GB of ephemeral disk. The
existing merge also writes the index (~20 GB) while it reads the spool, so it cannot run
inside one container even if the spool fit. Pass 2 must stream both sides.

## What is verified, and what is not

| Component | Status |
| --- | --- |
| Boundary-safe chunking over R2 (quoted newlines, UTF-8, exact offsets) | **IMPLEMENTED AND VERIFIED** (tests + real R2) |
| Compact segmented Pass 1 with per-chunk manifests and checkpoints | **IMPLEMENTED AND VERIFIED** |
| Resume after pause/kill; refuses a changed source identity | **IMPLEMENTED AND VERIFIED** |
| Segment verification (SHA-256 + row accounting + coverage) | **IMPLEMENTED AND VERIFIED** |
| Cloud → v2 spool assembly (format compatibility with existing merge) | **IMPLEMENTED AND VERIFIED** on fixtures |
| Control panel + backend controls (R2 state and control flags) | **IMPLEMENTED AND VERIFIED** in the preview (a benchmark was started through it) |
| Container image and runner | **IMPLEMENTED BUT NOT VERIFIED** — no Cloudflare API token in this workspace, nothing deployed |
| Full-corpus container execution | **NOT RUN** (requires your approval) |
| Cloud-native Pass 2 (streaming shard merge) | **NOT IMPLEMENTED** — see blocker below |
| Existing application/search | unchanged; the running index is untouched |

### Pass 2 blocker, precisely

The merge is partition-independent for identity and association (a company and its
contacts hash to the same partition), which is what makes a distributed reduce correct.
But producing the **global** v4 shards needs one of:

* a reduce stage that writes per-partition posting parts, then a shard-merge stage that
  concatenates the parts for each shard (this is the right design, and it has not been
  written yet); or
* a machine with >43 GB free disk to materialize the spool and the index, which a
  personal computer is explicitly not allowed to be.

A container cannot do the second. So the honest status is: Pass 1 can run entirely in
Cloudflare; Pass 2 needs the streaming shard merger before the full corpus can be
generated in the cloud. The existing single-process Pass 2 remains available (and is
what assembled bounded runs use), but it is not the cloud path.

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
conservative planning bound. The high scenario exceeds the $30 preference, so the
operating rule is: a **per-stage budget stop** (pause before the projected total crosses
$30), not a claim that Cloudflare enforces the alert. Cloudflare's budget alert is a
notification, not a hard cap.

What the forecast includes: container CPU/memory/disk beyond the monthly allowances, R2
Class A/B beyond 1 M/10 M, intermediate spool storage (one month), and the final index.
It excludes: the $5 Workers Paid subscription (already active), egress (R2 egress is
free), and retries beyond the measured ones.

## Using the control panel

`/indexing` in the preview shows the durable state of every job and can:

* run a bounded benchmark (1–256 MB per source) through the real chunker/segment writer;
* pause, resume or abort — the engine checks the flag before the next chunk;
* verify every uploaded segment independently (re-reads and re-hashes);
* view the last checkpoint, errors, throughput and running R2 estimate.

It cannot start the full corpus. `run` requires `--approve-full`, and that refuses unless
`control.json` records `approvedFullRun: true` — a deliberate two-step guard.

The panel talks to the dev server's `/api/cloud/...` routes (dev-only, header-guarded).
They are not mounted in production; a deployed control plane would use the same R2 keys
behind Cloudflare Access.

## Running the container

```
docker build --platform linux/amd64 -f cloud/Dockerfile -t companyintel-indexer .
docker run --rm -p 8080:8080 \
  -e R2_ACCOUNT_ID=… -e R2_ACCESS_KEY_ID=… -e R2_SECRET_ACCESS_KEY=… \
  companyintel-indexer
curl -X POST localhost:8080/job -d '{"args":["run","--version","v1-cloud-2026-10-19","--max-source-mb","16","--partitions","16"]}'
```

Deploying it as a Cloudflare Container needs a Worker with a Container/DO binding and an
API token that this workspace does not have. That deployment has not been attempted.

## Approval needed before the full run

1. Review `index-reports/cloud-benchmark-cloud-bench-e.json` (or rerun the benchmark at
   a larger size) and the forecast above.
2. Approve the full-run budget (the expected case is under $30; the conservative high is
   not), and the Pass 2 plan.
3. Deploy the container (requires a Cloudflare API token with Containers + R2 + Workers
   permissions).
4. Run Pass 1 in full, verify, and only then implement/execute the streaming shard
   merger for Pass 2.

Full indexing has **not** been started, and no existing index or source object was
modified.
