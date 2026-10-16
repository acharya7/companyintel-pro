# Phase G — full indexing execution plan (approval required)

**Status: PREPARED, NOT APPROVED, NOT STARTED.** Nothing in this document has been executed.
Filenames, byte sizes, schema mappings, durations and index sizes marked _awaiting Phase A_ can
only be filled in from the outputs listed in `docs/verification.md` → Phase A. Every number below
is either a **documented price**, a **measured sandbox figure**, or **clearly-labelled estimate**;
none of it is a claim about your data.

Bucket: `company-intel-data` · prefix `raw/` · target version `v1`.

## 1. Source files

| Source id | File | Size | Status |
| --- | --- | --- | --- |
| `csv1` | _awaiting Phase A listing_ | ≈ 10 GB (your statement) | Not verified — no R2 access from here |
| `csv2` | _awaiting Phase A listing_ | ≈ 50 GB (your statement) | Not verified — no R2 access from here |

`bun run verify:r2:remote --json` (read-only; **no S3 keys needed** — it uses your Wrangler login
and the same native `COMPANY_DATA` binding the app uses) lists `raw/` under a bound (≤ 25 objects
per page, largest first) with the exact keys and byte sizes, confirms presence + size + ETag for
each source, proves the body is readable with a 1 KB ranged GET, and adds both schema reports from
bounded 6 MB samples (encoding, delimiter, headers, fill rates, mapping suggestions with
confidence). It exits 1 when an expected object is missing, so it can gate the run. The S3-key
equivalents (`bun scripts/verify-raw.mjs --json`, `bun scripts/profile-raw.mjs --json`) remain
available. I will put the real names and sizes here verbatim once you send that output.

The indexer config now takes either mode:

- **Mode B (recommended here):** `"path": "r2://company-intel-data/raw/<key>.csv"` — the object is
  streamed in bounded 8 MiB ranged reads and cached once under `rawCacheDir`, so the run resumes
  from disk. Needs the three `R2_*` variables (Object Read is enough); Wrangler's login cannot be
  used by a local script, which is exactly why the probe and the deployed Worker need no keys while
  this mode does. Estimated network: ~60 GB once; local cache ~60 GB (set `"rawCacheDir": null` to
  skip it); ~7,500 ranged GETs.
- **Mode A:** copy the objects down with `rclone copy r2:company-intel-data/raw/ ./raw-copy` and
  point `path` at the local files. Identical pipeline, same output.

## 2. Confirmed schema mappings

Confirmation happens in two steps: `profile` (prints headers, fill rates, encoding, delimiter and
the suggested canonical mapping **per file, independently**) → your report → any `columns`
override added to `indexer.config.json`. Canonical fields are:

`companyName, website, domain, companyLinkedin, industry, companySize, companyCity,
companyState, companyCountry, contactName, jobTitle, department, seniority, email, phone,
contactLinkedin, address, revenue`

| Source | Company-name field | Website/domain | Contact name | Job title | Email | LinkedIn | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `csv1` | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | Not confirmed |
| `csv2` | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | _awaiting_ | Not confirmed |

What is already proven is the **mechanism**, not your columns: `tests/e2e-index.test.ts` indexes
two files with entirely different header sets (`Company Name/Website/Contact Name/Job Title` vs
`organization/domain/full_name/designation/work_email/linkedin_profile`) in one run, keeps both
contributions in the manifest, and resolves them into one company/contact model. The same test
covers multiline quoted titles, embedded commas/quotes, and cross-file association.

Mapping corrections are expected in exactly these areas (all handled by the existing pipeline,
listed so you know what to look for in the report): missing company identifier for a row style,
contact-only rows, country name vs ISO code, and a legal-suffix-only difference in company names.

## 3. Commands (macOS zsh or PowerShell, from the repository root)

```bash
bun install

# Step 0 — read-only verification of the real bucket. Needs NO credentials:
# your Wrangler login plus the native COMPANY_DATA binding (remote = true).
bun run verify:r2:remote --json > raw-verification.json

# Credentials below are needed only for Mode B reads and for upload/publish —
# session-scoped, never committed, never pasted in chat (macOS shown; PowerShell
# equivalent: $env:R2_ACCOUNT_ID="..."):
export R2_ACCOUNT_ID="..."; export R2_ACCESS_KEY_ID="..."; export R2_SECRET_ACCESS_KEY="..."

# A. Write the real file paths / column overrides into the config, then:
bun tools/indexer/src/cli.ts profile --config tools/indexer/indexer.config.json

# B. Sample runs (per source; mandatory before the full job)
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 10000   --version v1-sample-10k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 100000  --version v1-sample-100k
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 1000000 --version v1-sample-1m

# C. FULL JOB — only after explicit approval
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --version v1 --upload

# D. Verify, then publish (publish flips manifests/active.json; requires --yes)
bun tools/indexer/src/cli.ts validate  --config tools/indexer/indexer.config.json --version v1
bun tools/indexer/src/cli.ts publish   --config tools/indexer/indexer.config.json --version v1 --yes
```

## 4. Resources

| Resource | Requirement | Basis |
| --- | --- | --- |
| RAM | 16 GB comfortable, 8 GB workable | Bounded one-partition-at-a-time design; measured 1.25 s / 102 MB heap to build a 50,000-company index in-process. Less RAM costs speed, not correctness |
| Free disk | **182 GB** (spool 71.06 + Mode B staging 54.04 + index 20.30 + bookkeeping 0.27, ×1.25) — **93.6 GB** with `"rawCacheDir": null` | `bun run index:profile` preflight against the real bucket. The staging file and the generated index are alive at the same time as the spool. `workDir` must be on the fastest disk; `"rawCacheDir": null` removes the largest single term and costs a re-download on resume |
| Cores | 4+ | One run saturates ~1 core for CSV parsing plus I/O; never run two full jobs at once |
| Network | Steady upload | Upload is per-object with retry and skips objects already in R2, so a dropped connection costs time, not a restart |

