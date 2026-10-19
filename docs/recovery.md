# Reliability and recovery

Everything the application persists lives in R2. There is no database, so every guarantee below
comes from object layout, versioning, checksums and conditional writes — and every limitation is
stated in plain language rather than hidden.

## Dataset versions

```
manifests/<version>/manifest.json     counts, per-source coverage, checksums, output bytes
manifests/<version>/validation.json   pass/fail verdict + checks performed
manifests/<version>/progress.json     latest progress event (written by the indexer)
manifests/<version>/stats.json        aggregate stats used by the dashboard charts
manifests/active.json                 THE mutable pointer: { version, publishedAt, previous }
indexes|companies|contacts/<version>/ immutable, write-once objects
```

- Nothing is published until a version passes validation. A failed or interrupted build leaves
  the previous version untouched and serving.
- Publishing flips one small object. Nothing is deleted, so rollback is immediate.
- The Worker refuses to serve a version whose `directory.json` is missing or unreadable
  (`503 dataset_unavailable`) instead of mixing versions. A search response always reports the
  dataset version it came from.

### Rollback

Preferred: **Dataset Management → Versions → Activate**, which requires an explicit
confirmation and calls `POST /api/dataset/activate`.

Manual (equivalent):

```powershell
bun tools/indexer/src/cli.ts publish --config tools/indexer/indexer.config.json --version v1 --yes
# or copy a previous manifests/<version>/manifest.json pointer state into manifests/active.json
bunx wrangler r2 object get company-intel-data/manifests/active.json --pipe   # inspect first
```

If a new version looks wrong after publishing, roll back first and investigate afterwards.

## Indexing recovery

> **The full-index disk failure (2026-10-17) is documented in full below**, with the
> measurements, the new spool format and the exact recovery procedure. This first table
> describes the ordinary interruption cases.

| Failure | Behaviour |
| --- | --- |
| Interrupted during pass 1 (format v2, default) | `workDir/spool/progress.json` is written and fsynced at every checkpoint (default: every 100,000 rows / 60 s). It records the run identity, the column schema, each source's committed row count and every partition's committed bytes. Re-running the same command truncates only the uncommitted tail and continues at that source row. **No row is ever re-spooled, so a restart cannot double-count.** |
| Interrupted during pass 1 (legacy `spoolFormat: "jsonl"`) | There is no incremental ledger in that encoding: the partition files are the only state. A complete run leaves `spool-manifest.json` + `checkpoint.json`, and a re-run reuses them; an incomplete one must be assessed with `recover-spool` (below). |
| Interrupted during pass 2 | The Pass 1 spool is reused — the sources are **not** read again — and pass 2 is replayed from partition 1. Before replaying, the run deletes only what pass 2 itself generated for this run: `workDir/shards/**` (the temporary postings) and this version's `companies|contacts|indexes|manifests/<version>/` plus `objects.jsonl`. The spool, its manifest, the checkpoint, `rejected.jsonl`, the raw cache and every other version are left untouched, and the check enables no `--no-resume` and no pass-1 rebuild. Without that reset a restart appended a second copy of every already-merged posting and could hydrate objects written by the abandoned attempt. The checkpoint is only written after every partition stream has been flushed **and** `workDir/spool-manifest.json` has been written by rename, so "pass 1 finished" is a recorded fact rather than an assumption. |
| A partition file is short, malformed or changed after pass 1 wrote it | Pass 2 verifies each partition (length before reading, record count and SHA-256 while merging) and **refuses to merge it**, naming the file and the byte counts. A truncated partition would otherwise merge as a shorter, silently lossy index. Re-run with `--no-resume` after inspecting. |
| A spool exists but has no manifest (legacy format) | Pass 2 refuses with `no spool-manifest.json` rather than merging unverified partitions. `bun run index:spool-doctor` reports the state and `--repair-manifest` records a manifest **only if every partition verifies**. If there is also no checkpoint (the full-run failure), `recover-spool` is the path. |
| A fresh run finds spool files with no ledger and no checkpoint | **It refuses and touches nothing.** It used to delete them as "stale"; that is how 66.3 M parsed rows could have been lost. Deleting now needs `--discard-spool`. |
| Network failure during upload | Objects are uploaded individually with retries and exponential backoff; already-uploaded objects are skipped, so a re-run is idempotent. |
| Bad rows | Never silently dropped: written to `workDir/rejected.jsonl` with source, line number, reason and the first fields. Counts appear in the manifest and on the Dataset page. |
| Checksum mismatch | `validate` reports the object and exits non-zero; the version is not publishable. |
| Insufficient temporary space | Preflight refuses to start rather than half-producing a version. |

