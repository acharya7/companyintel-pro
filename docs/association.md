# Company ↔ contact association

How CompanyIntel decides which company a person works for, what it is allowed to
claim, and what it does when the evidence does not settle the question.

This document covers the rules, the on-disk consequences (index format v3), how to
re-run the association stage on the **existing** Pass 1 spool without re-ingesting
anything, and how to build an experimental benchmark without touching the
validated `v1-bench-1m` output.

---

## 1. Why the join needed to change

Pass 1 spools every source row with a *claimed* company (the company name that row
carried) plus whatever company identifiers the row itself had. Pass 2 then used to
answer one question — "which company record does this row's name resolve to?" —
and immediately attach the contact to that record. Three defects followed from
that, all reproduced by tests before being fixed:

| # | Confirmed defect | Where | Regression test |
| --- | --- | --- | --- |
| 1 | **Identifier ownership could be reassigned.** `register()` called `index.set(key, entry)` for every key of every row, so a later row could take a domain (or LinkedIn page, or source id) away from the record that carried it first. Every row holding that key then resolved to the new record, and which company a domain pointed at depended on file order. | `tools/indexer/src/mapping.ts` → `CompanyResolver.register/claim` | `tests/indexer-association.test.ts` → "the owner of a domain does not change when a later row contradicts it" |
| 2 | **A self-contradicting row looked like a verified company.** A row carrying two unrelated strong identifiers created a record whose keys had all been refused, yet the record was marked `strong` from what the row *carried*, so later rules treated it as an employer with verified identity. | same | "a contradicting row creates its own record and claims nothing that is taken" |
| 3 | **Contacts were attached with no separate evidence step.** A normalized-name match was the whole decision, so a person could be attached to any company sharing the name, including a placeholder that carries nothing but the name. | `tools/indexer/src/build.ts` (pass 2) | "companies with one name and different domains stay separate", `tests/association.test.ts` |
| 4 | Repeated self-contradicting rows created one empty company **per row** (unbounded on a real file). | `CompanyResolver` | "a repeated contradicting pattern joins one record instead of creating one per row" |

One measurement consequence worth knowing before reading a run report: `identifierConflicts` counts
only **strong** refusals (`d:` / `l:` / `s:`). Every namesake record "claims" the shared `n:` name
key, and counting those would report tens of thousands of meaningless conflicts on real data
(measured in `tests/indexer-association.test.ts`: 5,000 same-name rows with their own domains report
**0** conflicts, while 1,000 rows that really do re-claim two owned strong identifiers report
**2,000**).

Two hypotheses that the audit raised are **not** confirmed defects, and the rules
below are deliberately written so they cannot become one:

- a corporate email domain that matches no company of the family is not proof of a
  different employer (contractors, subsidiaries, rebrands) — it is recorded as a
  contradiction, not used to relocate the contact;
- a country difference is not evidence of the wrong employer (people work away
  from headquarters) — it only becomes evidence when it singles out *another*
  company of the same name, and even then it flags rather than relocates.

The real-data audit numbers (962,768 contacts: 44.5% "confirmed", 42.5% plausible,
3.1% unresolved, 9.9% conflicting, under evidence available *in the index*) are the
baseline this work is measured against. They were never employment ground truth.

---

## 2. Stage A — company identity resolution

One resolver per spool partition, so its maps stay bounded no matter how large the
dataset is. Keys are prefixed by kind:

| Key | Meaning | Scope |
| --- | --- | --- |
| `d:<host>` | corporate domain (from domain *or* website) | global |
| `l:linkedin.com/company/<slug>` | company LinkedIn page | global |
| `s:<source>:<id>` | source organization identifier | **scoped to its source file** — `s:csv1:123` and `s:csv2:123` are different companies |
| `n:<normalized name>` | normalized company name | weak evidence, never sufficient alone |

Rules, in the order the resolver applies them:

1. **Strong evidence decides first.** If exactly one record owns a strong key of
   the row (domain / LinkedIn / scoped source id), the row joins that record.
   Name similarity is never consulted when that happens.