Preflight **refuses to start** if temporary space is clearly insufficient and warns on low memory.

## 5. Duration

Formula (replace with your measurements):

```
total ≈ (rows ÷ measured_rows_per_second) × pass_factor + upload_time
```

- **Measured, first real benchmark (1 M sample per source):** pass 1 processed 1,986,239 rows at
  **≈5,015 rows/s** end to end (R2 ranged GET + TSV parse + JSON serialization + partition writes),
  and the run's own `stage timings` block is where that number comes from.
- The preflight hint now uses exactly that rate, so for the full corpus (≈101.5 M rows at the
  measured 633 B/row) it prints **≈5.6 hours of pass 1** — not the ~54 minutes a 120,000 rows/s
  synthetic figure suggested.
- **Pass 2 is not free and must be added:** a 20,200-row local stress run measured 18.6 s in
  `pass2-merge` on this 1-vCPU sandbox (shard postings + gzip). Scale it from the 1 M benchmark's
  own `pass 2 merge` figure rather than from this line.
- Upload duration ≈ (object count ÷ practical PUT concurrency) + retries; object count is in the
  low thousands, so this is minutes, not hours, at normal bandwidth.
- Upload duration ≈ (object count ÷ practical PUT concurrency) + retries; object count is in the
  low thousands, so this is minutes, not hours, at normal bandwidth.

## 6. Generated index size and cost

| Object class | Estimate | Monthly |
| --- | --- | --- |
| `raw/` originals (given) | 60 GB | $0.90 |
| `indexes/` + `companies/` + `contacts/` | **8–20 GB** (_awaiting measurement_; extrapolate from the 1 M sample's bytes/company) | $0.12–$0.30 |
| `app-data/` + `backups/` | < 0.1 GB | ≈ $0 |
| **Total** | | **≈ $1.00–$1.20/month** |

R2 Class B reads: 100–1,000 searches/day ⇒ 60k–600k operations/month, **$0** inside the 10 M free
allowance. Class A: a few thousand PUTs once per version, **$0** inside the 1 M free allowance.
Egress is free. Workers Free: 100,000 requests/day and 10 ms CPU per request — the median query is
well inside that; the heaviest fuzzy queries measured ~10 ms p95 on the sandbox, which is the one
figure that needs production measurement before you can rely on the Free plan.

Full detail and the pricing sources: `docs/cost.md`.

## 7. Checkpoint, recovery and rollback configuration

- `partitions: 256` (keep it — it sets the working set and the number of spool files).
- `workDir: .indexer-work` on the fastest local disk; `checkpoint.json` records the completed
  stage *and the run identity* (version, sample limit, partitions, sources) and
  `spool-manifest.json` records every partition pass 1 finished (bytes, records, SHA-256), so an
  interrupted run resumes instead of restarting **and** a partition that was never completed cannot
  be merged as if it had been. `--no-resume` forces a clean start (clearing the stale spool and its
  manifest). Give the 1 M benchmark its own `workDir` if you want to keep the full run's spool
  around — a checkpoint for a different run is refused rather than merged.
- After any failed run, `bun run index:spool-doctor` reports the state of the spool (read-only,
  positions only) and `--repair-manifest` adopts an intact spool so pass 1 does not have to run
  again; see `docs/recovery.md`.
- Rejected rows are never dropped: inspect `workDir/rejected.jsonl` (`{source, line, reason}`).
- Upload is idempotent (existing objects are skipped), so `run --upload` can be repeated safely.
- Publish is a single pointer write. **Keep one previous version** in R2 — the pointer now records
  `previousVersion`, so rollback is one flip, not a re-index. Never delete the active version.
- `backups/app-data/<date>/…` snapshots leads/saved-searches/settings before mutations; restore
  steps are in `docs/recovery.md`.

## 8. Validation steps after indexing

1. `validate` reports every generated object re-hashed with matching checksums and counts.
2. `manifests/<version>.json`: check **per-source** rows read, rows rejected, companies and
   contacts contributed — both sources must be non-zero.
3. Check the reported ambiguous-companies-kept-separate and association-error counters.
4. `publish`, then open `/dataset`: the new version shows as active with its counts.
5. Spot-check in the app: a company present in **both** files returns all of both files' contacts
   and nothing from a same-named company with a different domain; a fuzzy misspelling resolves; a
   CSV export of those contacts has every row.
6. Confirm the previous version still lists in `/dataset` and that rollback is available.

## 9. Exact actions I need from you

1. In your own terminal: `cd <the repository folder>` then
   `bun run verify:r2:remote --json > raw-verification.json`, and send that file (object keys,
   sizes, ETags, timestamps, headers, fill rates, mappings, dataset state — no secrets and no cell
   values). No R2 credentials are required for this step. If auto-selection picks the wrong two
   objects, re-run with `--keys raw/<file1>.csv,raw/<file2>.csv`.
2. Put the two exact keys into `tools/indexer/indexer.config.json` (`r2://…`, Mode B) and export the
   three `R2_*` variables in that shell only.
3. Paste the two recommended `columns` blocks (or confirm "no override needed").
4. Run the 10 k and 100 k sample runs (`run --sample …`); send the counters, including the per-source
   breakdown and rejected-row counts.
5. Run the 1 M sample; send wall-clock time, peak RAM, disk used, output size, object count — and
   the cache directory size for Mode B.
6. Send those numbers and ask for approval.

I will then fill in sections 1, 2, 5 and 6 with real values and hand back the final command list.
**No full 60 GB run, no production deployment and no paid plan will be started by me without that
explicit approval.**