## The full-index disk failure, and the format that replaces it

### What happened

A full run on Windows (≈259 GB free) was started with
`index-full.cmd --version v1-full-2026-10-17 --yes`. Preflight estimated 182.09 GB of
temporary space and passed. Pass 1 finished the 10.22 GB company file and was deep into
the 54.04 GB contact file at ~7,309 rows/s when Windows reported `ENOSPC`.

| measured after the failure | value |
| --- | --- |
| `.indexer-work/spool` | 202.08 GiB ≈ **216.98 GB** |
| `.indexer-raw-cache` | 43.74 GiB (the contact object was not fully downloaded) |
| rows written | **66,333,763** |
| bytes per spool row | 216.98 GB / 66,333,763 = **3,272.6 B/row** |
| rows still to read | ~27 M contacts (the spool stopped mid-source) |
| checkpoint / spool manifest | **absent** |

### Root cause (measured, not inferred)

The spool row was `{keys, bucket, partitionKey, strong, normalizedName, company,
contact, source}`. `company` and `contact` were both produced by
`extractCompanyInput(record.fields, map, captured)` / `extractContactInput(record.fields,
map, captured)`, and **both call `captureAttributes(record, captured)` on the same row**.
On a contact row the entire 39-column source row was therefore serialized **twice**, and
each copy repeated every header name.

Measured on the real 20,000-records-per-source sample by rebuilding the v1 row from the
stored values (`bun` script, 6,000 rows):

| | company row (51 cols) | contact row (39 cols) |
| --- | --- | --- |
| v1 spool bytes / row | **3,975 B** | **3,195 B** |
| header text alone (one copy) | 1,441 B | 799 B |
| JSON of `company` + `contact` | 3,706 B | 2,980 B |
| source row (measured) | 1,734 B | 580 B |
| **expansion vs source** | **2.29x** | **5.51x** |

The corpus is ~94 % contact rows, so the observed 3,273 B/row is exactly the contact
row's 3,195 B plus company rows and metadata. Two independent defects compound:
**duplicated attributes** and **repeated header names**; neither is a duplicate *record*.
A JSON parse of every row can succeed and the spool still be unusable — which is why
recovery is proven from source provenance, not from parseability.

### Why the estimator passed

`STORAGE.spoolBytesPerRow = 700` had been measured on a spool written **before** full-column
capture existed, and rows were derived as `inputBytes / 633`. For this corpus that is
101.5 M rows × 700 B = 71.06 GB — 4.7x below the real 3,273 B/row. The model was
structurally wrong as well: `rows × a constant` cannot react to how *wide* the source rows
are, which is the variable that actually grew. No safety margin fixes a 4.7x error; the
model had to change.

### Format v2 (default from this build)

`tools/indexer/src/spool-v2.ts`:

```
spool/schema.json      source ids, delimiters, column count, canonical field → column map,
                       captured labels in file order  (written once, before row 1)
spool/progress.json    run identity + schema + per-source rowsRead/complete +
                       per-partition {bytes, rows, frames}   (atomic + fsync)
spool/part-0007.jsonl.gz   concatenated gzip frames (1 MiB uncompressed each)
spool/part-0007.frames     frame ledger: {offset, bytes, rows, sha256} per frame
spool-manifest.json    complete:true, per-partition bytes/lines/sha256(+frames), schema
```

A row is one positional JSON array, with no field names:

```json
[1, 1234567, "value0", "value1", …]
```

`sourceIndex`, the source row number, then every trimmed source value in column order.
Canonical company/contact inputs and identity keys are **re-derived on read** by the same
`extractCompanyInput` / `extractContactInput` / `companyKeysFromInput` functions that wrote
them, so the spool stores one copy of the source and nothing is lost.

