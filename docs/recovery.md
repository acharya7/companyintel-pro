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

| Failure | Behaviour |
| --- | --- |
| Interrupted during pass 1 (CSV streaming) | `workDir/checkpoint.json` records the stage **and the run it belongs to** (version, sample limit, partitions, source paths/delimiters/overrides); re-running the same command resumes and re-does only what was not completed. A different command against the same `workDir` stops with the differences listed instead of merging two spools — see the row below. |
| Interrupted during pass 2 | Pass 1 spool files are reused; the partition loop restarts (bounded by partition count). The checkpoint is only written after every partition stream has been flushed **and** `workDir/spool-manifest.json` has been written by rename, so "pass 1 finished" is a recorded fact rather than an assumption. |
| A partition file is short, malformed or changed after pass 1 wrote it | Pass 2 verifies each partition (length before reading, record count and SHA-256 while merging) and **refuses to merge it**, naming the file and the byte counts. A truncated partition would otherwise merge as a shorter, silently lossy index. Re-run with `--no-resume` after inspecting. |
| A spool exists but has no manifest (written by a build older than the manifest) | Pass 2 refuses with `no spool-manifest.json` rather than merging unverified partitions. `bun run index:spool-doctor` reports the state and `--repair-manifest` records a manifest **only if every partition verifies**, which is how an existing Pass 1 result is reused instead of re-streaming the sources. |
| Network failure during upload | Objects are uploaded individually with retries and exponential backoff; already-uploaded objects are skipped, so a re-run is idempotent. |
| Bad rows | Never silently dropped: written to `workDir/rejected.jsonl` with source, line number, reason and the first fields. Counts appear in the manifest and on the Dataset page. |
| Checksum mismatch | `validate` reports the object and exits non-zero; the version is not publishable. |
| Insufficient temporary space | Preflight refuses to start rather than half-producing a version. |

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
| Indexer crashed mid-run | Re-run the same command; it resumes from `workDir/checkpoint.json` (use `--no-resume` to start clean, which also clears the stale spool in `workDir/spool/` and its manifest). |
| `JSON Parse error: Unterminated string` in pass 2 | A pre-fix build. The reader no longer splits on U+2028/U+2029, so the existing spool is still valid — inspect it and resume (the row below), or re-run with `--no-resume`. |
| `Refusing to merge: … has no spool-manifest.json` | Run `bun run index:spool-doctor`. If every partition reads `ok`, `bun run index:spool-doctor --repair-manifest` records the manifest (it writes nothing else) and the next run merges the existing spool with pass 1 skipped. If any partition is damaged, the doctor names it and `--no-resume` is the answer. |
| `Spool partition part-NNNN.jsonl is truncated` / `does not match the checksum` / `lost or gained records` | The spool cannot be trusted for that partition and nothing was merged for it. Nothing is deleted automatically: inspect with `index:spool-doctor`, then re-run with `--no-resume`. Pass-2 output already written is left in place; versions are separate directories and nothing was uploaded. |
| `workDir already holds a checkpoint for a different run` | Expected when the version, sample size, partition count or source paths changed: the spool belongs to the earlier run and resuming would mix two inputs. Re-run with `--no-resume`, or use a separate `workDir`. Nothing was read or written before the stop. |
| Upload partially completed | Re-run `run --upload`: existing objects are skipped, missing ones are uploaded. |
| Lead edits lost | Inspect `backups/app-data/<date>/` and restore the shard as shown above. |
| Access broken (401 on every request) | Confirm `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ALLOWED_EMAILS` secrets and that the Access application covers the hostname you are using. |
| Worker CPU errors on heavy fuzzy queries | See `docs/cost.md`; re-measure with `wrangler tail` before changing plans. |
