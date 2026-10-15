# Indexing (Windows, local, streaming)

The indexer turns the two raw CSV files into the versioned R2 objects the Worker reads. It
runs **on your machine**, never inside a Worker: 60 GB cannot be streamed in a Cloudflare
Worker, and the spec forbids a hosted database substitute.

- Files: `tools/indexer/src/{cli,csv,mapping,build,r2}.ts`
- Config: `tools/indexer/indexer.config.json`
- Runtime: Node 20+ or Bun. Only Node built-ins are used for CSV/disk work.

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

```powershell
# 1. Install dependencies once
bun install

# 2. Inspect both files: headers, fill rates, encoding, delimiter, mapping suggestions
bun tools/indexer/src/cli.ts profile --config tools/indexer/indexer.config.json

# 3. Sample runs (mandatory before the full job)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 10000    --version v1-sample-10k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 100000   --version v1-sample-100k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 1000000  --version v1-sample-1m

# 4. Full job, upload only after it validates (needs R2_* env vars)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --version v1 --upload

# 5. Re-verify what is on disk against its checksums
bun tools/indexer/src/cli.ts validate --config tools/indexer/indexer.config.json --version v1

# 6. Publish (flips manifests/active.json; requires --yes)
bun tools/indexer/src/cli.ts publish --config tools/indexer/indexer.config.json --version v1 --yes
```

`--sample <n>` applies per source, so both schemas are always represented in a sample run.
Sample versions are safe to upload to a `staging`/sample version id; the app ignores any
version that is not the active one.

## Coverage validation

Each run's manifest records, per source: rows read, rows rejected, companies and contacts
contributed — so you can prove both files contributed. It also reports unique companies,
unique contacts, duplicate rows resolved, ambiguous companies kept separate, records missing
a company identifier, and contact/company association errors. The Dataset Management page
displays the same numbers from the manifest and the dashboard charts come only from these
counts. **Nothing is fabricated:** before a first successful index the UI shows
"Dataset not indexed" rather than invented figures.

## Preflight report

`profile` and `run` both print the preflight block first:

```
Preflight
  ok   csv1  9.83 GB   D:/company-intel/raw/companies_part1.csv
  ok   csv2  49.1 GB   D:/company-intel/raw/companies_part2.csv
  input total          58.93 GB
  free disk            412.5 GB
  temporary space need 88.4 GB
  estimated output     12.1 GB
  memory free / total  21.4 GB / 32.0 GB
  cpu cores            12
  ! Less than 1 GB of free memory: ...
  rough duration hint  ~54 min at 120,000 rows/s (measure with a sample run)
```

The run refuses to start when temporary space is clearly insufficient. The duration figure is
an explicit hint, not a measurement — replace it with your own sample-run timing.

## Recommended sequence (approval gates included)

1. `profile` both files and confirm the canonical mapping (adjust `columns` if needed).
2. Run the 10k / 100k samples. Compare rejected-row counts and the "both sources contributed"
   numbers; check `/companies` in the app against a sample version.
3. Run a 1M-record sample and record wall-clock time, peak RAM, disk used, output size.
4. **STOP — approval gate.** Send me the measured numbers and ask for approval before the
   full 60 GB job (this is the "sample-first" requirement of the specification).
5. Full run with `--version v1 --upload`, then `validate`, then `publish`.
6. Verify in the app: `/dataset` shows the new active version, `/companies` returns results.

No paid service is enabled by any of these steps. Nothing is published until a version passes
validation.

## Resource guidance

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
| Columns mapped to the wrong canonical field | Add a `columns` override for that source (`{"companyname": "Org Name"}`). |
| High rejected-row count | Check the encoding/delimiter for that file; inspect `workDir/rejected.jsonl` reasons. |
| `Refusing to start: temporary space is insufficient` | Free space on the `workDir` volume, or lower `partitions`. |
| `R2 credentials are not set` on publish | Export `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` for the session. |
| Version uploaded but the app still shows the old data | `publish` was not run (or failed) — `manifests/active.json` still points at the previous version. |
