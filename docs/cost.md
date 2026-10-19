# Cost model and measured performance

Unit prices below are the documented Cloudflare list prices (checked October 2026). Treat the
monthly totals as **estimates**: they use the pricing and your stated usage (100 / 300 / 1,000
searches per day), plus storage estimates that you must replace with the real numbers from your
sample indexing run. No paid service is enabled by this document.

## Documented unit prices

| Item | Price | Source |
| --- | --- | --- |
| R2 Standard storage | $0.015 per GB-month (10 GB-month free) | <https://developers.cloudflare.com/r2/pricing/> |
| R2 Class A (writes, lists) | $4.50 per million requests (1M/month free) | same |
| R2 Class B (reads) | $0.36 per million requests (10M/month free) | same |
| R2 egress | free | same |
| Workers Free | 100,000 requests/day, 10 ms CPU per request | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Workers Paid | from $5/month, 10M requests/month included, $0.30/million after, CPU-time billing | same |
| Cloudflare Access (Zero Trust) | free tier covers up to 50 users | <https://www.cloudflare.com/plans/> |

## Storage estimate

| Object class | Estimate | Monthly |
| --- | --- | --- |
| `raw/` originals (given) | 60 GB | $0.90 |
| `indexes/` + `companies/` + `contacts/` | 9–20 GB for ~10M companies (measure it: `tools/indexer` prints output size) | $0.12–$0.30 |
| `app-data/` + `backups/` | < 0.1 GB | ≈ $0 |
| **Total** | | **≈ $1.00–$1.20** |

R2 free tier covers 10 GB-month of storage, so subtract up to $0.15 if you stay under it.

## Operation estimate

Per search the Worker reads a bounded set of small objects:

```
1 exact shard (1 per query variant)
+ up to 6 prefix shards
+ up to 10 token shards
+ up to 14 trigram shards
+ up to SEARCH_MAX_HYDRATE (default 16) company profile partitions
= measured 24–35 objects, ≈ 0.4–0.5 MB per cold fuzzy query
```

The hydration line is the one that used to dominate: it is now a ceiling rather than a
consequence of how many candidates retrieval produced (see docs/architecture.md for the
before/after measurements). Exact and short queries read fewer still — a query whose page
fills from confident hits stops before the fuzzy tail — and the four cache layers absorb
repeats, so realistic figures are far below these cold numbers.

