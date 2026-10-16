# Indexing (local, streaming, two input modes)

The indexer turns the two raw CSV files into the versioned R2 objects the Worker reads. It
runs **on your machine**, never inside a Worker: 60 GB cannot be streamed in a Cloudflare
Worker, and the spec forbids a hosted database substitute.

- Files: `tools/indexer/src/{cli,csv,mapping,build,r2,source}.ts`
- Config: `tools/indexer/indexer.config.json`
- Runtime: Node 20+ or Bun. Only Node built-ins are used for CSV/disk work.

## Two input modes (the pipeline is identical)

| Mode | `sources[].path` | Where the bytes come from | Credentials |
| --- | --- | --- | --- |
| **A — local file** | `D:/data/file1.csv` (or any local path) | your disk | none |
| **B — R2 object** | `r2://company-intel-data/raw/file1.csv` | the real bucket, streamed | the private `.r2-credentials.json` file (see below) |

Both modes feed the same parser, the same column mapping and the same pipeline, and a parity test
asserts they produce identical records and identical profiles for the same bytes
(`tests/indexer-r2-source.test.ts`).

For your situation — the CSVs are in R2 and the local copies may only exist on a previous laptop —
**Mode B is the practical option**, and it does not mean downloading 60 GB into memory or into a
single local file:

- objects are read in **bounded ranged requests** (8 MiB per request by default);
- each object is **cached once** under `rawCacheDir` (default `.indexer-raw-cache`) through a
  `.part` file that is renamed only after the byte count matches R2, so an interrupted run resumes
  from disk instead of re-downloading;
- set `"rawCacheDir": null` to stream straight through without keeping a local copy (a re-run then
  re-downloads).

### Why Mode B still needs R2 keys (and why the app does not)

Wrangler's OAuth login is usable only by processes Wrangler manages — the Worker runtime and its
bindings. This indexer is a plain Bun/Node process, so the only way for it to read an object is the
S3-compatible API, signed with its own credentials. There is no API that hands a Worker binding to
a local script, and `wrangler` has no "read a bounded range for me" command. That is why the
production Worker and the read-only probe need **no** keys, while Mode B does.

Least privilege (the token that is already configured here was created this way):

1. Cloudflare dashboard → **R2 → API → Manage API tokens → Create API token**.
2. Permissions: **Object Read** is enough to read/index. Add **Object Read & Write** in a separate
   token only when you upload the built index.
3. Scope it to the single bucket `company-intel-data`. Never "all buckets".
4. Put the pair in the private, git-ignored `.r2-credentials.json` (see `docs/configuration.md` §5)
   and `chmod 600` it. Every server-side tool reads that file automatically; `bun run r2:doctor`
   proves the pair signs a real request. Never commit it, never paste it in chat, never put it in a
   hosting environment panel.

If you would rather avoid tokens entirely, copy the objects down with rclone and use Mode A:

```bash
rclone copy r2:company-intel-data/raw/ ./raw-copy --progress   # needs ~64 GB of local disk
```

### Honest cost estimate for a 64.26 GB Mode B run

Two kinds of number appear below. **Measured** figures come from this workspace against the real
bucket (identified); **extrapolated** figures are arithmetic on those measurements and are labelled
as such. Replace the extrapolations with a 1,000,000-row sample run before the full job.