Measured result on the real sample:

| | rows | compressed B/row | uncompressed B/row |
| --- | --- | --- | --- |
| company (csv1) | 18,605 | 733.6 | 2,513.7 |
| contact (csv2) | 19,524 | 200.4 | 660.9 |
| both | 38,129 | **460.6** | 1,565.0 |

**3,273 → 461 B/row (7.1x smaller).** For the complete corpus that projects to
≈4.3 GB (company) + ≈18.7 GB (contact) = **≈23 GB**, versus the 217 GB the old format
had already written for two-thirds of the rows.

### Disk requirement now

The preflight estimates from **source bytes × a measured per-source compression ratio**
(csv1 0.423, csv2 0.346; default 0.40), not from rows × an assumed row size. It prints the
**expected** and the **upper bound** (`max(ratio × 1.3, 0.52)` per source) and refuses on the
upper bound:

| term | full corpus |
| --- | --- |
| spool (expected / upper) | **23.02 GB / 33.71 GB** |
| raw-cache staging (largest source) | 54.04 GB (0 until the second source is opened) |
| index output (written during pass 2) | ~20 GB |
| bookkeeping | ≤0.26 GB |
| **decision total (upper × 1.25)** | **135.42 GB** |
| expected total (same terms, expected spool) | 122.04 GB |
| with `rawCacheDir: null` | **≈68 GB** |

That is a bounded high-water mark: the spool can only reach the ratio × input, and the
preflight refuses a volume that cannot hold it. Additionally `spoolMaxBytes` (CLI:
`--spool-max-gb`) is a hard ceiling: Pass 1 flushes and stops cleanly when it is reached,
leaving a resumable ledger — it can never fill the volume. On the failed machine (≈87 GB
free) a full run needs `"rawCacheDir": null`.

### Recovering the existing 66.3-million-row spool

`tools/indexer/src/spool-recover.ts`, CLI `recover-spool`. **Assessment is read-only** and
answers each question with evidence from the rows:

| question | evidence used |
| --- | --- |
| partition validity | each partition read with the byte-exact JSONL reader; a final unterminated record is reported with line/offset |
| JSON completeness | every record parsed; a failure is reported with its position |
| partition assignment | `partitionFor(row.partitionKey, partitions)` must equal the file's number |
| source identity | `row.source.source` must be one of the configured source ids |
| row sequence / continuation | `row.source.row` (source line number) is a unique identity |
| duplicates | a bitset per source; a repeated `(source,row)` is counted, not assumed |
| truncation | the reader refuses a file whose last record has no terminator |
| exact continuation | largest `N` such that rows 2..N are in the spool **or** `rejected.jsonl` |
| missing records | the first row in neither file: recovery refuses (`firstGap`) |
| convertibility | only if every source passes the prefix test is a schema derived and a v2 spool written |

`rejected.jsonl` is essential: a row with no company name is *read* but never spooled. Without
it every legitimate rejection would look like a lost record and a complete spool would be
refused. The union of the two files is the coverage evidence.

```powershell
# 1. assess (hours for 217 GB; reads only, writes nothing)
bun tools/indexer/src/cli.ts recover-spool --assess --work-dir .indexer-work --partitions 256

# 2. if the verdict is RECOVERABLE: convert into a NEW empty work directory
bun tools/indexer/src/cli.ts recover-spool --apply --config tools/indexer/indexer.config.json `
  --work-dir .indexer-work --target-work-dir .indexer-work-v2 `
  --complete-sources csv1

# 3. resume Pass 1 with the SAME config/version; it reads only the remainder
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --version v1-full-2026-10-17
```

`--complete-sources csv1` says the run's own log proves csv1 ended; without it csv1 is
re-read (and skipped row-by-row) rather than assumed complete. `--apply` refuses:

- a spool that is not `recoverable` (gap, truncation, wrong partition, unreadable record);
- a target directory that already contains anything;
- a target identity whose partition count differs from the assessment.

The legacy spool is opened for reading only. The conversion writes the compact spool
(~23 GB) beside it; the original 217 GB is left for you to delete in a separate, explicit
step **after** verifying the converted index.

**Verdict meanings**

