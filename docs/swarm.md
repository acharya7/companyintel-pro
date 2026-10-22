# Parallel indexing — 16 containers, one coordinator

The full corpus (≈64.26 GB in `raw/file1.csv` and `raw/file2.csv`) is processed by **16
Container-backed workers** instead of one sequential CLI. This document is the runbook
and the design record: what each piece owns, why the boundaries are where they are, and
what is still **not** parallel.

Status of this implementation: **code complete and tested locally** (typecheck, lint,
`bun test`, including a byte-for-byte comparison against Cloud Pass 1 output). It has
**not** been deployed or started against the real bucket from this workspace — there is
no authenticated Wrangler, no Docker, and no Cloudflare token here. Nothing below claims
that an indexing job has run.

## 1. Why the old pipeline serialised

`tools/cloud/pass1.ts` is a single loop: read a chunk, write its segments, advance the
checkpoint. `tools/cloud/pass2.ts` then merges **all** partitions in one process, because
the index writer assigns document refs sequentially across partitions. Both are correct
and both are single-threaded. One container (`standard-1`) therefore caps the whole job,
and 64 GB of parsing does not fit in a useful amount of time.

## 2. What runs where

| Component | Class | Identity | Role |
| --- | --- | --- | --- |
| Coordinator | `IndexingCoordinator` | `idFromName("swarm")` | Durable task table, leases, phases, budget, aggregate Pass 1 publication |
| Worker ×16 | `IndexerWorker` | `idFromName("indexer-worker-00" … "-15")` | Owns one container, claims one task at a time, reports results |
| Container | `./Dockerfile` → `cloud/runner.mjs` | per worker | Runs `blocks` / `range` / `pass2` for the claimed task |

`max_instances = 16` is only an upper bound. **16 concurrent containers exist because
there are 16 distinct Durable Object names.** An implementation that addressed one name
and raised `max_instances` would run one container and look configured for sixteen — the
single most important thing to keep true in `wrangler.toml`.

```
                 ┌──────────────────────────┐
   plan/launch → │ IndexingCoordinator      │  tasks · leases · budget · phases
                 └───────┬──────────────────┘
        claim/complete   │   (DO → DO, never public)
     ┌───────────────────┼───────────────────┬─────────────┐
     ▼                   ▼                   ▼             ▼
 worker-00           worker-01           …              worker-15
     │ container           │ container       │              │ container
     └─ blocks/range ──────┴─────────────────┴──────────────┘
                          R2: segments + chunk manifests
                                    │
                          one merge task (any worker)
                                    ▼
                        index shards → manifests/<version>
```

## 3. Phases

### `blocks` — alignment

A range may only start at a newline that is **outside a quoted field**, and that is a
property of the file's whole prefix. Each worker scans a fixed 64 MiB block and records,
without parsing CSV fields:

* the number of quote characters and physical newlines in the block;
* the first newline that would be a boundary if the block started outside quotes, and the
  first that would be one if it started inside quotes;
* the physical line number of each of those.

The coordinator prefix-XORs the per-block quote counts to learn the real state at each
block start and picks the matching candidate (`planSourceRanges`). The result is a set of
offsets that are provably record boundaries.

### `ingest` — ranges

~1,000 blocks become ~500 ranges of 128 MiB. Each range task runs in a container:

```
range --version <v> --source csv1 --range <n> --start <bytes> --end <bytes> \
      --base-line <line> --partitions 256
```

It writes **exactly** what Pass 1 writes for one chunk — segment objects per partition,
the rejected rows, and `chunks/<source>/<n>.json` — so the existing, verified Pass 2 merge
consumes swarm output unchanged. The range's start and end are both record boundaries, so
no record spans a range and none is duplicated: the record ending exactly at `end` belongs
to this range, the next starts at `end`.

Idempotent by construction: every key is derived from the task, so a retried range
overwrites identical bytes.

### `merge` — single writer, by necessity

When every range of both sources is committed, the coordinator writes the aggregate
`checkpoints/<source>.json` and `state.json` (`stage: pass1-complete`, `coverage: full`,
real chunk counts) and queues **one** merge task. Any worker may claim it, so it is not
pinned to worker-00 and survives that worker dying.

**The merge is not parallel, and pretending otherwise would corrupt the index.** The index
writer assigns document refs sequentially across partitions (`globalRef` in
`tools/indexer/src/build.ts`), and postings, company/contact partitions and detail objects
are flushed in that same global order. Two processes merging different partitions at once
would emit two different ref spaces into the same shard objects. Making it parallel needs
a partition-scoped ref format and a matching change to how the Worker hydrates a document
from a ref — a new index format version, not a scheduler tweak. The coordinator already
dispatches arbitrary task kinds, so that change would not touch it.

What the swarm does remove is the expensive part: the 64 GB read, parse, entity mapping,
partitioning and gzip — roughly all of the CPU and nearly all of the wall clock — which is
now on 16 vCPUs instead of one.

## 4. Recovery

* **Leases.** A claim sets `leaseUntil = now + 15 min` and increments `attempts`. Any
  heartbeat or claim first reclaims expired leases (`reclaimExpired`), so a container that
  was stopped mid-range leaves a task that another worker picks up.
* **Attempts.** After 4 failures a task is `parked` with its error in `status.errors` and
  is not retried automatically — an operator sees the reason instead of an endless loop.
* **Duplicates.** `complete` is idempotent: a second completion of the same task returns
  `duplicate: true` and does not double-count rows.
* **Restarts.** Tasks, leases, per-source progress and the budget live in Durable Object
  storage; the plan is mirrored to `cloud/jobs/<version>/swarm/plan.json`. A redeploy of
  the Worker changes nothing an operator sees.
* **No laptop required.** Workers advance themselves on Durable Object alarms. Closing the
  browser, or switching the machine off, does not stop a run.