| Resource | Figure | Basis |
| --- | --- | --- |
| Source bytes | `raw/file1.csv` 10,223,471,749 B + `raw/file2.csv` 54,038,527,871 B = 64.26 GB | **measured** (LIST + HEAD) |
| Network | ~64.26 GB down once per object ≈ 7,664 ranged GETs at 8 MiB | extrapolated; **measured** single ranged GET of 8 MiB took 0.88–1.07 s here (~8–9 MB/s) |
| Parse throughput | file1 8,143 rows/s (17.7 MB/s, 2,176 B/row); file2 40,839 rows/s (22.8 MB/s, 558 B/row) | **measured** on this 1-vCPU sandbox |
| Row counts | file1 ≈ 4.7 M organizations; file2 ≈ 96.8 M people ≈ 101 M rows total | extrapolated from the measured bytes/row |
| Duration | ≈ 2–3 h single-threaded (download + parse, additive) | extrapolated; a 39,505-row Mode B sample run took 118 s end to end here |
| Temporary space | 182.09 GB reported by preflight for the full input (spool 71.06 + Mode B staging 54.04 + index 20.30 + bookkeeping 0.27, ×1.25) | **measured** preflight output, against the real bucket |
| Generated index | preflight estimates 7.71 GB. Measured bytes/record from the real-data sample (10.46 MB gzipped for 20,265 companies + 19,414 contacts): **99 B/company**, **96 B/contact**, **324 B/company of index shards**. Applied to the extrapolated corpus (4.7 M organizations + 96.8 M people): 0.5 GB + 9.3 GB + 1.5 GB ≈ **11 GB, contacts dominating** (range 9–20 GB) | bytes/record **measured**; the corpus row count is extrapolated, so the total is too — **confirm with the 1 M run** |
| `rawCacheDir` | ~64 GB if enabled (skippable with `"rawCacheDir": null`) | the bytes have to land somewhere to resume |
| RAM | bounded: one hash bucket + one partition at a time; 2 GB was enough for the sample | by design |
| R2 operations | ~7.7 K Class B reads + one upload per generated object (Class A) | extrapolated |
| Cloudflare cost | inside the free allowance at this volume (see `docs/cost.md`) | extrapolated |

This workspace itself **cannot** run the full job: the sandbox has 1 vCPU, 1.64 GB free RAM and
0.9 GB free disk. Preflight says so and refuses:

```
  ! Temporary space looks insufficient: about 0.9 GB free vs 71.0 GB estimated for spooling.
```

## How a run works

| Pass | What happens | Disk |
| --- | --- | --- |
| preflight | Checks both input paths, sizes, free disk, free memory, CPU cores; estimates work space, output size and duration | — |
| pass 1 | Streams both CSVs, detects headers per file, maps each file's own schema to the canonical model, and spools rows into `partitions` hash buckets keyed by the strongest identifier | `workDir/spool/part-####.jsonl` |
| pass 2 | One partition at a time: resolves identity, deduplicates contacts, builds facets, writes index postings, company partitions and contact partitions | `workDir/spool/`, then `outputDir/` |
| validating | Re-reads generated objects, verifies checksums/counts, records `validation.json` | — |
| uploading | Uploads each object with retries, skipping objects already present (idempotent, resumable) | — |
| publishing | Flips `manifests/active.json` to the new version — **only** for a validated version | — |

Memory stays bounded: at most one hash bucket plus one partition is held at a time; the
partition count in the config controls the working set. Rows that cannot be parsed get a
structured entry in `workDir/rejected.jsonl` (`{source, line, reason, fields…}`) rather than
being silently dropped.

Interrupted runs resume: `workDir/checkpoint.json` records the completed stage, and a re-run
skips finished passes (`--no-resume` to start over).

## Commands

All commands are run from the repository root, on Windows use PowerShell with forward slashes.

```bash
# 0. Confirm the real object keys first — never guess them (read-only)
bun run r2:doctor          # credentials file + endpoint + one signed LIST of raw/
bun run r2:schema          # both files: encoding, delimiter, columns, mapping + confidence
bun run verify:r2          # inventory, sizes, ETags, bounded body read, dataset state
bun run verify:r2:remote   # same ground truth through the Worker binding (no keys at all)

# 1. Install dependencies once
bun install

# 2. Inspect both sources: headers, fill rates, encoding, delimiter, mapping suggestions
bun tools/indexer/src/cli.ts profile --config tools/indexer/indexer.config.json

# 3. Sample runs (mandatory before the full job)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 10000    --version v1-sample-10k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 100000   --version v1-sample-100k

# 3b. The one-million-record readiness benchmark — PREPARED, NOT RUN AUTOMATICALLY.
#     Nothing in this repository runs it for you: it downloads up to ~2 M records
#     from R2 (bounded ranged GETs), spools ~1.4 GB in workDir, streams ~2.2 GB
#     through the raw-cache staging file and writes ~0.4 GB of index — the
#     preflight asks for 5.3 GB free and ~7 min of pass 1 at the measured
#     5,000 rows/s, plus the merge. Preflight refuses to start if the volume
#     cannot hold it.
bun run index:benchmark-1m
# same thing, explicit:
# bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 1000000 --version v1-bench-1m

# 4. Full job, upload only after it validates (needs R2_* env vars)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --version v1 --upload

# 4b. After a failed or interrupted run: read-only spool diagnosis (changes nothing)
#     Prints the partition, line number, byte offset and checksum of any damage —
#     never company or contact records — so its output can be pasted into a report.
bun run index:spool-doctor

# 5. Re-verify what is on disk against its checksums
bun tools/indexer/src/cli.ts validate --config tools/indexer/indexer.config.json --version v1

# 6. Publish (flips manifests/active.json; requires --yes)
bun tools/indexer/src/cli.ts publish --config tools/indexer/indexer.config.json --version v1 --yes
```