2. **First owner wins, permanently.** `claim()` never reassigns a key. A refused
   claim of a *strong* identifier is counted (`identifierConflicts`) and sampled
   (bounded, 32 entries), and the run reports the count. Refusals of the shared
   `n:` name key are not counted: every namesake "claims" it, and counting those
   would drown the signal the number exists for. Replaying the same rows can never
   move a key.
3. **Contradictory rows get their own record, keyed by evidence.** A row whose
   keys point at two different records creates a record whose identity is the
   *evidence pattern* (`normalized name + sorted strong keys`), so every later row
   with the same pattern joins it instead of creating another empty company. Such
   a record reports `identityClaimed: false` and `strong: false`.
4. **A name-only row joins a name-only record of the same name** — never a record
   that already owns strong identifiers. `strong` is computed from what the record
   *owns*, not from what its row carried.
5. **Ambiguity is recorded, not resolved.** Every company in a normalized-name
   family with more than one member is flagged `ambiguous`, which is what the
   interface reports as "kept apart".
6. **Canonical id:** the strongest owned key, preferred `d:` → `l:` → `s:` → `n:`.
   Deterministic across runs, identical between a sample run and the full run.

Because partitions are hashed by normalized name, two records of one name always
land in the same partition — which is what makes Stage B able to compare them.
The known trade-off: rows for one company whose names normalize differently *and*
which share no identifier land in different partitions and stay separate. That is
visible and correctable; silently merging millions of people is not.

---

## 3. Stage B — associating contacts

Stage B runs after every company record of the partition exists. For each contact
row it collects the **credible** members of the claimed name family (records that
own identity; name-only placeholders are excluded *unless the whole family is
placeholders*), and decides with `associateContact()` in
`src/shared/association.ts`. The function is pure, order-independent, and never
returns a confidence percentage — nothing here is calibrated against employment
ground truth.

### What counts as evidence

| Evidence | Strength | Notes |
| --- | --- | --- |
| The source row itself carried the employer's identity (`claimedIdentity`) | strong, record-provided | The row's own domain / LinkedIn / scoped source id is owned by the record it resolved to |
| Contact email domain equals a candidate's domain | strong (independent) | Exact host first, then a parent/branch host (`mail.acme.com` under `acme.com`) only if no exact match exists |
| Contact email domain equals another candidate's domain | strong, reassignment | This is the one case that *moves* a contact |
| Country matches exactly one candidate | weak, supporting or flagging | Supports the claim (plausible) or flags it (conflict). Never relocates on its own |
| Unique name in the family | weak | Nothing to confuse it with → plausible, never verified |

Explicitly **not** evidence: a public mailbox provider (gmail, yahoo, outlook, …);
name similarity or a shared normalized name; dataset order; a person's own
LinkedIn URL; a country difference on its own; the number of contacts a company
already has.

### The four categories

| Category | Exact criteria | UI label |
| --- | --- | --- |
| `high_confidence` | The row's identity is owned by the assigned record, and no email-domain evidence contradicts it (`row_carries_employer_identity`); **or** the contact's email domain matches exactly one candidate, and that candidate is the one assigned (`email_domain_matches_assigned_company`, `email_domain_matches_other_company_of_same_name`). | Verified evidence |
| `plausible` | No strong evidence, but one candidate is consistent: unique name (`unique_name`), country evidence fits the assigned company (`country_supports_assigned_company`), exactly one credible candidate exists (`single_strong_candidate`), or the whole family is name-only (`no_credible_candidate`). | Possible match |
| `unresolved` | Several credible candidates remain and nothing separates them (`several_candidates_remain`). The contact is **not attached** to any company. | Employer unresolved |
| `conflicting` | Positive evidence points away from the assigned company: a corporate domain belongs to another member of the family (`email_domain_conflicts_with_row_identity`), the domain matches no member while the family has domains (`email_domain_outside_name_family`), or the country identifies another member (`country_points_to_other_company_of_same_name`). Attached and displayed as disputed — never as a verified employee. | Disputed employer |

Every verdict stores its `reason`, the `evidence` it used (`name`, `domain`,
`country`, `rowIdentity`, candidate count) and, where relevant, the candidate
company ids. `movedFrom` records the company id a reassigned contact came from.