| verdict | meaning |
| --- | --- |
| `recoverable` | every source is one contiguous prefix (spool ∪ rejected), no row unaccounted, partitions consistent; duplicates (if any) are provable and written once |
| `unusable` | a gap, a truncated record, an unparseable record, or a misplaced row — continuation cannot be proven |
| `already-v2` | nothing to recover; resume normally |
| `empty` | no partitions |

### What is still unverified without the real spool

The 66.3 M rows exist only on the Windows machine. In this workspace the recovery path is
tested against real legacy spools produced by the real indexer (complete, gapped,
duplicated, truncated, mis-partitioned, and a full convert → resume → byte-identical index
comparison). The **real** spool's verdict, its exact duplicate count and the duration of the
217 GB scan are unknown until `recover-spool --assess` runs there. No claim of successful
recovery is made here.

### Crash-safety guarantees (format v2)

| event | guarantee |
| --- | --- |
| power loss / kill at any point | the ledger names the last **flushed + fsynced** frame of each partition; on restart each partition and its ledger are truncated to exactly that byte, never further |
| crash between manifest and checkpoint | the manifest (written by rename, last) is the proof Pass 1 finished; the next run merges instead of rebuilding |
| disk full mid-frame | the partial frame is rolled back to the previous frame boundary; `SpoolDiskFullError` names the partition and the committed bytes; the ledger is unchanged |
| a frame's bytes change after the run | the frame's SHA-256 (and the partition's) fails and the merge refuses with its offset |
| a partition disappears | resume refuses (`missing from`) before truncating or writing anything |
| a source changed between attempts | identity mismatch (path/delimiter/override count/version/sample) stops the run with the differences listed |
| a second process starts on the same workDir | the second run sees the ledger and resumes; it does not append a parallel copy |

### Pass 2 with bounded storage

Pass 2 is unchanged in shape: it reads one hash partition at a time and holds only that
partition's company groups and pending contacts. With v2 it verifies each frame as it reads
it, then merges through the same `CompanyResolver` + Stage B association used for legacy
spools, so segmentation cannot change a decision. The merge still needs the whole spool on
disk (it is a single sequential pass over it), which is why the spool size, not the record
count, is the number the preflight guards.

## Verifying integrity

```powershell
bun tools/indexer/src/cli.ts validate --config tools/indexer/indexer.config.json --version v1
```

Re-hashes every generated object on disk and compares it with `objects.jsonl`. In the app,
**Dataset Management → Validate active manifest** calls `POST /api/dataset/validate`, which
re-reads the active version's manifest, directory, a sample of index shards and company
partitions, and reports object counts and any missing keys.

## Application data (saved leads, searches, settings)

- Layout: `app-data/leads/<partition>.json` + a small index object, `app-data/saved-searches.json`,
  `app-data/settings.json`, `app-data/activity.json`, `app-data/exports/<id>.{json,csv}`.
- Writes use **compare-and-set**: the object is read, mutated, and written with
  `onlyIf: { etagMatches }`. A failed precondition means another writer won the race; the
  mutation is re-run against fresh state (up to 3 attempts) and otherwise surfaced as a conflict
  instead of overwriting. Covered by `tests/worker-store.test.ts`, including a simulated
  concurrent tab.
- **Recovery snapshots**: before each lead shard mutation, the previous content is copied to
  `backups/app-data/<YYYY-MM-DD>/<label>.json` — at most one snapshot per object per day, so
  growth is bounded by (partitions × days). Snapshot failures never block the write.

### Restoring a lead shard by hand

```powershell
# 1. Find the snapshot
bunx wrangler r2 object list company-intel-data --prefix backups/app-data/
# 2. Download it
bunx wrangler r2 object get "company-intel-data/backups/app-data/2026-10-15/leads-012.json" --file leads-012.json
# 3. Inspect, then put it back over the live shard key
bunx wrangler r2 object put "company-intel-data/app-data/leads/012.json" --file leads-012.json
```

The lead index (`app-data/leads/index.json`, written by the same code path) is derived data: if
it ever disagrees with the shards, `listLeads()` simply returns fewer or more rows. It can be
rebuilt by re-saving affected leads through the API; nothing else depends on it.

### Consistency limits of an R2-only design (stated plainly)

- There are no transactions across objects. A lead write touches two objects (the shard and the
  index); if the process dies between them, the index count can drift by one. The lead itself is
  never lost, and the next write repairs the index.
- Last-writer-wins within a *single* object write is prevented by the ETag precondition, but two
  writes to *different* partitions are independent (and therefore safe).
- Browser caches are version-scoped, so a rollback or re-publish invalidates stale pages on the
  next request.

## Recovery checklist

| Symptom | Action |
| --- | --- |
| Search returns `503 dataset_unavailable` | No active version, or its directory is missing: check `/dataset`, then publish a validated version. |
| Search results look stale after a publish | Hard-reload once; confirmed case is a version-scoped cache — clear it from Settings → "Clear cached data". |
| A published version has bad data | Dataset Management → Activate the previous version, then re-index into a new version id. |
| Indexer crashed mid-run | Re-run the same command. Format v2 resumes Pass 1 from `spool/progress.json`; a completed Pass 1 is reused from `checkpoint.json` and `spool-manifest.json`. A crash inside pass 2 keeps the spool and resets that run's own partial pass-2 output before replaying. |
| `Refusing to start: … already holds N spool partition file(s)` | The spool has no ledger/checkpoint that proves what it contains. This is deliberate. Run `recover-spool --assess` (read-only); if it proves a contiguous prefix, `--apply` converts it into a new work directory. Only `--discard-spool` deletes it. |
| `--no-resume` stopped with "refusing to delete" | Expected. `--no-resume` now only means "ignore the checkpoint". Deleting is `--no-resume --discard-spool`, a separate deliberate act. |
| `JSON Parse error: Unterminated string` in pass 2 | A pre-fix build. The reader no longer splits on U+2028/U+2029, so the existing spool is still valid — inspect it and resume (the row below), or re-run with `--no-resume`. |
| `Refusing to merge: … has no spool-manifest.json` | Run `bun run index:spool-doctor`. If every partition reads `ok`, `bun run index:spool-doctor --repair-manifest` records the manifest (it writes nothing else) and the next run merges the existing spool with pass 1 skipped. If any partition is damaged, the doctor names it and `--no-resume` is the answer. |
| `Spool partition part-NNNN.jsonl is truncated` / `does not match the checksum` / `lost or gained records` | The spool cannot be trusted for that partition and nothing was merged for it. Nothing is deleted automatically (the previous pass-2 output for this version is left in place and is reset by the next successful start): inspect with `index:spool-doctor`, then re-run with `--no-resume`. Versions are separate directories and nothing was uploaded. |
| `workDir already holds a … for a different run` | Expected when the version, sample size, partition count or source paths changed: the spool belongs to the earlier run and resuming would mix two inputs. If the spool is correct and only the **output version** should change, use `pass2-from-spool` (next row) — it keeps the spool. Otherwise use `--no-resume --discard-spool`, or a separate `workDir`. Nothing was read or written before the stop. |
| You want a new version from an existing, verified Pass 1 spool (e.g. the association rules changed, nothing about the rows did) | `bun tools/indexer/src/cli.ts pass2-from-spool --config <cfg> --source-work-dir <source work dir> --work-dir <new dir> --output-dir <new dir> --version <new version>` (add `--check-only` to validate and stop). It checks the source checkpoint, the complete spool manifest, the source configuration/sample limit/partition count and every partition's length and SHA-256 before merging; it writes only to the isolated directories you name and has no upload/publish path. The source checkpoint, manifest, partitions, original index and `manifests/active.json` are untouched. **Never use `--no-resume` for this** — it deletes the spool. Re-running the command after an interruption restarts safely. |
| Upload partially completed | Re-run `run --upload`: existing objects are skipped, missing ones are uploaded. |
| Lead edits lost | Inspect `backups/app-data/<date>/` and restore the shard as shown above. |
| Access broken (401 on every request) | Confirm `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ALLOWED_EMAILS` secrets and that the Access application covers the hostname you are using. |
| Worker CPU errors on heavy fuzzy queries | See `docs/cost.md`; re-measure with `wrangler tail` before changing plans. |