`--sample <n>` applies per source, so both schemas are always represented in a sample run — and in
Mode B it also bounds the download: the reader stops fetching once the sample limit is reached and
discards the partial cache. Sample versions are safe to upload to a `staging`/sample version id;
the app ignores any version that is not the active one.

## Coverage validation

Each run's manifest records, per source: rows read, rows rejected, companies and contacts
contributed — so you can prove both files contributed. It also reports unique companies,
unique contacts, duplicate rows resolved, ambiguous companies kept separate, records missing
a company identifier, and contact/company association errors. The Dataset Management page
displays the same numbers from the manifest and the dashboard charts come only from these
counts. **Nothing is fabricated:** before a first successful index the UI shows
"Dataset not indexed" rather than invented figures.

## Preflight report

`profile` and `run` both print the preflight block first. This is the real output from
`bun run index:profile` against the live bucket (the free-disk and CPU figures describe the
development sandbox, not your machine):

```
Preflight
  ok   csv1  10.22 GB  r2://company-intel-data/raw/file1.csv
  ok   csv2  54.04 GB  r2://company-intel-data/raw/file2.csv
  input total          64.26 GB
  free disk            0.63 GB
  temporary space need 182.09 GB
    spool               71.06 GB  (canonical rows written by pass 1)
    raw cache staging   54.04 GB  (largest Mode B .part alive at once)
    index output        20.30 GB  (written during pass 2, same volume by default)
    run bookkeeping     0.27 GB  (checkpoint, spool manifest, rejected/objects lists)
    safety margin       x1.25 applied to the four terms above
  estimated output     20.30 GB
  memory free / total  1.48 GB / 2.09 GB
  cpu cores            1
  ! Temporary space looks insufficient: about 0.6 GB free vs 182.1 GB estimated for spool + raw cache + output.
  ! Budget 54.0 GB for the Mode B raw-cache staging file as well as 71.1 GB for the spool: they are alive at the same time. Setting `rawCacheDir` to null removes that term and costs a re-download on resume.
```