The **adaptive hydration ladder** (16 → 32 → 64, see docs/architecture.md and
`docs/search-quality.md` §5) doubles the partition budget only while the page is still short
*and* the previous sweep was cut short by the partition cap, so it adds cost to one query
shape: a broad query whose page cannot fill from 16 partitions (measured on the real-data
sample: 421 KB at fixed 16 → 1.15 MB mean for the ladder, unchanged for exact/short queries;
90 rows instead of 70 across the sample's 8 query classes). The per-query ceiling is still 64
partitions, so even the worst case stays inside the operation and byte budgets below.

The ladder stops only on evidence about the whole candidate set (page full of confident hits,
candidate set exhausted, the source reporting the cap did not bite, or the 64-partition
ceiling) — never because one rung ranked nothing, which is not proof that deeper partitions
hold nothing. What makes that safe is **format v4**: search partitions are projections (21 KB
on the 20 K dev index) instead of full records (1.2 MB), so reaching the ceiling costs ~1.35 MB
of partitions rather than 78 MB.

Measured on the same 20,259-company dev index, before and after the split:

| query | v3 cold bytes / time | v4 cold bytes / time | v4 warm |
| --- | --- | --- | --- |
| `Microsoft` (exact) | 78.5 MB / 6.19 s | **8.0 MB / 5.08 s** | 0.10 s |
| `microsft` (fuzzy) | 78.4 MB / 5.86 s | **1.24 MB / 1.95 s** | 0.07 s |
| `qualtrics` (sparse) | 74.9 MB / 7.75 s | **1.51 MB / 2.30 s** | 0.10 s |
| `global technology` (broad) | 79.0 MB / 6.21 s | **1.33 MB / 1.98 s** | 0.09 s |

Warm repeats read ~156 bytes, because the working set now fits the isolate cache. The exact
query's remaining cold cost is round trips (64 small partitions + ~13 shards), not bytes. See
`docs/search-quality.md` §5.

**Measured reads per query, cold and warm** (real-data sample, real read path —
`bun run bench:real -- --version <version>`):

| query | cold R2 objects | cold bytes | warm R2 objects | warm bytes |
| --- | --- | --- | --- | --- |
| exact company name | 80 | 1.63 MB | 0 | 0 |
| alias ("Infosys Ltd") | 80 | 1.63 MB | 0 | 0 |
| abbreviation ("ibm") | 45 | 0.97 MB | 0 | 0 |
| typo | 75 | 1.60 MB | 0 | 0 |
| no result | 11 | 75 KB | 0 | 0 |

A repeat query on a warm isolate reads **nothing** from R2, because the immutable index
objects are now held in a bounded per-isolate cache (512 entries / 16 MiB, LRU, immutable
prefixes only — see `docs/search-quality.md` §7). That is the line that changes the Class B
arithmetic above for real traffic: the table assumes every search pays the cold cost.

| Usage | Searches/month | R2 Class B (at ~30 reads/search) | Class B cost (10M free) |
| --- | --- | --- | --- |
| 100 searches/day | 3,000 | 90,000 | $0 |
| 300 searches/day | 9,000 | 270,000 | $0 |
| 1,000 searches/day | 30,000 | 900,000 | $0 |

Even the worst case (35 read objects per search, 1,000 searches/day) is ~1.05 M Class B
operations/month — still inside the 10M free allowance. **Class A** operations are dominated by
the initial index upload (a few thousand PUTs, once per version) and occasional lead writes;
30,000 lead writes/month would still be under the 1M free allowance.

## Workers request and CPU estimate

1,000 searches/day is ~30,000 API requests/month, plus asset requests. That is ~0.03% of the
Free plan's 100,000 requests/day. Requests are not the constraint; **CPU time** per request is.

Measured on the sandbox this repository was developed in (`bun scripts/benchmark-search.mjs
--companies 50000 --repeat 5`, in-process engine, index build 1.25 s / 102 MB heap — rerun on
your own machine, preferably with `--companies 200000`):

| Query class | median | p95 | candidates scored |
| --- | --- | --- | --- |
| exact ("Microsoft Corporation") | 2.8 ms | 3.3 ms | 400 |
| legal-suffix variant ("Infosys Ltd") | 6.3 ms | 12.4 ms | 400 |
| abbreviation ("ibm") | 0.02 ms | 0.06 ms | 2 |
| short prefix ("tat") | 0.5 ms | 2.9 ms | 213 |
| single typo ("Microsft") | 0.02 ms | 0.05 ms | 2 |
| transposition ("Mircosoft") | 5.4 ms | 9.4 ms | 400 |
| multi-token ("international business machines") | 0.06 ms | 0.11 ms | 4 |
| word split ("Total Energies") | 5.9 ms | 10.1 ms | 400 |
| no result | 0.02 ms | 0.06 ms | 0 |

Repeat runs on this shared sandbox vary by roughly 2× (identical query, 2.5–5.4 ms median), so
treat these as an order of magnitude, not a specification. Two optimizations made after the
first measurement are already included: exact normalized matches return early without running
the token/whole-string fuzzy passes, and query trigrams plus per-document trigram sets are
cached instead of rebuilt per candidate.

Labelled relevance on the same corpus: **recall@1 0.939, recall@5 0.97, 0 false positives** on
the "must not match" queries (`tests/fixtures/companies.ts`).

Scoring cost scales with the candidate budget (`maxScored = 400`), **not** with corpus size, so
these figures hold at 10M companies — that is the whole point of the bounded two-stage design.

Interpretation:

- The **median** query is comfortably inside the Free plan's 10 ms CPU budget.
- The **worst-case fuzzy** query (word-split / heavy typo) measured ~10 ms p95, which can exceed
  10 ms CPU on the Free plan. Two honest options: keep the Free plan and accept occasional
  `1102 Worker exceeded CPU time` errors on the heaviest fuzzy queries, or move to Workers Paid
  ($5/month) which removes the 10 ms ceiling. **This is an approval decision — no paid plan has
  been activated, and none is required to finish development.**
- Re-measure in production with `wrangler tail` (CPU time per request) before deciding; the
  sandbox timings are a proxy, not a production measurement.

### If the Paid plan turns out to be the practical choice

Workers Paid is **$5/month and includes 10 M requests plus 30 M CPU-milliseconds**, with overage
at $0.30 per additional million requests and $0.02 per additional million CPU-ms
([Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
Against this workload that is not the binding number:

| Scenario | Requests/month | CPU-ms/month at ~20 ms/query | Paid cost |
| --- | --- | --- | --- |
| 100 searches/day | 0.003 M | 0.06 M (0.2% of allowance) | **$5.00** |
| 1,000 searches/day | 0.03 M | 0.6 M (2% of allowance) | **$5.00** |
| 30,000 searches/day | 0.9 M | 18 M (60% of allowance) | **$5.00** |

So the realistic paid cost is the $5 minimum itself — CPU overage would only start somewhere
around 45,000–50,000 searches/day at the measured ~20 ms, and even then at $0.02 per million
CPU-ms. The reason to choose Paid is the **10 ms per-invocation ceiling**, not the bill: the
Free plan fails hard (`1102`) when a request exceeds it, and the measured cold-query cost after
the hydration bound (~20 ms in Bun on a sandbox vCPU, ~0.45 MB read, ~20 candidates scored) is
close enough to that line that only a `wrangler tail` measurement on real hardware can settle
it. Drop `SEARCH_MAX_HYDRATE` to 8 if a deployment measures too high.

## Intermediate (Pass 1) spool storage

The revised indexer keeps the intermediate spool **local**, and **no intermediate object is
uploaded to R2**. That is a deliberate decision, not an oversight:

- the compact format makes the complete spool **23.02 GB expected / 33.71 GB upper** for 64.26 GB
  of source, which fits the ~87 GB the failed machine had free;
- Pass 2 reads the spool once, sequentially, immediately after Pass 1; mirroring it would upload
  and then re-download the same bytes, roughly doubling the wall-clock time for no benefit;
- local disk is already bounded by the preflight (which refuses an unsafe volume) and by
  `spoolMaxBytes` / `--spool-max-gb` (Pass 1 stops cleanly at the ceiling with a resumable
  ledger), so a cloud tier is not needed to make the run fit.

There is therefore **no `--spool-upload` flag and no R2 staging prefix in this build**. If a later
version needs one (a machine with less free space than the spool), the arithmetic at R2 Standard
prices would be:

| Item | Size / count | Cost |
| --- | --- | --- |
| intermediate objects stored | 23.0 GB expected (33.7 GB upper) | **$0.35/month** (~$0.50 at the upper bound) |
| Class A writes, one object per sealed partition | 256 PUTs | **<$0.01** |
| Class A writes, if every 1 MiB frame were its own object | ~22,000 PUTs | **~$0.10** |
| Class B reads to stream the spool back for Pass 2 | 256 GETs (one per partition) | **<$0.01** |

Egress from R2 is free; the upload from the laptop consumes your own upstream bandwidth. At 256
objects neither the Class A nor the Class B count is material against the 1 M / 10 M free
allowances — the transfer time is what would dominate. These are **projections for a design that
is not implemented**, not billable measurements.

A repeated full build adds another ~23 GB of intermediate storage **only if you keep it**; the
local ledger is deleted with the work directory in a step you perform explicitly. Final index
versions remain ~20 GB each ($0.30/month) and are independent of this.

Checkpointing has no R2 cost at all: the ledger is a small local JSON file written with
`fsync` + rename every 100,000 rows (about 1,000 writes over a full run).

## Total monthly estimate

| Scenario | Storage | Operations | Workers | Total |
| --- | --- | --- | --- | --- |
| Free Workers, 100–1,000 searches/day | ≈ $1.00–1.20 | $0 | $0 | **≈ $1–1.20** |
| Paid Workers (if the fuzzy CPU ceiling is hit) | ≈ $1.00–1.20 | $0 | $5.00 | **≈ $6.00–6.20** |

Backups and staging objects are small; deleting superseded versions (keeping one previous for
rollback) keeps storage flat.

## How to replace these estimates with measurements

1. Run the samples, then the full indexer; it prints input size, output size and object count.
2. `bun scripts/benchmark-search.mjs --companies 200000` on your Windows machine.
3. After deployment: `bunx wrangler tail` for CPU time and errors; Cloudflare dashboard → R2 for
   Class A/B operation counts; Workers analytics for request counts.
4. Update this table with your numbers. Nothing here should be presented as a measurement until
   it comes from steps 2–3.
