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
   claim is counted (`identifierConflicts`) and sampled (bounded, 32 entries),
   and the run reports the count. Replaying the same rows can never move a key.
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
  category and reason, the candidate company ids, and `claimedCompanyName` /
  `claimedNormalizedName` exactly as the source row carried them. `companyId` is
  `""` and its `p_…` id is derived from the contact's own fingerprint, never from
  a company (a company-scoped id would fabricate an employer).
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
re-read, no partition scheme changes, and `checkpoint.json` identity stays valid.
Pass 2 replays from partition 1 with the same run identity; nothing about
`v1-bench-1m` is renamed or rewritten.

### Windows PowerShell — verifying the change on the preserved benchmark

Do this on the machine that holds the completed `v1-bench-1m` spool. It builds an
**experimental** version next to the validated one; `v1-bench-1m` is never opened
for writing.

```powershell
cd C:\path\to\companyintel-pro
git pull
bun install
bun run check                       # typechecks + full test suite
bun run index:spool-doctor          # read-only: confirms the spool is clean

# Audit the EXISTING validated index first (this is the "before" number):
bun run index:audit -- --version v1-bench-1m
bun run index:audit -- --version v1-bench-1m --json > audit-before.json

# Rebuild pass 2 from the SAME spool under a new version:
bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json `
  --sample 1000000 --version v1-bench-1m-assoc

# Audit the experimental index (the "after" number, same evidence):
bun run index:audit -- --version v1-bench-1m-assoc
bun run index:audit -- --version v1-bench-1m-assoc --json > audit-after.json
```

What to expect on the screen: the run prints `pass 2: reusing the Pass 1 spool …
the sources are NOT read again`, then the new
`association  N high confidence, M plausible, K conflicting, U preserved without
an employer` and `association moves …` lines, and no R2 request for the sources
(`r2 requests 0 …` unless the raw cache is cold). Compare the two audit JSON
reports on the fields:

- `associations.stored.byCategory` — the categories actually written;
- `preserved.total` — contacts kept without an employer;
- `associations.stored.moved` — reassignments between same-name companies;
- `reconciliation.contactCount.mismatched`, `…associations.mismatched`,
  `…facets.mismatched`, `ids.duplicated` — must all be `0`;
- `manifestCounters.uniqueContacts` versus
  `reconciliation.attached + reconciliation.preserved` — must be equal.

`pass 1` output is not rebuilt, so its duration should be `0.0 s (skipped:
resumed)`; if it is not, the spool was rejected (see `docs/recovery.md`) and you
are re-ingesting — stop and read the message rather than accepting the cost.

### Keeping the two runs apart

- The experimental version has a **different `datasetVersion`**, so `companies/`,
  `contacts/`, `indexes/`, `unassigned/` and `manifests/` all live under their own
  prefix. Nothing can overwrite another version's objects.
- `manifests/active.json` is untouched: nothing is published, and the app keeps
  serving `v1-bench-1m` until you explicitly publish (which this task does not do).
- If you would rather not have both runs share one `workDir`, copy `workDir` and
  pass `--work-dir` — but the spool is only read, never written, during a resumed
  pass 2, so a copy is not required.
- Never pass `--upload` for the experimental version, and never `publish` it: the
  validated v2 index stays the baseline until you approve the upgrade.

---

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