**This number changed after the first real benchmark, and it is much larger than it used to be
(70.96 GB → 182.09 GB). The old figure was the spool alone.** The Mode B staging file that a
cached source is streamed into (`<rawCacheDir>/<bucket>/<key>.part`) was not in the arithmetic at
all, and neither was the generated index — even though the "Disk budget, added up" table further
down this document already budgeted ~145–155 GB for exactly this run. The preflight contradicted
the documentation; the benchmark proved the documentation right. See
[Why the estimate was wrong](#why-the-estimate-was-wrong) for the measurement.

`bun run index:benchmark-1m:preflight` is the same check for the **1 M-record sample**, and it is
sample-aware: the temporary-space estimate covers the sampled rows, not all 64.26 GB, so the
benchmark can be run on a machine that cannot hold the full job. Real output from this working
tree (the R2 reads and mapping checks are real; free disk is the sandbox's):

```
Preflight
  ok   csv1  10.22 GB  r2://company-intel-data/raw/file1.csv
  ok   csv2  54.04 GB  r2://company-intel-data/raw/file2.csv
  input total          64.26 GB
  free disk            0.63 GB
  temporary space need 5.31 GB
    spool               1.40 GB  (canonical rows written by pass 1)
    raw cache staging   2.18 GB  (largest Mode B .part alive at once)
    index output        0.40 GB  (written during pass 2, same volume by default)
    run bookkeeping     0.27 GB  (checkpoint, spool manifest, rejected/objects lists)
    safety margin       x1.25 applied to the four terms above
  estimated output     0.40 GB
  memory free / total  1.61 GB / 2.09 GB
  cpu cores            1
  ! Temporary space looks insufficient: about 0.6 GB free vs 5.3 GB estimated for spool + raw cache + output in a 1,000,000-record sample per source.
  ! Budget 2.2 GB for the Mode B raw-cache staging file as well as 1.4 GB for the spool: they are alive at the same time. Setting `rawCacheDir` to null removes that term and costs a re-download on resume.
  sample               1,000,000 records per source (temporary space estimated from this, not from the full input)
  duration estimate    ~7 min at 5,000 rows/s — the MEASURED end-to-end rate
                       of the 1 M benchmark (R2 read + parse + spool). The run prints its own per-stage
                       timings afterwards; use those, not this hint.

Schema mapping actually in use (automatic mapping + config overrides)
  ok   csv1  51 columns · delimiter "\t" · encoding utf-8 · 10 override(s)
       company id ← "organization_id" · name ← "organization_name" · domain ← "organization_domain"
  ok   csv2  39 columns · delimiter "\t" · encoding utf-8 · 13 override(s)
       contact email ← "person_email" · phone ← "person_phone" · linkedin ← "person_linkedin_url"

Preflight only: NOT ready — free disk space is below the estimate above. Nothing was read in bulk, no index was built, nothing was uploaded.
```

So the benchmark's prerequisites are checked **before** any bulk read: R2 credentials (the two
`ok` lines are real HEAD requests), both object keys, the TSV delimiter and both column mappings
against the live files, free disk, free memory, and CPU count. On this sandbox it correctly
refuses; on a machine with ~2 GB free it proceeds. Exit code 1 means "not ready" and nothing was
written.

The run itself refuses to start when temporary space is insufficient, and watch for the mid-run
floor (512 MB) as well. The output-size and duration figures are hints, not measurements: replace
them with your own sample-run timings (the measured parse rates and transfer rates in the cost
table above are the numbers to plan with).

## The 1 M real-data failure, the cause, and what changed

The first `index:benchmark-1m` run against the two real objects **failed**, and this section records
exactly what happened, because the failure was only visible on real rows:

```
[pass2-merge] [0%] pass 2: 3,869 companies from 1/256 partitions
JSON Parse error: Unterminated string
```

### Cause: U+2028 / U+2029 are separators to a reader and ordinary characters to JSON

Pass 1 wrote each spool row with `JSON.stringify(row)`. `JSON.stringify` escapes `\n`, `\r`, `\t`
and the other C0 control characters — but **not** U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH
SEPARATOR), which are legal, unescaped characters inside a JSON string. Pass 2 read those files
back with `node:readline`, which treats U+2028 and U+2029 **as line terminators**. One spool record
containing one of those characters was therefore read as two "lines", and the first one ended in
the middle of a JSON string:

```
{"keys":["n:globex"],"bucket":"n:globex",...,"company":{"name":"Globex","industry":"Software
Services",...}}          ← readline ended the record at the separator
```

`JSON.parse` on that fragment raises exactly `Unterminated string`. U+2028/U+2029 are what scraped
exports use as an in-cell line break, so they appear early in real data — the failure hit within the
first partitions, and no test fixture (all ASCII) had ever produced one.

A second, related defect made it hard to diagnose: a truncated partition reads back as a **shorter
but perfectly valid** JSONL file, so `pass2-merge` could have merged it and silently dropped rows.

### What changed

| Change | Where |
| --- | --- |
| `encodeJsonlLine` escapes U+2028/U+2029 in every intermediate record; `readJsonlFile` splits on `\n` only, so a legacy file written by the old build still reads back as one record | `tools/indexer/src/jsonl.ts` |
| Pass 2 reads the spool with that reader; a record that still cannot be parsed fails with its partition, line number and byte offset instead of being skipped | `tools/indexer/src/build.ts` |
| The shard `.lines` reader uses the same splitter, and a malformed posting line is an error instead of a silent `continue` | `tools/indexer/src/build.ts` |
| Pass 1 records every partition (bytes, record count, SHA-256) in `workDir/spool-manifest.json`, written by rename **after** all streams are flushed; pass 2 verifies it before merging and refuses a missing, short, or checksum-mismatched partition | `tools/indexer/src/spool.ts` |
| `rawCacheDir`, the generated index and a fixed bookkeeping cost are added to the preflight estimate, the spool constant is a measurement instead of a guess, and a 25% margin is applied to the sum | `tools/indexer/src/build.ts` |
| The duration hint uses the **measured** end-to-end rate (5,000 rows/s) instead of a synthetic 120,000 rows/s, and the run prints per-stage timings | `tools/indexer/src/build.ts`, `tools/indexer/src/cli.ts` |
| `bun run index:spool-doctor` inspects an existing spool read-only and prints positions, never records | `scripts/spool-doctor.mjs` |