* **Auto-shutdown.** When the coordinator answers `complete`, `paused`, `aborted` or
  `budget`, each worker destroys its container. `idle` and `budget_soft` re-arm a 30 s
  alarm instead, because more work may appear.

## 5. Budget

`CLOUD_JOB_BUDGET_USD` (50 in `wrangler.toml`) is the run's budget. The estimate is:

* container seconds × `SWARM_CONTAINER_USD_PER_SECOND` (standard-2: 1 vCPU + 6 GiB), charged
  from worker heartbeats — a worker that stops heartbeating stops accruing, so a dead
  container is not billed as if it were running;
* R2 Class A / Class B requests and written bytes, reported by each task.

Gates: **$40** flags the status (`warn`), **$45** stops new claims (`soft` — in-flight
ranges finish and commit), **$50** pauses the run (`hard`). This is an application guard
over an estimate, **not** a Cloudflare billing cap; storage and post-snapshot requests are
outside it.

## 6. Running it

All routes are under `/api/cloud` and verified by Cloudflare Access plus the admin
allowlist. `plan` also requires `control.approvedFullRun`.

### From the panel (one confirmation)

`<APP>/indexing` → **Full dataset indexing — 16 containers** →
**START FULL INDEXING — 16 CONTAINERS**.

The card renders only after an authorised `/api/cloud/jobs` read succeeds, so an
identity the admin allowlist rejects never sees the button. One confirmation dialog
lists both source objects (10.22 GB + 54.04 GB ≈ 64.26 GB), 16 × standard-2, the 256
partition merge tasks, the $50 objective and the automatic budget pause. Confirming
runs, in order and with no further approvals:

1. `POST /api/cloud/jobs/<version>/control` `{"action":"approve"}` — the full-run gate;
2. `POST /api/cloud/swarm/plan` `{version, partitions:256, blockMb:64, rangeBlocks:2, workers:16}`;
3. `POST /api/cloud/swarm/launch` `{"workers":16}`;
4. `GET /api/cloud/swarm/status`, then polled every 5 s while the panel is open.

Duplicate protection: a non-terminal run for another version is refused; the same
version is resumed from its durable plan instead of re-planned; a completed version is
never re-planned (the coordinator is per version). The live card shows job version,
stage, active containers, source coverage, rows, parsed and searchable rows/second,
partition and shard progress, ETA, accrued estimate, remaining budget, errors/parked
tasks, and working Pause / Resume / Stop.

Execution does not depend on the browser: the coordinator and each worker advance on
Durable Object alarms, so the tab can be closed after the confirmation.

The same sequence from a terminal, for scripted use:

```bash
# 1. Approve the run (records the approval the full-corpus gate checks)
curl -X POST "$APP/api/cloud/jobs/prod-real-2026-10-22/control" \
  -H 'content-type: application/json' -d '{"action":"approve"}'

# 2. Create the plan: HEADs both sources, refuses an existing/validated version
curl -X POST "$APP/api/cloud/swarm/plan" \
  -H 'content-type: application/json' \
  -d '{"version":"prod-real-2026-10-22","partitions":256,"workers":16}'

# 3. Start 16 workers (each claims work and then advances itself)
curl -X POST "$APP/api/cloud/swarm/launch" -H 'content-type: application/json' -d '{"workers":16}'

# 4. Follow it
curl "$APP/api/cloud/swarm/status"

# 5. Controls
curl -X POST "$APP/api/cloud/swarm/pause"
curl -X POST "$APP/api/cloud/swarm/resume"
curl -X POST "$APP/api/cloud/swarm/abort"    # also destroys every container

# 6. After the merge reports complete, activate the generation explicitly
curl -X POST "$APP/api/cloud/jobs/prod-real-2026-10-22/activate"
```

The status object reports the numbers an operator actually needs: stage, active workers,
tasks pending/done/parked, rows and bytes covered per source, coverage percentage,
rows/second (parsed) versus **searchable** rows/second (only after the merge publishes a
generation), ETA, and the cost estimate with its budget level.

### Activation is deliberate

The swarm never moves `manifests/active.json`. A generation is activated by the existing
`activate` route after its manifest validates, so:

* the current real-data search keeps serving throughout ingest and merge;
* an incomplete or failed run cannot become the live index;
* rollback is the existing pointer rollback.

Progressive searchable coverage therefore means *successive activated generations* (for
example one per source group), not a pointer swap mid-run. Publishing an index built from
part of the corpus would make existing companies look absent from the dataset, which is
exactly what `docs/verification.md` forbids.

## 7. Tests

| Test | Proves |
| --- | --- |
| `tests/swarm-plan.test.ts` | cuts land only after a newline (byte-compared, so non-ASCII is handled), ranges are disjoint and exhaustive, and the swarm's per-partition spool is **byte-identical** to Cloud Pass 1's |
| `tests/swarm-coordinator.test.ts` | one worker per task, expired leases reclaimed, aggregate Pass 1 objects writable and verifiable, idempotent completion, $45/$50 budget gates |
| `tests/swarm-worker.test.ts` | 16 distinct identities, real CLI arguments (`--base-line`, `--partitions`, offsets) sent to the container, result read back from R2, container destroyed on completion |
| `tests/cloud-admin-deploy.test.ts`, `tests/worker-entry-routing.test.ts` | production config: `IndexerWorker`, `standard-2`, `max_instances = 16`, both migrations, Access untouched; staging stays at one instance |
| `tests/staging-config.test.ts`, `tests/staging-isolation.test.ts` | staging isolation unchanged |

Not covered by tests, and therefore unproven until a real deployment: cold-start timing of
16 containers at once, actual container-to-R2 throughput, and the real wall-clock
throughput of the merge.
