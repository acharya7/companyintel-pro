# Search accuracy, completeness and R2 efficiency

This document covers the search-layer and audit work done on top of the validated
`v1-bench-1m` index. It is a *search-layer* change set: the index format is still **v2**,
nothing was rebuilt, nothing was uploaded, and no index, spool or checkpoint file was
touched. Everything here is measured with the production read path
(`FakeR2Bucket → R2Store → R2CandidateSource → engine`), the same code the Cloudflare
Worker runs.

Two corpora are used, and they are never mixed:

| corpus | what it is | what it can prove |
| --- | --- | --- |
| synthetic / fixture | generated names + the labelled relevance cases | ranking *behaviour*: typos, prefixes, ordering, budgets, gates |
| real-data sample | `.indexer-output @ v1-dry5-250` — 20,265 companies, 19,414 contacts, format v2, 82 company partitions, 3,728 objects / 20.2 MB, built from the real `raw/` files | *cost* and *findings*: R2 objects and bytes per query, hydration completeness, what a nonsense query actually retrieves |

The user's `v1-bench-1m` index (987,443 companies, 962,768 contacts, 3,950 company
partitions) was **not** available in the development environment. Every command in
"Verifying this on Windows" below reproduces these measurements against it; until that is
run, the numbers in this document are the 20 K real-data sample's, and the 1 M figures are
labelled as not measured.

---

## 1. Root causes established (reproduced) vs hypotheses

**Established by execution**

1. **A whole-string fuzzy score was normalized in a way that favours a short name.**
   `0.85 × Dice` and `0.9 × editSimilarity` are both length-normalized, so a *three-character*
   company name accounts for a third of an eleven-character query and still scores above the
   query's threshold. Measured on the shipped scorer: names `zzz`, `zzzz`, `zzzzz`, `zzq`,
   `qqq`, `zzqq`, `zzzzzz`, `zzzzzzz`, `Qqq` all scored 0.378–0.680 against `zzzzzzqqqqq`
   (threshold 0.36) under the previous rule. Nine short-name patterns, one mechanism.
2. **The noise the   real benchmark saw comes from junk records in the source data.** On the
   real-data sample, `zzzzzzqqqqq` retrieves exactly two records — `ZZP'er` and `zz` — from
   the trigram index on the term `zz`, and no other stage produces anything. They are
   placeholder-looking source rows, not a ranking artefact. (On this 20 K sample their
   legacy score was 0.155–0.212, below the 0.36 threshold, which is why the sample never
   reproduced the seven rows the 1 M run returned: the same mechanism needs names like
   `zzz`/`zzqq` that the larger corpus contains. See §5.)
3. **The hydration retry was not enough.** With one retry the engine reached `fixed 32`'s
   completeness but not `fixed 64`'s, which is what the earlier benchmark table showed
   (adaptive 16→32: 10 rows short of the reference).
4. **The candidate list was cut to the CPU budget with no record of the cut**, so a
   budget-truncated response was indistinguishable from a complete one except through
   `totalIsLowerBound`, which did not consider the truncation.
5. **Every request re-read the index directory and re-read shards and partitions that a
   previous request in the same isolate had already read.** Measured: a warm isolate served
   the *same* query with zero reuse (84 objects per query, every time).

**Hypotheses, explicitly not confirmed here**