### Why the estimate was wrong

The benchmark's output gives the numbers directly:

| Term | Old estimate | Now | Evidence |
| --- | --- | --- | --- |
| Spool (`part-*.jsonl`) | 1.80 GB (`2 M × 900 B`, a guess) | 1.40 GB (`2 M × 700 B`) | 3,778 real spool rows measure 524.5 B/row; 700 B adds headroom for wide organization rows |
| Mode B raw-cache staging (`.part`) | **not counted at all** | 2.18 GB | the object bytes read before the sample stops, rounded up to 8 MiB ranged requests |
| Generated index | 0.54 GB (`spool × 0.3`) | 0.40 GB (`2 M × 200 B/row`) | the measured range for the full corpus is 9–20 GB, so the top of it is used per row |
| Run bookkeeping | 0.06 GB | 0.27 GB | checkpoint, spool manifest, `rejected.jsonl`, `objects.jsonl` |
| Safety margin | none | ×1.25 | a run must not be able to fail on a rounding difference |
| **Reported total** | **1.87 GB** | **5.31 GB** | the benchmark's own peak was already **2.49 GB** before it failed |

`2.49 GB` decomposes as the csv1 `.part` (≈2.2 GB, still being written while the spool grew) plus
the spool written so far — which is why the largest single missing term, not the spool constant,
was the main error. The full-corpus requirement is now **182.09 GB** (71.06 spool + 54.04 staging +
20.30 index + 0.27 bookkeeping, ×1.25), or **93.6 GB** with `"rawCacheDir": null` and no resume
cache. Both are in line with the "Disk budget, added up" table below, which was already right.

### Duration

The old hint promised **~17 s** for the benchmark (`2 M ÷ 120,000 rows/s`). The real run processed
1,986,239 records in pass 1 at **≈5,015 rows/s** — about 6.6 minutes, and that rate is network
bound plus parse plus spool, measured end to end. The full 64.26 GB corpus is therefore of the order
of **5–6 hours in pass 1 alone**, not minutes.

Pass 2 is the other half and must not be ignored: a 20,200-row local stress run measured **18.6 s in
`pass2-merge`** on this 1-vCPU sandbox (≈1,100 rows/s, dominated by shard postings and gzip), so on
the full corpus the merge is hours too. The preflight hint is only a hint — **the run prints
`stage timings` and those are the numbers to plan the full job with.**

## Recommended sequence (approval gates included)

1. `profile` both files and confirm the canonical mapping (adjust `columns` if needed).
2. Run the 10k / 100k samples. Compare rejected-row counts and the "both sources contributed"
   numbers; check `/companies` in the app against a sample version.
3. Run a 1M-record sample and record wall-clock time, peak RAM, disk used, output size.
4. **STOP — approval gate.** Send me the measured numbers and ask for approval before the
   full 60 GB job (this is the "sample-first" requirement of the specification).
5. Full run with `--version v1 --upload`, then `validate`, then `publish`.

`index:benchmark-1m` exists so step 3 can be done with a real number instead of
an extrapolation. It is deliberately a manual command — a benchmark that runs
itself on a developer machine (or in CI) would download gigabytes without being
asked to.

### Collecting the benchmark numbers

Every number the specification asks for is printed by the run itself, so nothing
has to be measured by hand. They come from the run, not from an estimate:

| Number | Where it comes from |
| --- | --- |
| Records processed | `files read` (and per source: `csv1: N rows, M rejected`) |
| Wall-clock duration | `elapsed` (also `rough duration hint` in the preflight block) |
| Peak memory usage | `peak memory  X MB/GB RSS` — sampled every 5 s across the whole run |
| Peak temporary disk | `peak temp disk` — sampled over `workDir` + `rawCacheDir` |
| Index output size | `index output` — bytes written into `outputDir` |
| Object count | `objects written` |
| R2 request count | `r2 requests  N (M retried, X GB read, K object(s) streamed)` — counted per HTTP attempt, so retries are visible |
| Per-stage timings | `stage timings` — profiling, pass 1, pass 2 merge, finalize+index, validate. This is where a duration estimate should come from; the preflight only prints a hint. |
| Rejected rows | `rows rejected`, with a per-source split |
| Company / contact counts | `unique companies`, `unique contacts` |
| Association ambiguity | `ambiguous kept apart (name collisions with conflicting strong evidence)` |
| Checkpoint / resume | re-run the *same* command: `elapsed` drops, `files read` is restored from the checkpoint, and `r2 requests` shows `0 object(s) streamed` |

For a Mode B run the counters also tell you what the local cache saved:
`served from cache  X GB (no R2 requests for those bytes)`.

A worked example (this workspace, real bucket, `--sample 2000 --version v1-check-b`):
3,941 rows read, 163 rejected, 2,069 companies, 1,922 contacts, 13 ambiguous kept
apart, 1,808 objects, **22.4 s** first run and **17.6 s** resumed, **0.51–0.54 GB**
peak RSS, **1.2 MB** index output, and **6 R2 requests** (0 retried, 12.6 MB read).
That is 4,000 records — scale it with the per-source parse rates above, not with
this duration.

### Checkpoints belong to one run

Resuming needs **two** facts, and they are separate on purpose:

- `workDir/checkpoint.json` records a **run identity** next to the counters: dataset version,
  sample limit, partition count, and each source's path, delimiter and number of column overrides.
  It answers "is this spool mine?".
- `workDir/spool-manifest.json` records every partition pass 1 finished writing: file name,
  partition number, exact byte length, record count and SHA-256. It is written by rename only after
  every stream has been flushed, so its presence answers "did pass 1 actually finish?".

Without the second one, a checkpoint alone asserts something it cannot know. A truncated partition
is a shorter but valid JSONL file, so merging it would drop the missing rows with nothing to show
for it. Pass 2 therefore verifies each partition's size before reading it and its record count and
checksum while merging, and stops with the exact file and byte count if anything disagrees.

`bun run index:spool-doctor` reports what is on disk (`clean`, `incomplete` or `damaged`, with
partition/line/byte offsets), and can adopt a spool written by an older build — see
`docs/recovery.md`.

Resuming is allowed only when the identity matches, because the spool partitions in
`workDir/spool/` belong to the run that wrote them:

- running the 1 M benchmark after a full run (or a sample after the benchmark)
  **stops** with the exact differences listed, instead of merging two different
  inputs into one version;
- `--no-resume` is the answer: it ignores the checkpoint, clears the stale
  `part-*.jsonl` spool (pass 1 *appends* to those files, so leaving them would add
  a second copy of every row) and rebuilds from the sources;
- a checkpoint written by an older build (no identity) is refused the same way —
  unknown provenance is not resumed;
- pointing `workDir` at an empty directory keeps both runs side by side.
6. Verify in the app: `/dataset` shows the new active version, `/companies` returns results.

No paid service is enabled by any of these steps. Nothing is published until a version passes
validation.

## Resource guidance

### Disk budget, added up

Do the arithmetic before starting a 60 GB job — the two caches are separate:

| Component | Size | Notes |
| --- | --- | --- |
| spool (`workDir`) | 71.06 GB (preflight) | mandatory: pass 2 cannot run without it |
| raw cache (`rawCacheDir`) | 54.04 GB for this corpus — the largest single object, not their sum, because sources are read in turn | only needed for resume without re-downloading |
| generated index (`outputDir`) | 20.30 GB (preflight estimate; measured range 9–20 GB) | written during pass 2 |
| run bookkeeping | 0.27 GB | checkpoint, spool manifest, rejected/objects lists |
| **all of the above, as the preflight requires it** | **182.09 GB** (the four rows × 1.25 margin) | one volume by default |
| **`rawCacheDir: null`** | **~93.6 GB** | streams straight through; a re-run downloads again |

