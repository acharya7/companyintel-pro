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

`bun scripts/profile-raw.mjs --list` prints the exact names and byte sizes, and
`bun scripts/verify-raw.mjs --keys <real keys>` confirms presence, size and ETag for each original
(it exits non-zero when an expected object is missing, so it can gate the run). I will put the
real names and sizes here verbatim once you send that output. The indexer config
`sources[].path` must point at the real local paths (it reads local files; `raw/` objects can be
downloaded once with `bunx wrangler r2 object get` if you prefer to keep them in R2 only).

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

## 3. Commands (PowerShell, from the repository root)

```powershell
bun install

# Credentials for upload/publish only — session-scoped, never committed
$env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="..."; $env:R2_SECRET_ACCESS_KEY="..."

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
| Free disk | **≥ 120 GB** recommended | Spool ≈ 1.5 × input (≈ 88 GB at 60 GB input) + output ≈ 12 GB (estimate). `workDir` must be on the fastest disk; keep the two on the same volume only if it has the room |
| Cores | 4+ | One run saturates ~1 core for CSV parsing plus I/O; never run two full jobs at once |
| Network | Steady upload | Upload is per-object with retry and skips objects already in R2, so a dropped connection costs time, not a restart |

Preflight **refuses to start** if temporary space is clearly insufficient and warns on low memory.

## 5. Duration

Formula (replace with your measurements):

```
total ≈ (rows ÷ measured_rows_per_second) × pass_factor + upload_time
```

- Rough hint from preflight: ~120,000 rows/s → ~54 min for a 60 GB parse, assuming ~110 M rows.
- _Awaiting Phase A:_ real row counts, real bytes, real rows/s from the 1 M sample run.
- Realistic planning range for the full job including pass 2, hashing, and upload:
  **2–6 hours**, dominated by JSON spooling and R2 PUTs.
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
  stage, so an interrupted run resumes instead of restarting. `--no-resume` forces a clean start.
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

1. Set the three R2 environment variables in your own PowerShell session (never in chat).
2. Run `bun scripts/profile-raw.mjs --list` and send the listing (names, sizes, timestamps).
3. Run `bun scripts/verify-raw.mjs --keys raw/<file1>.csv,raw/<file2>.csv` (alias: `bun run verify:r2`)
   and send its output.
4. Run `bun scripts/profile-raw.mjs` and send **both** schema reports.
5. Paste the two recommended `columns` blocks (or confirm "no override needed").
6. Run the 10 k and 100 k sample runs; send the counters.
7. Run the 1 M sample; send wall-clock time, peak RAM, disk used, output size, object count.
8. Send those numbers and ask for approval.

I will then fill in sections 1, 2, 5 and 6 with real values and hand back the final command list.
**No full 60 GB run, no production deployment and no paid plan will be started by me without that
explicit approval.**