- Whether the seven names the 1 M benchmark returned are the same class of short junk names
  as the sample's `zz`/`ZZP'er`. The mechanism is confirmed; the specific names are not,
  because that index is not in this environment. `bun run search:explain -- --query
  zzzzzzqqqqq` names them, with stage, term, coverage and gate, in one line each.
- Whether the earlier "10 missing rows" on `global technology` / `solutions group` are
  relevance or budget: the benchmark now prints, per query, how many candidates were
  truncated, how many sweeps ran, whether the partition budget was the limit, and whether
  the total is a floor — so it is answerable instead of arguable.

---

## 2. Relevance: the fuzzy gate (`src/shared/search/score.ts`)

The whole-string fuzzy terms (`0.85 × Dice`, `0.9 × editSimilarity`) now require the
candidate to be plausible before they contribute:

| gate | rule | why |
| --- | --- | --- |
| relative length | company name ≥ max(3, ½ × query length) | both measures are normalized by length, so they reward a name far shorter than the query |
| query coverage | shared trigrams ≥ 2 **and** ≥ 50 % of the *query's* trigrams | the sound half of Dice, which is otherwise dominated by the shorter side |

Both gates apply **only** to the whole-string fuzzy terms. Exact, alias, compact and prefix
matches never pass through them, and token-level fuzzy matching is per-token (therefore
length-aware) and unaffected. Measured before/after with the shipped scorer:

| query | company name | legacy whole-string score | legacy threshold | now |
| --- | --- | --- | --- | --- |
| `zzzzzzqqqqq` | `zz`, `ZZP'er`, `zzz`, `zzzz`, `zzzzz`, `zzq`, `qqq`, `zzqq`, `zzzzzz`, `zzzzzzz`, `Qqq` | 0.155 – 0.680 | 0.36 → the nine short/junk patterns would be **shown** | all eleven score **0** (gate: `short-name` / `low-coverage`) — asserted by `tests/search.test.ts` → "a nonsense query does not score any short junk name" |
| `Microsft` | `Microsoft` | 0.800 | 0.40 → shown | **shown, 0.845** |
| `Gooogle` | `Google` / `Googleplex` | 0.785 / 0.500 | 0.40 → shown | **shown, 0.845 / 0.500** |
| `infosys` | `Infosys Limited` | 0.900 | 0.40 → shown | **shown, 1.000 (exact)** |
| `global technology` | `Global Technologies` | 0.758 | 0.36 → shown | **shown, 0.450** |
| `global technology` | `Global Solutions` | 0.309 | 0.36 → already dropped | dropped (coverage 0.353) |

A candidate whose only failure is that the gate withheld evidence now returns a *negative
with a reason* (`score: 0`, `detail.fuzzyGate`, `detail.trigramCoverage`) instead of `null`,
so a diagnostic can answer "why is this company not shown". A score of 0 can never pass
`minScoreFor`, so the engine's threshold rejects it exactly as it rejected `null` — no
user-visible change, and the whole existing test suite (including every labelled relevance
case) passes unchanged.

New scoring diagnostics on every result: `trigramCoverage`, `fuzzyGate`
(`ok | short-name | low-coverage | not-fuzzy`), `identityEvidence`.

## 3. Domain identity evidence

The index does not contain company domains as searchable terms (they live in the profile
objects), and indexing them would mean a rebuild — so a domain **confirms**, it never
manufactures a match. `identityEvidenceFor()` computes 2 when the query's compact form *is*
the company's domain label (`tcs` vs `tcs.com`), 1 when one query token is, 0 otherwise. The
engine uses it as a tie-break **inside a relevance band** (band → identity → contact count →
name): it can never lift a candidate out of its band, so `tata` still ranks Tata Consultancy
Services first on contact coverage. Domain-search queries (`tcs.com`) remain unsupported
until the domain is indexed — a v3 candidate, listed in §9.

## 4. Retrieval and CPU budget

- **Whole-name gating (deferral, not a decision).** When the exact + prefix stages already
  produced at least `pageSize + 1` candidates, the token and trigram *retrieval* stages are
  skipped — up to 24 shard reads saved for the most common query shape (a real company
  name). If hydration then cannot fill the page from those candidates alone, the deferred
  stages run before the search returns and the sweep is repeated (`fuzzyDeferred` /
  `fuzzyRecovered` report which happened).