`src/shared/association.ts` holds the single source of truth for labels and hints,
so the Worker, the preview adapter and the React pages cannot disagree.

---

## 4. Preserving unresolved contacts

A contact is never dropped because its employer cannot be identified.

- Format v3 writes one `unassigned/<version>/<partition>.json.gz` object per spool
  partition. The partition is derived from **the claimed normalized name**
  (`spoolPartitionOfNormalizedName`), so the reader can locate the object from a
  company record alone — no listing, no R2 search.
- Each preserved contact keeps its contact details, `source` provenance, the
  category and reason, a bounded sample of candidate company ids
  (`MAX_CANDIDATE_IDS` = 8) plus `candidateCount` with the real number, and
  `claimedCompanyName` / `claimedNormalizedName` exactly as the source row carried
  them. `companyId` is `""` and its `p_…` id is derived from the contact's own
  fingerprint, never from a company (a company-scoped id would fabricate an
  employer). The cap matters: a name shared by 1,000 companies used to store 1,000
  ids on every preserved contact (measured below).
- **Where to review them:** the company profile's "Employer unresolved" panel
  (`GET /api/companies/:id/unassigned`), which lists preserved contacts that named
  this company and the number of candidates that remained; the Contacts page
  filters by association category; `bun run index:audit` reports the aggregate
  counts by category and reason.
- Preserved contacts are **not** members of the company: they do not enter
  `contactCount`, facets, contact search or saved-lead resolution as employees.

---

## 5. Deduplication and identifiers

- Duplicate detection happens **after** the association decision, keyed by the
  final company id: email, then LinkedIn URL, then name + title within that
  company. Two rows for the same person that used to be deduplicated per *claimed*
  company can no longer survive twice after reassignment, and two different people
  with the same name and different titles stay separate.
- Preserved contacts use the same fingerprint idea scoped to the *claimed* name,
  so the same person cannot appear twice in the review list either, and a row
  without any fingerprint falls back to its source row reference (never dropped).
- Contact ids are `p_` + a hash of the final company id + the fingerprint.
  Reassignment therefore recalculates the id — which is required, because the id
  is what saved leads and exports reference — and the audit's reconciliation
  reports any id that occurs twice across the version.
- `duplicateRowsResolved` versus `uniqueContacts` is the duplicate-versus-preserved
  reconciliation: every input contact row is either a unique stored contact or a
  counted duplicate, never silently absent.

---

## 6. Index format v3 (and v2 compatibility)

`INDEX_FORMAT_VERSION = 3`. What changed from v2, all additive:

| Object | v2 | v3 |
| --- | --- | --- |
| `contacts/<version>/…` | contact rows | contact rows **+ `association`** (`category`, `reason`, `evidence`, candidates, `movedFrom`) |
| `companies/<version>/…` | company rows | **+ `associations`** (`highConfidence`, `plausible`, `conflicting`, `total`) |
| `unassigned/<version>/…` | — | preserved contacts, one object per spool partition |
| `indexes/<version>/directory.json` | — | `formatVersion: 3`, `shards.spoolPartitions`, `unassigned: {objects, contacts}`, `bytes.unassigned` |

`SUPPORTED_INDEX_FORMAT_VERSIONS = [2, 3]`: a v2 index stays readable and stays a
valid dataset version. A missing category is treated as *not classified* (never as
verified), a missing `unassigned` prefix as *nothing preserved*, and the
association filter is inert for v2 contacts rather than returning nothing.

Worker API, search, pagination, saved leads and caching are unchanged in shape;
the association category is an optional field, so an old frontend and a new index
still work together.

---

## 7. Reusing the existing Pass 1 spool (no re-ingestion)

**Conclusion: yes — the existing Windows Pass 1 spool is sufficient.** All Stage
A/B corrections run in Pass 2 from data the spool already holds:

| What Stage B needs | In the spool record? |
| --- | --- |
| claimed company name + normalized name | yes (`n.name`, `keys`) |
| company domain / website / LinkedIn / scoped source id | yes (company input + keys) |
| contact email (for the domain), country, state, city | yes (contact input) |
| source id and row number (provenance) | yes |
| company country / state / city | yes (company input) |