The preflight now computes exactly this sum, so the number it prints and the table above agree. If
you are short of space, `"rawCacheDir": null` is the single change that removes the largest term.

So a machine with a single 128 GB volume should either put `rawCacheDir` on a second disk or set
it to `null` and accept re-downloading on resume. `outputDir` is written *during* pass 2, so its
size must be free at the same time as the spool. The mid-run floor (512 MB) stops a run before the
volume fills, but it does not create space: an under-sized machine fails at hour two either way.

- Keep `workDir` on the fastest disk with room for ~1.5× the input size in spool files.
- 16 GB RAM is comfortable; the design is disk-partitioned so less RAM only costs speed.
- One `run` process saturates roughly one core for CSV parsing plus I/O; do not run two
  full jobs concurrently.
- Upload is per-object with retry; re-running `run --upload` after a network failure reuses
  everything already on disk and skips objects already in R2.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `source csv1 was not found at …` | Fix `sources[].path` in the config; the profiler prints the exact resolved path. |
| `R2 credentials are missing for: company-intel-data` | Mode B needs the three `R2_*` variables in the shell running the indexer (Object Read is enough). The message prints the least-privilege recipe; see the Mode B section above. |
| `… does not exist (HTTP 404)` | The object key is wrong. Copy the exact key from `bun run verify:r2:remote` output into `sources[].path`. |
| `… could not be read (HTTP 403)` | The credentials in that shell cannot read the bucket: check the token's bucket scope and permission. |
| A Mode B run downloads again after a restart | The cache directory was changed or removed, the object changed on R2 (size differs), or `rawCacheDir` is `null`. Set `"rawCacheDir": ".indexer-raw-cache"` to keep resume behaviour. |
| Columns mapped to the wrong canonical field | Add a `columns` override for that source (`{"companyname": "Org Name"}`). |
| High rejected-row count | Check the encoding/delimiter for that file; inspect `workDir/rejected.jsonl` reasons. |
| `Refusing to start: temporary space is insufficient` | Free space on the `workDir` volume, or lower `partitions`. |
| `Stopping before the disk fills: … below the … floor` | The mid-run guard (512 MB free on `outputDir`). Nothing written was lost and the checkpoint is still at `pass2-merge`: free space and re-run the same command to resume. |
| `workDir already holds a checkpoint for a different run: …` | The spool belongs to another run (different version, sample size, partitions or source paths). Re-run with `--no-resume`, or point `workDir` somewhere empty. Nothing was read or written before the stop. |
| `was written without a run identity; refusing to resume it` | A checkpoint from a build older than the run-identity change. Re-run with `--no-resume` once. |
| A resumed run reports `source_missing_rows` (csv1=0, csv2=0) | Fixed: pass-1 counters are restored from the checkpoint, so a resumed run no longer fails validation over its own bookkeeping. If you see it on an older build, re-run with `--no-resume` once. |
| `JSON Parse error: Unterminated string` during `pass2-merge` | Fixed: U+2028/U+2029 in a spool row were split by the old `readline` reader. See "The 1 M real-data failure" above. Records written by the old build still read correctly with the new reader, and `index:spool-doctor` reports any record it cannot parse with its partition, line and byte offset. |
| `Refusing to merge: … has no spool-manifest.json` | The spool cannot be shown to be complete (it was written by a build older than the manifest, or pass 1 never finished). Run `bun run index:spool-doctor`: if every partition reads `ok`, `--repair-manifest` records the manifest and pass 1 is reused; otherwise re-run with `--no-resume`. |
| `Spool partition part-NNNN.jsonl is truncated: X B on disk, Y B recorded` | A partition was cut short (killed process, full disk, lost write). Its rows cannot be recovered from the spool, so nothing is merged. `index:spool-doctor` shows every partition; `--no-resume` rebuilds the spool. |
| `Spool partition … lost or gained records` / `does not match the checksum pass 1 recorded` | The file changed after pass 1 wrote it. Same remedy: inspect, then `--no-resume`. |
| `R2 credentials are not set` on publish | Export `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` for the session. |
| Version uploaded but the app still shows the old data | `publish` was not run (or failed) — `manifests/active.json` still points at the previous version. |