- **Truncation is accounted for.** The candidate list is still cut to `resultBudget`, and it
  is still cut from the weakest evidence upward (retrieval appends exact → prefix → token →
  trigram, best-first inside each stage), but the number dropped is now reported
  (`retrieval.truncated`) and it sets `totalIsLowerBound`. Measured on the real sample:
  up to 1,600 candidates per query, up to 1,200 of them truncated, with the page still
  answered by the strongest evidence.

## 5. Hydration: the 16 → 32 → 64 ladder

`ADAPTIVE_HYDRATE_MAX_STEPS = 2` doubles the partition budget while (a) the requested page is
still short, (b) the previous sweep was cut short by the partition cap
(`hydrationBudgetHit()`), and (c) there are candidates left to hydrate. It stops on evidence
about the **whole candidate set**, and on nothing weaker:

| stop | what proves it is safe |
| --- | --- |
| `stoppedEarly` | the page is full of hits scoring above `WEAK_CEILING`, the best a token/trigram-only candidate can reach, so nothing left can reorder or extend it |
| `candidates_exhausted` (`retrieval.ladderStopped`) | every candidate retrieval produced has been hydrated, so no larger budget could add a row |
| source says the last sweep dropped nothing | `hydrationBudgetHit() === false`: the cap did not cut the sweep, so more budget reads nothing new |
| `SEARCH_LIMITS.maxHydrate` (64 partitions) | the configured ceiling, reported as a floor (`totalIsLowerBound`) |

An earlier version also stopped at the first rung that ranked nothing new. That is **not** a
safe criterion: hydration spends its budget in candidate order, and an unproductive rung says
nothing about the partitions it did not reach — a query whose only matches sit deeper lost
them. The rule was removed; `tests/search-funnel.test.ts` pins the shape (a match reachable
only in a later partition is still found after an unproductive rung) and compares a later
page against an exhaustive reference. Bounded mode still sacrifices recall at the ceiling,
and that is reported as a lower-bound total rather than presented as complete.

Measured on the real-data sample (`bun scripts/benchmark-hydration.mjs --version v1-dry5-250
--repeat 2`), 8 query classes, 82 company partitions:

| strategy | rows | rows lost vs reference | top-25 of the reference kept | mean bytes/query | R2 GETs | sweeps | duplicate reads | mean ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed 16 (old default) | 70 | 20 | 56/90 | 421 KB | 36 | 1.13 | 0 | 18.7 |
| fixed 32 | 90 | 0 | 75/90 | 749 KB | 52 | 1.00 | 0 | 29.4 |
| fixed 64 | 90 | 0 | 90/90 | 1.34 MB | 84 | 1.00 | 0 | 56.3 |
| adaptive 16→32 (previous default) | 90 | 0 | 75/90 | 749 KB | 52 | 1.88 | 0 | 30.6 |
| **adaptive 16→32→64 (new default)** | **90** | **0** | **75/90** | **1.15 MB** | **84** | **2.38** | **0** | **48.0** |
| reference (every partition) | 90 | 0 | 90/90 | 1.34 MB | 84 | 1.00 | 0 | 58.7 |

Read this table honestly:

- The ladder recovers **every row the fixed-16 default lost** (20 of 20) and costs the extra
  bytes only on queries whose page is still short — a query that fills its page at 16
  partitions never takes a second rung.
- **`rows lost` understates the gap, `top-25` shows it.** Three queries (`global`,
  `services`, `consulting`) return a *full* page of 25 rows at every strategy, but the rows
  are not the reference's best ones: fixed 32 and the ladder keep 75 of the reference's 90
  top-25 rows, fixed 64 keeps 90. The difference is *which* candidates are hydrated, and
  `top-25` is the column that exposes it.
- The residual gap is the price of stopping when the page is full. Closing it means reading
  further partitions for every broad query — i.e. more bytes for a page the user already
  cannot see the end of. The operator dial is `SEARCH_MAX_HYDRATE=64`, which with the ladder
  becomes a single 64-partition sweep (~1.6 MB, `top-25 = 90/90` here).