No field the association rules use is missing, so no source column has to be
re-read and no partition scheme changes. What *does* change is the **output
dataset version**, and that is exactly why the plain `run` command cannot do this
rebuild — see below.

### Source run identity vs. output version (why a dedicated command exists)

A run identity deliberately includes the dataset version, because the spool in a
work directory belongs to the run that wrote it. So on the preserved benchmark:

- `run --version v1-bench-1m-assoc` **stops** with
  `workDir already holds a checkpoint for a different run: version v1-bench-1m →
  v1-bench-1m-assoc` — correct, but not the operation you want;
- `run --no-resume` would **delete `workDir/spool/part-*.jsonl`** and re-read the
  64 GB from R2 — destroying the artifact this exercise is meant to preserve.

`pass2-from-spool` is the explicit third option. Only this command separates the
two concepts:

| Concept | Where it lives | What this command does |
| --- | --- | --- |
| **Source run identity** | `checkpoint.json` + `spool-manifest.json` in the source work dir | validates it as recorded; never rewrites, renames or deletes it |
| **Output index version** | `--version` | a new value; Pass 2 writes objects/manifests under it |

Ordinary `run`/resume keeps the strict, version-inclusive check
(`tests/indexer-spool-import.test.ts` asserts that a version or sample-limit
change is still refused).

### Windows PowerShell — verifying the change on the preserved benchmark

Do this on the machine that holds the completed `v1-bench-1m` spool. It builds an
**experimental** version into new directories; `v1-bench-1m`, its spool and
`manifests/active.json` are never opened for writing.

```powershell
cd C:\path\to\companyintel-pro
git pull
bun install
bun run check                       # typechecks + full test suite
bun run index:spool-doctor          # read-only: confirms the spool is clean

# Audit the EXISTING validated index first (this is the "before" number):
bun run index:audit -- --version v1-bench-1m
bun run index:audit -- --version v1-bench-1m --json > audit-before.json

# 1. Validate the recorded source run and hash every partition, then STOP.
#    Writes only the isolated bookkeeping in .indexer-work-v1-bench-1m-assoc.
bun tools/indexer/src/cli.ts pass2-from-spool `
  --config tools/indexer/indexer.config.json `
  --source-work-dir .indexer-work `
  --work-dir .indexer-work-v1-bench-1m-assoc `
  --output-dir .indexer-output-assoc `
  --version v1-bench-1m-assoc `
  --expect-sample 1000000 `
  --check-only

# 2. The same command without --check-only performs the merge (pass 1 and the
#    sources are skipped). `bun run index:benchmark-1m-assoc` is this same call.
bun tools/indexer/src/cli.ts pass2-from-spool `
  --config tools/indexer/indexer.config.json `
  --source-work-dir .indexer-work `
  --work-dir .indexer-work-v1-bench-1m-assoc `
  --output-dir .indexer-output-assoc `
  --version v1-bench-1m-assoc `
  --expect-sample 1000000