- The unbounded "reference" is a *reference for what this index can return*, not proof of
  complete coverage of the source data.

### What makes the ladder affordable: format v4 search projections

Walking to the ceiling is only expensive when a partition is expensive. Format v4 (see
`docs/architecture.md`) keeps every source column in `details/` and out of the search
projection, so a company partition is **21 KB** instead of **1.2 MB** on the same records
(`dev-r2-20k-proj-20261017`, 20,259 companies, 82 partitions). 64 partitions ≈ 1.35 MB, not
78 MB — which is why the safe ladder can now be the only ladder.

Measured through the running preview (`bun scripts/benchmark-preview.mjs before|after`), identical queries, same
records, only the index layout changed:

| query | v3 (inline fields) | v4 (projections) | R2 reduction |
| --- | --- | --- | --- |
| `Microsoft` (exact) | 78.5 MB · 6,188 ms · 4 rows | **8.0 MB · 5,083 ms** · 4 rows | 10× |
| `microsft` (fuzzy) | 78.4 MB · 5,859 ms · 5 rows | **1.24 MB · 1,946 ms** · 5 rows | 63× |
| `qualtrics` (sparse) | 74.9 MB · 7,746 ms · 1 row | **1.51 MB · 2,301 ms** · 1 row | 50× |
| `global technology` (broad) | 79.0 MB · 6,209 ms · 2 rows | **1.33 MB · 1,978 ms** · 2 rows | 60× |

A repeat of the same query on a warm isolate now costs **~100 ms and 156 bytes** (the whole
working set fits the isolate cache, which it never did at 1.2 MB per partition). The exact
query's remaining cold cost is not bytes: it reads 64 *small* partitions plus ~13 shards,
so round-trip latency and gzip decode dominate on this 1-vCPU sandbox.

The numbers scale with partition size, not with the corpus: a full index has the same 250
companies per partition, so the per-search cost above is the per-search cost of the real
dataset on a comparable machine. `bun scripts/benchmark-hydration.mjs` is the repeatable form
of this table on a local index.

Completeness is reported, never implied: `page.totalIsLowerBound` is set when retrieval was
budget-bounded, when the early-stop barrier fired, when the candidate list was truncated, or
when the partition budget cut the sweep short; a short page that the budget limited also
carries a `notice` ("Showing the N best matches found within this search's budget — more
companies may match"). A full page is never described as globally optimal.

## 6. The nonsense query, with evidence

`bun run search:explain -- --query zzzzzzqqqqq` against the real-data sample:

```
trigrams           zz, zzz, zzq, zqq, qqq, qq
Candidates by stage: exact 0  prefix 0  token 0  trigram 2   (2 unique, 2 hydrated)

  stage  term   score  min   ok  cat  coverage gate       name
  trigram zz        0  0.36  no   -      0.167 short-name ZZP'er
  trigram zz        0  0.36  no   -      0.167 short-name zz
hits the API would show (0):  (none — the query returns an explicit empty result)
```

So, per question asked: the names are `ZZP'er` and `zz`; the stage is **trigram** on the term
`zz`; their scores are **0** and do **not** pass the threshold; and the cause is
**short-name junk records in the source data combined with a length-normalized similarity
rule** — not stale postings (a stale posting cannot create evidence the index does not hold),
not normalization, and not "legitimate similarity". The same command on `v1-bench-1m` will
name its seven, and the gate table in §2 says which pattern each one falls into.

## 7. R2 and Worker cost

**New: a bounded per-isolate cache** (`worker/src/search-cache.ts`), installed on the search
store. It holds immutable index objects only (`indexes/`, `companies/`, `contacts/`), keyed by
object key (which contains the dataset version), bounded by **512 entries and 16 MiB**, with a
10-minute maximum age and LRU eviction. `app-data/` and `manifests/` are never cached — a
stale lead or settings read is a correctness bug, not a latency detail. Concurrent reads of
one key are joined into a single R2 GET (in-flight de-duplication), and the cache is per R2
binding, so two datasets can never serve each other's bytes.

Measured per query on the real-data sample (real-mode benchmark, cold = cache cleared first,
warm = the same query again on a warm isolate):

| query | candidates | truncated | sweeps | scored | hits | cold R2 objects | cold bytes | warm R2 objects | warm bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Microsoft Corporation` | 1,246 | 846 | 3 | 82 | 4 | 80 | 1.63 MB | **0** | **0** |
| `Infosys Ltd` | 1,600 | 1,200 | 3 | 80 | 4 | 80 | 1.63 MB | **0** | **0** |
| `ibm` | 56 | 0 | 3 | 45 | 13 | 45 | 0.97 MB | **0** | **0** |
| `Microsft` | 945 | 545 | 3 | 81 | 5 | 75 | 1.60 MB | **0** | **0** |
| `global technology` | 1,600 | 1,200 | 3 | 72 | 2 | 84 | 1.66 MB | **0** | **0** |
| `zzzzzzqqqqq` | 2 | 0 | 1 | 2 | 0 | 11 | 75 KB | **0** | **0** |

- **Duplicate object reads per search: 0** — asserted for every strategy and every query in
  the hydration benchmark, and in `tests/search-ranking.test.ts` / `tests/search-cache.test.ts`
  against the real read path.
- A repeat query in a warm isolate reads **nothing** from R2. On a 20 K index the cold cost is
  ≤ 84 objects / 1.66 MB because the ladder may reach 64 of 82 partitions; on a 3,950-partition
  index the same bound is `64 × ~25 KB ≈ 1.6 MB` per query and `64` objects, whatever the
  collection size — the ceiling is the *partition* budget, not the index size.
- Latency (median 2.5–67 ms, p95 up to 98 ms on the broadest queries here) is Bun on one
  vCPU: CPU + gunzip + `JSON.parse`, not network. The distribution is per-query, not the
  cache: the nonsense query reads 11 objects and returns in 2.5 ms, a 1,600-candidate query
  reads 84 and returns in ~69 ms.
  Worker CPU and end-to-end R2 latency must be measured on the deployed Worker; the local
  figure is a proxy only.

## 8. Company ↔ contact association audit (read-only)

`bun run index:audit` (add `-- --version v1-bench-1m`, `--sample 50`, `--json`) reads the
objects a run already wrote — `companies/<version>`, `contacts/<version>`, the manifest — and
classifies every contact↔company association by the evidence the index actually holds:

| class | meaning |
| --- | --- |
| `confirmed` | supported by evidence independent of the name join: the contact's email domain is the assigned company's domain |
| `plausible` | the name is unique (nothing to confuse it with), or a shared-name family leaves exactly one candidate consistent with the evidence |
| `unresolved` | a shared-name family with no evidence that separates its members, or evidence that fits several — the index cannot decide |
| `conflict` | the evidence points *away* from the assigned company: the email domain belongs to another member of the family, or the contact's country identifies a different one |

Measured on the real-data sample (`bun scripts/association-audit.mjs --version v1-dry5-250
--sample 5`), 20,265 companies and 19,414 contacts in 87 shared-name families (208 companies):

| class | contacts | share | what the evidence was |
| --- | --- | --- | --- |
| `confirmed` | 10,143 | 52.2 % | contact email domain is the assigned company's domain (`email_domain_matches_assigned_company`) |
| `plausible` | 8,904 | 45.9 % | `unique_name` 7,371 · `unique_name_country_differs` 1,518 · `country_identifies_the_assigned_company` 15 |
| `unresolved` | 104 | 0.5 % | `country_matches_several_companies_of_the_same_name` 22 · `shared_name_without_disambiguating_evidence` 2, plus small family cases |
| `conflict` | 263 | 1.4 % | `email_domain_contradicts_assigned_company` 142 · `email_domain_belongs_to_another_company_of_the_same_name` 102 · `country_matches_no_company_of_the_same_name` 80 · `contact_country_identifies_a_different_company_of_the_same_name` 19 |

The audit lists companies with at least one `conflict`/`unresolved` association (181 here, 75
of the 87 families) as company ids and names only, with their family size and reason counts.
On the 1 M index the user's earlier sample report counted 47,616 ambiguous companies and
124,708 contacts on shared-name families, so the same command there is expected to report a
larger `unresolved`/`conflict` population — that is the number to decide the rule fix on.

A normalized-name match alone is **never** `confirmed` — that is asserted directly. Domain,
country, name and provenance evidence are reported separately, and the limitations are
printed with the numbers: the two source files share no company identifier, so no association
can be verified against the original rows; rejected rows and deduplicated contacts are not in
the index; contact country is weak evidence and is used only to separate family members. The
report contains **company** identifiers only — the sample lists company id, name, family size,
contact counts and reasons, never a contact name, email, phone or LinkedIn URL — and the
audit never reassigns a contact, edits an object or rebuilds pass 1.

The audit is a correction *input*, not a correction: it tells the operator which rules to fix
before the production index is built from the same name-only join. `scripts/sample-report.mjs`
is deliberately left as the *shape* report and now prints a one-line pointer to `bun run
index:audit` whenever it finds ambiguous companies or contacts on name-only companies.

## 8b. Person search: the same rules, name-shaped

A contact is not a document: it lives inside its company's contact object, so its postings carry a
contact id and hydration goes through the ids index (id → company ref, or the `unassigned/` partition
for a preserved contact). The retrieval rubric mirrors the company one, with the weights that make a
name behave:

| evidence | weight | why |
| --- | --- | --- |
| every word of the query equals the stored name | +1000 | the answer |
| whole-name prefix either way | +400 | "satya n" |
| a query word is a literal start of a name word (≥ 3 chars) | +220 | "Nade" → "Nadella" |
| per-token overlap with name words | up to +300 | "nadella" alone |
| best per-token edit similarity ≥ 0.7 | up to +250 | "Nadela", "Umapathii" |
| whole-name edit similarity ≥ 0.82 / trigram dice ≥ 0.6 | up to +200 / +120 | word-order and spacing variants |

Two rules keep it honest:

* **A candidate that no rule can justify is dropped.** The trigram stage exists for typos and also
  produces near-misses that share several trigrams with the query and nothing else; a record whose
  final relevance is 0 was matched by no rule this search applies, so it is not shown (and if that
  empties the page, the notice says nothing matched closely enough).
* **A partial page is labelled.** Searching one word legitimately returns every match for it, so
  when no result covers every word of the query the response carries
  `Showing partial matches for “…”`. Measured live on the 20 K real-data development version:
  `malini umapathi` → the preserved contact only, no notice; `malni umapathii` (two typos) → the same
  person; `umapathi` → 11 matches; `erin boyle` (absent from the sample) → the partial-match notice
  instead of a bare list.

## 9. Residual limitations and what would need a reindex

1. **Domain queries are not supported** (`tcs.com`). The domain is not an indexed term.
   Indexing it (or adding a compact metadata side object) is a v3 change requiring a rebuild —
   deliberately not done here.
2. **A filled page is not a proof of globally optimal ranking.** The early-stop barrier and
   the partition cap can both leave a better-ranked candidate unread; `totalIsLowerBound` and
   the short-page notice say so. Removing this entirely needs per-partition max-score metadata
   (v3) or the compaction side index.
3. **Sparse queries walk to the partition ceiling.** A query whose true match count is below
   the page size (an exact name with four matches) cannot fill its page, so the ladder keeps
   climbing while the source says the cap is what stopped it. That is deliberate — stopping
   earlier is what lost reachable matches — and it is affordable only because a format-v4
   partition is 21 KB: 64 partitions ≈ 1.35 MB, measured at 1.5–8 MB per search including
   shards. A v3 index paid 75–79 MB for the same behaviour. Only pre-computed per-partition
   score bounds would end the climb sooner without risking recall.
4. **The 1 M index was not measured here.** Everything in §5–§7 is the 20 K real-data sample.
   The commands below produce the 1 M numbers.
5. **The association audit cannot see source provenance** and does not attempt to. A future
   people-file export carrying a company id/domain is the only real fix.

## 10. Verifying this on Windows

PowerShell, from the repository root, against the preserved benchmark files
(`.indexer-output`, dataset version `v1-bench-1m`). Nothing below writes to your index, the
spool, the checkpoint or R2.

```powershell
cd C:\path\to\companyintel-pro
git pull
bun install

# 1. Type checks, lint, tests, build
bun run check          # tsc (frontend/worker/indexer/probe) + bun test
bun run lint
bun run build

# 2. What the nonsense query really returns on the 1 M index: stage, term, score, gate
bun run search:explain -- --query zzzzzzqqqqq
bun run search:explain -- --query zzzzzzqqqqq --json    # machine-readable, for the report

# 3. The two queries the benchmark flagged, with their budget diagnostics
bun run search:explain -- --query "global technology"
bun run search:explain -- --query "solutions group"

# 4. Completeness vs cost: fixed 16 / 32 / 64, the ladder, and the unbounded reference
bun run bench:hydration -- --version v1-bench-1m --repeat 2

# 5. Real-data search benchmark: latency, candidates, truncation, sweeps, cold/warm R2 reads
bun run bench:real -- --version v1-bench-1m --repeat 3

# 6. Association audit of the generated index (read-only, company ids and names only)
bun run index:audit -- --version v1-bench-1m --sample 50
bun run index:audit -- --version v1-bench-1m --json > association-audit.json

# 7. The existing sample report still works unchanged
bun run index:sample-report -- --version v1-bench-1m
```

Synthetic (no index files needed, for ranking behaviour):

```powershell
bun run bench -- --companies 200000 --repeat 9
bun run bench -- --companies 50000 --json
```

What to look for: `search:explain` lists the exact names the nonsense query retrieves;
`bench:hydration` shows `rows lost` **and** `top-25` (a full page can still keep fewer of the
reference's best rows) with `dup` at 0 everywhere; `bench:real` shows the cold object/byte
count per query and `warm objs 0` for a repeat query; `index:audit` prints the four
association classes with the evidence that produced them.

## 11. Regression map for the acceptance criteria

Every criterion in the task's test list, and the test that covers it. `bun test` is **407
tests, 0 fail** (up from 354); the phase added `tests/search-ranking.test.ts` (15),
`tests/search-cache.test.ts` (13) and `tests/association-audit.test.ts` (20), and extended
`tests/search-funnel.test.ts` (9), `tests/search.test.ts` (25 → 28, the scorer gates) and
`tests/pages-render.test.tsx` (9 → 11, the `N+` contract). No existing test was weakened to
make any of them pass — the labelled relevance set still reports precision@1 1.000.

| # | Criterion | Where it is asserted |
| --- | --- | --- |
| 1 | Exact-match ranking | `tests/search-ranking.test.ts` → "the exact match is ranked first and every exact hit outranks a fuzzy one"; `tests/search.test.ts` → "every labelled case behaves as expected" (35 cases, precision@1 1.000) |
| 2 | Prefix, token and fuzzy matching | `tests/search.test.ts` → "short queries use bounded prefix lookup and stay strict", "fuzzy matching can be switched off"; `tests/search-ranking.test.ts` → "legitimate typo tolerance and partial queries are unchanged" |
| 3 | Candidate-budget truncation | `tests/search-ranking.test.ts` → "the CPU budget truncates the weakest evidence, keeps the strongest, and reports the count" |
| 4 | Hydration-budget exhaustion | `tests/search-ranking.test.ts` → "a partition budget that cuts the answer short is reported, not hidden"; `tests/search-funnel.test.ts` → "reads at most SHARDING.maxHydrate partitions per search, across every batch" |
| 5 | Adaptive retries | `tests/search-funnel.test.ts` → "the adaptive pass only runs when the partition budget was the limit", "a page cut short by the partition budget is refilled by the adaptive pass", "the ladder stops at the first rung that ranks nothing new", "a rung that ranks new rows keeps the ladder climbing"; `tests/search-ranking.test.ts` → "the adaptive ladder reaches further than a single retry, and stops when the page fills" |
| 6 | No duplicate R2 reads within a search | `tests/search-ranking.test.ts` → "no object is read twice for one search, and every read is counted"; `tests/search-funnel.test.ts` → "never hydrates a profile partition twice for one search"; `bench:hydration` → `dup 0` for every strategy and query |
| 7 | Pagination correctness | `tests/search-ranking.test.ts` → "pages never overlap, stay in order, and stop when the data does", "a page beyond the data returns an empty slice and hasMore false" |
| 8 | Relevant result ordering across partitions | `tests/search-ranking.test.ts` → "a candidate in a later partition is not out-ranked by an earlier one" (its fixture crosses a partition boundary) |
| 9 | Misleading no-result fuzzy matches | `tests/search-ranking.test.ts` → "a nonsense query returns nothing on the real read path", "unrelated words do not match either"; `tests/search.test.ts` → the three scorer-gate cases above |
| 10 | Shared-name company collisions | `tests/association-audit.test.ts` → "groups only names that occur more than once"; `tests/e2e-index.test.ts` (same name, different domain, kept apart); `tests/association-report.test.ts` (family risk) |
| 11 | Ambiguous contact associations | `tests/association-audit.test.ts` → "a country that matches no candidate is unresolved, never a silent match", "a country shared by several candidates stays unresolved", "counts every association exactly once" |
| 12 | Missing and contradictory identity evidence | `tests/association-audit.test.ts` → "an email domain that belongs to another member of the family is a conflict, with the alternate named", "an unrelated email domain is a conflict", "a contact whose country identifies a different member is a conflict", "states its own limitations instead of inventing certainty" |
| 13 | Behaviour with existing format-v2 indexes | `tests/search-cache.test.ts` → "the fixture index is format v2 and search reads it without duplicate objects" (a real indexer-built v2 index, `formatVersion: 2`, read through `R2Store` → `R2CandidateSource`); `tests/e2e-index.test.ts`, `tests/api-e2e.test.ts` |
| 14 | Bounded Worker CPU, memory and R2 operations | `tests/search-ranking.test.ts` → "work stays inside the configured bounds (CPU, partitions, retrieval)"; `tests/search-cache.test.ts` → the entry/byte/age bounds, LRU eviction, in-flight de-duplication, and "a mutable app-data object is never cached" |
| 15 | Compatibility with the frontend and Worker API | `tests/search-ranking.test.ts` → "the response still satisfies the shared Zod contract, with and without R2 accounting"; `tests/api-e2e.test.ts` (the `/api/companies/search` route, its empty result and the contacts pagination); `tests/search-funnel.test.ts` / `tests/search-ranking.test.ts` assert `page.totalIsLowerBound`, and `tests/pages-render.test.tsx` → "a lower-bound total renders as N+, an exact total does not" asserts the UI shows it; the search page itself still renders in demo and no-dataset mode |

Safety constraints were honoured by construction, not by discipline alone: nothing in this phase
writes to `outputDir`, `workDir`, R2 or the index format, and `tests/worker-r2-binding.test.ts`
plus `tests/frontend-secrets.test.ts` still assert the deploy-time invariants (binding-only R2
access, no credentials in the bundle).