# Audit the experimental index (the "after" number, same evidence).
# Note --dir: the experimental index deliberately lives outside .indexer-output.
bun run index:audit -- --dir .indexer-output-assoc --version v1-bench-1m-assoc
bun run index:audit -- --dir .indexer-output-assoc --version v1-bench-1m-assoc --json > audit-after.json
```

**Validated before anything is merged** (all read-only):

- the source `checkpoint.json` exists, parses, records stage `pass2-merge` and a
  run identity, and its version is different from `--version`;
- `spool-manifest.json` exists, is marked complete, describes the same run as the
  checkpoint, its totals add up, and the partition files on disk are exactly its
  list (none missing, none extra, unique partition numbers);
- the configuration matches the source run except the version: source ids, paths,
  delimiters and column-override counts, partition count, and the sample limit
  (`--expect-sample` asserts it — `1000000` here; omit it to accept the recorded
  value);
- every partition's byte length matches, and on a first import every SHA-256
  matches. A **restart** re-checks lengths and leaves the content check to the
  merge, which re-hashes each partition as it reads it (so a restart does not
  re-read the whole spool just to reach the same place).

**Never written**: the source checkpoint, `spool-manifest.json`, every
`spool/part-*.jsonl`, the source output directory (including `objects.jsonl`) and
`manifests/active.json`. There is no upload or publish path from this command, and
`--upload` is refused. Isolation is enforced, not advisory: `--work-dir` may not be
the source work dir or contain/be contained by it, and `--output-dir` may not be
the config's output dir or sit inside/around it.

What to expect on the screen: `pass 2: experimental rebuild — merging the verified
Pass 1 spool in … the sources are NOT read and the source spool is not written.`,
then the new `association  N high confidence, M plausible, K conflicting, U
preserved without an employer` and `association moves …` lines, `stage timings …
pass 1 0.0 s (skipped)`, `source reads 0 request(s)`, and finally
`Nothing was uploaded, nothing was published, and manifests/active.json was not
written.` A resumed/restarted experimental run prints the same thing after its
reset line.

**Interruption**: re-run the same command. The experimental workspace records the
source checkpoint/manifest SHA-256, output version and output directory; the run
refuses to adopt it if any of those changed, and otherwise resets its own shards and
this version's objects before replaying from partition 1 — no duplicate postings and
no stale objects (asserted by killing the real process mid-merge in
`tests/indexer-spool-import.test.ts`).

Compare the two audit JSON reports on the fields:

- `associations.stored.byCategory` — the categories actually written;
- `preserved.total` — contacts kept without an employer;
- `associations.stored.moved` — reassignments between same-name companies;
- `reconciliation.contactCount.mismatched`, `…associations.mismatched`,
  `…facets.mismatched`, `ids.duplicated` — must all be `0`;
- `manifestCounters.uniqueContacts` versus
  `reconciliation.attached + reconciliation.preserved` — must be equal.

`pass 1` output is not rebuilt, so its duration must be `0.0 s (skipped)`; if it
is not, the spool was rejected (see `docs/recovery.md`) and you are re-ingesting —
stop and read the message rather than accepting the cost.

### Keeping the two runs apart

- The experimental version has a **different `datasetVersion`**, so `companies/`,
  `contacts/`, `indexes/`, `unassigned/` and `manifests/` all live under their own
  prefix — and here, in their own `--output-dir` as well.
- The experimental **work directory** (`.indexer-work-v1-bench-1m-assoc`) holds
  only this import's bookkeeping (`experimental-import.json`, the derived
  `spool-manifest.json` and `checkpoint.json`) plus its `shards/`. It never holds
  spool partitions: the rows stay in the source work dir, opened read-only.
- `manifests/active.json` is untouched: nothing is published, and the app keeps
  serving `v1-bench-1m` until you explicitly publish a version from the output
  directory the app actually reads.
- `--work-dir`/`--output-dir` default to siblings of the source directories
  (`<work-dir>-<version>`, `<output-dir>-<version>`), so a no-flag run is already
  isolated; passing them explicitly (as above) makes the isolation visible in the
  command you keep.
- Never pass `--upload` for the experimental version, and never `publish` it: the
  validated baseline stays active until you approve the upgrade.

---

## 7b. Measured cost of the association stage

All numbers below are synthetic, measured on a 1-vCPU Linux sandbox with the real code paths
(`bun run index:bench-assoc` and `bun run index:bench-pass2`). Re-run them on the machine that
runs the indexer; they are evidence, not a prediction for the 64 GB corpus.

### The adversarial corpus: one name, many companies

`bun run index:bench-assoc --companies N --contacts M` builds N organizations with the *same*
normalized name and one unique domain each, and M contacts whose claimed name is that same name:
a third carry a corporate address that names one company (evidence, and typically a reassignment),
a third carry a personal address (not evidence), a third carry nothing but a country every
candidate shares (undecided).

| Corpus | Outcome (the run's own counters) | pass 2 merge | contacts/s | RSS during the run |
| --- | --- | --- | --- | --- |
| 500 companies / 5,000 contacts | 1,667 high confidence, 3,333 preserved, 1,663 moved | **0.4 s** | 12,887 | 74 MB |
| 1,000 companies / 10,000 contacts | 3,334 high confidence, 6,666 preserved, 3,330 moved | **0.9 s** | 11,682 | 98 MB |
| 1,000 / 10,000, **before** the candidate-id cap | same decisions, but 1,000 ids stored on each preserved contact | 2.1 s | 4,710 | 335 MB |

The last row is the reason `MAX_CANDIDATE_IDS` exists: storing every candidate id on an unresolved
contact cost more than the decision itself (2.1 s → 0.9 s, 335 MB → 98 MB on the same corpus), and
would have produced records the API schema rejects (`candidateCompanyIds` is capped at 50).
Per-contact cost is linear in the family size (`O(family × contacts)` comparisons), which is why the
numbers above are the worst case rather than the average: the real data's families are mostly 2–5
members, so a 64 GB run's association cost is dominated by the merge, not by this stage.

### The common corpus: one company per name

`bun run index:bench-pass2 --rows 20000` (20,000 companies, 256 partitions, 1,792 shard files,
1,275,668 postings) is the shape Stage B has almost no work in — a single candidate per contact:

| Lane | pass 2 merge | companies/s | Objects | Postings | Shard appends | Peak buffer |
| --- | --- | --- | --- | --- | --- | --- |
| Before the association stage (documented in `docs/indexing.md`) | 2.1–2.5 s | 9,333 | 1,896 | 1,275,668 | 5,376 in 3 flushes | 8.39 MB |
| With Stage A + Stage B | **2.9 s** | 6,947 | 1,896 | 1,275,668 | 5,376 in 3 flushes | 8.39 MB |

So the change costs roughly 15–35% of pass 2 on a corpus with no ambiguity at all, and buys the
resolution and preservation behaviour described above. Object counts, postings, shard appends,
flush behaviour and peak buffered bytes are unchanged — the existing indexer optimisations (batched
shard writing, bounded memory, restart-safe reset, deterministic output) are untouched.

### Memory

The benchmark's RSS figure is the whole run, not the association stage alone. Nothing in Stage A or
B is proportional to the dataset: one resolver per partition (bounded by the partition's companies),
one candidate record per company in the family, and contacts decided one at a time. The one place a
large family could have grown was the stored candidate list, which the cap bounds.

## 8. Auditing the result

`bun run index:audit` is read-only, needs no credentials and reads only generated
objects. It reports both rule sets on the same data, which is the before/after
comparison:

- **legacy classes** (`confirmed` / `plausible` / `unresolved` / `conflict`) — the
  audit's original, name-join-centred definition, computed independently of the
  index's stored categories;
- **stored categories** (`high_confidence` / `plausible` / `conflicting` /
  `unclassified`) — what Stage B wrote;
- **`crossTab`** — legacy class → stored category, per contact, so a rule change
  shows up as a movement between cells rather than a nicer total.

It also reports: preserved contacts by category and reason; contacts moved between
same-name companies; reconciliation of `contactCount`, `associations` and facets
against the stored contacts; duplicate contact ids; and a bounded sample of the
most conflicted companies (company id + name only — no contact value is ever read
into the report). `unclassified` is reported separately and never folded into
`plausible`: a format-v2 contact has no category, and "no category" is not a
category.

---

## 9. Known limitations

- The index holds no source-level join key between the two files, so no association
  can be verified against the original employment relationship — only against the
  evidence the index retains. Domain evidence is the strongest of those; it is
  still evidence, not verification.
- A company with `n:` identity only (no domain, no LinkedIn) cannot be separated
  from a namesake, so its contacts stay `plausible` or `unresolved` by design.
- Two rows for one company whose names normalize differently and that share no
  identifier remain separate records (partitioning is by name).
- Reassignment uses email-domain evidence only. A tool that could infer corporate
  aliases from the website would move more contacts, and would need a reviewed
  alias table, not a heuristic.
- Real-data numbers for the new rules are pending: this environment has no access
  to the Windows spool or the 64 GB sources, so all measurements here are on
  synthetic fixtures with the real code paths.
- A run identity records each source's path, delimiter and the *number* of column
  overrides, not the override names. An edited `columns` mapping with the same
  number of entries cannot be detected from the checkpoint, so `pass2-from-spool`
  trusts the recorded identity as the provenance of the spool. Change the mapping
  only by rebuilding Pass 1.
